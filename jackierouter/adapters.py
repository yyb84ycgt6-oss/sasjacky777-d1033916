"""Provider adapters.

Adapters are the only part of the library that touches the network, and they
use ``urllib`` from the standard library so that installing the router does not
drag in a dependency tree. An adapter's whole contract is:

    complete(messages, request) -> AdapterResult

and raise :class:`RateLimited` / :class:`ProviderError` on failure. Anything
that satisfies that works — including a test double.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence

from .errors import ProviderError, RateLimited
from .types import AdapterResult, Message, RouteRequest

DEFAULT_TIMEOUT = 120.0


def _post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: float) -> Dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _retry_after(exc: urllib.error.HTTPError, default: float) -> float:
    raw = exc.headers.get("Retry-After") if exc.headers else None
    try:
        return float(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default


def flatten(messages: Sequence[Message]) -> str:
    """Collapse a chat transcript into a single prompt for text-completion APIs."""
    lines = []
    for message in messages:
        role = message.get("role", "user")
        content = message.get("content", "")
        lines.append(content if role == "user" and len(messages) == 1 else f"{role}: {content}")
    return "\n\n".join(lines)


class OllamaAdapter:
    """Local Ollama. Tier 0: your own hardware, no metering, no bill."""

    def __init__(
        self,
        model: str,
        base_url: str = "http://localhost:11434",
        timeout: float = DEFAULT_TIMEOUT,
        name: str = "",
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.name = name or f"ollama/{model}"

    def complete(self, messages: Sequence[Message], request: RouteRequest) -> AdapterResult:
        payload = {
            "model": self.model,
            "prompt": flatten(messages),
            "stream": False,
            "options": {"num_predict": request.max_output_tokens},
        }
        try:
            data = _post_json(f"{self.base_url}/api/generate", payload, {}, self.timeout)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            if exc.code == 429:
                raise RateLimited(detail, provider=self.name, retry_after=_retry_after(exc, 30.0))
            raise ProviderError(f"HTTP {exc.code}: {detail}", provider=self.name)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            # A local box that is asleep, busy, or thermally gated looks like
            # this. It is a routing signal, not a crash.
            raise ProviderError(f"unreachable: {exc}", provider=self.name, retry_after=15.0)

        return AdapterResult(
            text=data.get("response", ""),
            input_tokens=data.get("prompt_eval_count"),
            output_tokens=data.get("eval_count"),
            raw=data,
        )


class OpenAICompatAdapter:
    """Any ``/v1/chat/completions`` endpoint: OpenAI, Groq, Together, vLLM, LM Studio."""

    def __init__(
        self,
        model: str,
        base_url: str,
        api_key_env: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        name: str = "",
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key_env = api_key_env
        self._api_key = api_key
        self.timeout = timeout
        self.name = name or model

    def _key(self) -> str:
        if self._api_key:
            return self._api_key
        if self.api_key_env:
            return os.environ.get(self.api_key_env, "")
        return ""

    def complete(self, messages: Sequence[Message], request: RouteRequest) -> AdapterResult:
        headers = {}
        key = self._key()
        if key:
            headers["Authorization"] = f"Bearer {key}"

        payload = {
            "model": self.model,
            "messages": list(messages),
            "max_tokens": request.max_output_tokens,
        }
        try:
            data = _post_json(
                f"{self.base_url}/chat/completions", payload, headers, self.timeout
            )
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            if exc.code == 429:
                raise RateLimited(detail, provider=self.name, retry_after=_retry_after(exc, 60.0))
            if exc.code in (500, 502, 503, 504):
                raise ProviderError(f"HTTP {exc.code}: {detail}", provider=self.name, retry_after=10.0)
            raise ProviderError(f"HTTP {exc.code}: {detail}", provider=self.name, retry_after=300.0)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            raise ProviderError(f"unreachable: {exc}", provider=self.name, retry_after=30.0)

        choices = data.get("choices") or []
        text = choices[0].get("message", {}).get("content", "") if choices else ""
        usage = data.get("usage") or {}
        return AdapterResult(
            text=text,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            raw=data,
        )


class EchoAdapter:
    """Deterministic offline adapter, for tests and for proving a route works."""

    def __init__(self, reply: str = "ok", name: str = "echo"):
        self.reply = reply
        self.name = name

    def complete(self, messages: Sequence[Message], request: RouteRequest) -> AdapterResult:
        return AdapterResult(text=self.reply, raw={"messages": list(messages)})
