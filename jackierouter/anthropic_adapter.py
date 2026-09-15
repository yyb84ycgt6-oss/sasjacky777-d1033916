"""Native Anthropic Messages API adapter.

The OpenAI-compatible adapter can reach Anthropic's compatibility endpoint, but
the native API is a different shape — ``system`` is a top-level field rather
than a message, auth is ``x-api-key`` rather than a bearer token, and the
response is a list of content blocks. Routing to Claude through a compatibility
shim also hides features the native endpoint reports, notably the refusal stop
reason.

Written against raw HTTP rather than the ``anthropic`` SDK on purpose: this
library's whole premise is that the core installs with no dependency tree, and
an adapter layer that pulled in one vendor's SDK would break that for everyone
routing to Ollama. If you want the SDK's retries, streaming helpers, and typed
errors in your own application code, use the SDK there — this is the routing
layer, not the application.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from .errors import ProviderError, RateLimited
from .types import AdapterResult, Message, RouteRequest, StreamEvent

ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_BASE_URL = "https://api.anthropic.com/v1"

# Published $/1M rates, expressed as the $/1K this library costs in.
# Source: Anthropic pricing, cached 2026-06-24. Verify before relying on it
# for billing — prices change and this table does not phone home.
PRICING_PER_1K = {
    "claude-fable-5-1": (0.010, 0.050),
    "claude-fable-5": (0.010, 0.050),
    "claude-opus-5": (0.005, 0.025),
    "claude-opus-4-8": (0.005, 0.025),
    "claude-sonnet-5": (0.002, 0.010),
    "claude-haiku-4-5": (0.001, 0.005),
}


def split_system(messages: Sequence[Message]) -> Tuple[str, List[Message]]:
    """Anthropic takes ``system`` as a top-level field, not a message role.

    The handoff briefing arrives as a system message, so this is the seam that
    makes failover *to* Claude work at all.
    """
    system_parts: List[str] = []
    conversation: List[Message] = []
    for message in messages:
        if message.get("role") == "system":
            content = message.get("content", "")
            if content:
                system_parts.append(content)
        else:
            conversation.append(
                {"role": message.get("role", "user"), "content": message.get("content", "")}
            )

    if not conversation:
        # The API requires at least one message; an all-system payload would 400.
        conversation = [{"role": "user", "content": system_parts.pop() if system_parts else ""}]

    return "\n\n".join(system_parts), conversation


class AnthropicAdapter:
    """Anthropic ``/v1/messages``."""

    def __init__(
        self,
        model: str,
        base_url: str = DEFAULT_BASE_URL,
        api_key_env: str = "ANTHROPIC_API_KEY",
        api_key: Optional[str] = None,
        timeout: float = 600.0,
        name: str = "",
        version: str = ANTHROPIC_VERSION,
        extra_body: Optional[Dict[str, Any]] = None,
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key_env = api_key_env
        self._api_key = api_key
        self.timeout = timeout
        self.name = name or model
        self.version = version
        self.extra_body = dict(extra_body or {})

    @classmethod
    def pricing_for(cls, model: str) -> Optional[Tuple[float, float]]:
        """Published ($/1K input, $/1K output), or None for an unknown model."""
        return PRICING_PER_1K.get(model)

    def _headers(self) -> Dict[str, str]:
        import os

        key = self._api_key or os.environ.get(self.api_key_env, "")
        headers = {"anthropic-version": self.version, "content-type": "application/json"}
        if key:
            headers["x-api-key"] = key
        return headers

    def _body(self, messages: Sequence[Message], request: RouteRequest) -> Dict[str, Any]:
        system, conversation = split_system(messages)
        body: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": request.max_output_tokens,
            "messages": conversation,
        }
        if system:
            body["system"] = system
        body.update(self.extra_body)
        return body

    def _raise_for(self, exc: urllib.error.HTTPError):
        detail = exc.read().decode("utf-8", "replace")[:500]
        if exc.code == 429:
            retry_after = exc.headers.get("retry-after") if exc.headers else None
            try:
                seconds = float(retry_after) if retry_after else 60.0
            except (TypeError, ValueError):
                seconds = 60.0
            raise RateLimited(detail, provider=self.name, retry_after=seconds)
        if exc.code in (500, 502, 503, 504, 529):
            raise ProviderError(f"HTTP {exc.code}: {detail}", provider=self.name, retry_after=10.0)
        raise ProviderError(f"HTTP {exc.code}: {detail}", provider=self.name, retry_after=300.0)

    # -- non-streaming -----------------------------------------------------

    def complete(self, messages: Sequence[Message], request: RouteRequest) -> AdapterResult:
        payload = json.dumps(self._body(messages, request)).encode("utf-8")
        http_request = urllib.request.Request(
            f"{self.base_url}/messages", data=payload, method="POST"
        )
        for key, value in self._headers().items():
            http_request.add_header(key, value)

        try:
            with urllib.request.urlopen(http_request, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            self._raise_for(exc)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            raise ProviderError(f"unreachable: {exc}", provider=self.name, retry_after=30.0)

        text = "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        )
        usage = data.get("usage") or {}

        # A refusal is a deliberate answer from the model, not a provider
        # outage. Raising here would make the router shop the same prompt
        # around other providers until one complies, which is not failover.
        return AdapterResult(
            text=text,
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            raw=data,
        )

    # -- streaming ---------------------------------------------------------

    def stream(self, messages: Sequence[Message], request: RouteRequest) -> Iterator[StreamEvent]:
        body = self._body(messages, request)
        body["stream"] = True
        payload = json.dumps(body).encode("utf-8")
        http_request = urllib.request.Request(
            f"{self.base_url}/messages", data=payload, method="POST"
        )
        for key, value in self._headers().items():
            http_request.add_header(key, value)

        input_tokens: Optional[int] = None
        output_tokens: Optional[int] = None

        try:
            response = urllib.request.urlopen(http_request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            self._raise_for(exc)
        except (urllib.error.URLError, OSError) as exc:
            raise ProviderError(f"unreachable: {exc}", provider=self.name, retry_after=30.0)

        with response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue

                kind = event.get("type")
                if kind == "message_start":
                    usage = (event.get("message") or {}).get("usage") or {}
                    input_tokens = usage.get("input_tokens")
                elif kind == "content_block_delta":
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield StreamEvent(text=delta["text"])
                elif kind == "message_delta":
                    usage = event.get("usage") or {}
                    output_tokens = usage.get("output_tokens", output_tokens)
                elif kind == "error":
                    error = event.get("error") or {}
                    message = error.get("message", "stream error")
                    if error.get("type") == "overloaded_error":
                        raise ProviderError(message, provider=self.name, retry_after=10.0)
                    raise ProviderError(message, provider=self.name)

        yield StreamEvent(done=True, input_tokens=input_tokens, output_tokens=output_tokens)
