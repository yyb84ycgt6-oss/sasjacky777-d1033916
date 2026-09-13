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
from typing import Any, Dict, Iterator, List, Optional, Sequence

from .errors import ProviderError, RateLimited
from .types import AdapterResult, Message, RouteRequest, StreamEvent

DEFAULT_TIMEOUT = 120.0


def _post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: float) -> Dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _open_stream(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: float):
    """Open a streaming POST. The caller iterates the response line by line."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        request.add_header(key, value)
    return urllib.request.urlopen(request, timeout=timeout)


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

    def stream(self, messages: Sequence[Message], request: RouteRequest) -> Iterator[StreamEvent]:
        """Ollama streams newline-delimited JSON, one object per token batch."""
        payload = {
            "model": self.model,
            "prompt": flatten(messages),
            "stream": True,
            "options": {"num_predict": request.max_output_tokens},
        }
        try:
            response = _open_stream(f"{self.base_url}/api/generate", payload, {}, self.timeout)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            if exc.code == 429:
                raise RateLimited(detail, provider=self.name, retry_after=_retry_after(exc, 30.0))
            raise ProviderError(f"HTTP {exc.code}: {detail}", provider=self.name)
        except (urllib.error.URLError, OSError) as exc:
            raise ProviderError(f"unreachable: {exc}", provider=self.name, retry_after=15.0)

        input_tokens = output_tokens = None
        with response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if chunk.get("error"):
                    raise ProviderError(str(chunk["error"]), provider=self.name)
                if chunk.get("response"):
                    yield StreamEvent(text=chunk["response"])
                if chunk.get("done"):
                    input_tokens = chunk.get("prompt_eval_count")
                    output_tokens = chunk.get("eval_count")

        yield StreamEvent(done=True, input_tokens=input_tokens, output_tokens=output_tokens)


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

    def stream(self, messages: Sequence[Message], request: RouteRequest) -> Iterator[StreamEvent]:
        """Server-sent events: ``data: {json}`` lines terminated by ``[DONE]``."""
        headers = {}
        key = self._key()
        if key:
            headers["Authorization"] = f"Bearer {key}"
        payload = {
            "model": self.model,
            "messages": list(messages),
            "max_tokens": request.max_output_tokens,
            "stream": True,
            # Ask for usage on the final chunk; servers that do not know this
            # option ignore it, and the router falls back to its estimate.
            "stream_options": {"include_usage": True},
        }
        try:
            response = _open_stream(
                f"{self.base_url}/chat/completions", payload, headers, self.timeout
            )
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            if exc.code == 429:
                raise RateLimited(detail, provider=self.name, retry_after=_retry_after(exc, 60.0))
            retry_after = 10.0 if exc.code in (500, 502, 503, 504) else 300.0
            raise ProviderError(
                f"HTTP {exc.code}: {detail}", provider=self.name, retry_after=retry_after
            )
        except (urllib.error.URLError, OSError) as exc:
            raise ProviderError(f"unreachable: {exc}", provider=self.name, retry_after=30.0)

        input_tokens = output_tokens = None
        with response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                usage = chunk.get("usage")
                if usage:
                    input_tokens = usage.get("prompt_tokens", input_tokens)
                    output_tokens = usage.get("completion_tokens", output_tokens)
                for choice in chunk.get("choices") or []:
                    delta = (choice.get("delta") or {}).get("content")
                    if delta:
                        yield StreamEvent(text=delta)

        yield StreamEvent(done=True, input_tokens=input_tokens, output_tokens=output_tokens)


class EchoAdapter:
    """Deterministic offline adapter, for tests and for proving a route works."""

    def __init__(self, reply: str = "ok", name: str = "echo"):
        self.reply = reply
        self.name = name

    def complete(self, messages: Sequence[Message], request: RouteRequest) -> AdapterResult:
        return AdapterResult(text=self.reply, raw={"messages": list(messages)})

    def stream(self, messages: Sequence[Message], request: RouteRequest) -> Iterator[StreamEvent]:
        for index, word in enumerate(self.reply.split()):
            yield StreamEvent(text=word if index == 0 else f" {word}")
        yield StreamEvent(done=True)
