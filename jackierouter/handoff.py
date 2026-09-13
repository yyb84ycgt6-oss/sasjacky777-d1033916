"""Context-preserving handoff between providers.

When a provider runs dry mid-conversation, the naive fix is to replay the same
messages at a different model and hope. That loses everything the first model
had already worked out, and the user watches it start over.

A briefing is a compact system message that tells the incoming model three
things the raw transcript does not: what the task actually is, what the
previous model had already produced, and that its job is to *continue* rather
than restart. It is built to a character budget so it cannot itself become the
reason the next provider overflows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from .types import Message, RouteRequest, estimate_tokens

CONTINUATION_RULE = (
    "You are taking over this task mid-flight from another model that became "
    "unavailable. Continue from where it stopped. Do not restart, do not "
    "re-introduce yourself, and do not repeat work that is already done below."
)


def _clip(text: str, budget: int, from_end: bool = False) -> str:
    text = (text or "").strip()
    if len(text) <= budget:
        return text
    if from_end:
        return "…" + text[-(budget - 1):]
    return text[: budget - 1] + "…"


@dataclass
class HandoffBriefing:
    """A structured account of an interrupted turn."""

    task: str
    reason: str
    prior_provider: str
    established: List[str] = field(default_factory=list)
    partial_output: str = ""

    def render(self) -> str:
        parts = [CONTINUATION_RULE, "", f"TASK: {self.task}"]
        if self.established:
            parts.append("")
            parts.append("ESTABLISHED SO FAR:")
            parts.extend(f"- {line}" for line in self.established)
        if self.partial_output:
            parts.append("")
            parts.append(f"WORK ALREADY PRODUCED (by {self.prior_provider}, incomplete):")
            parts.append(self.partial_output)
            parts.append("")
            parts.append("Resume from the end of that text.")
        parts.append("")
        parts.append(f"HANDOFF REASON: {self.reason}")
        return "\n".join(parts)

    def to_message(self) -> Message:
        return {"role": "system", "content": self.render()}

    def estimated_tokens(self) -> int:
        return estimate_tokens(self.render())


def build_briefing(
    request: RouteRequest,
    *,
    prior_provider: str,
    reason: str,
    partial_output: str = "",
    max_chars: int = 2000,
) -> HandoffBriefing:
    """Compact an in-progress turn into a briefing for the next provider.

    The budget is split so that the task statement and the partial output —
    the two things the incoming model cannot reconstruct — are protected, and
    the middle of the conversation is what gets compressed.
    """
    task_budget = max(200, max_chars // 4)
    output_budget = max(200, max_chars // 2)

    task = _clip(request.last_user_message(), task_budget)

    # Keep the tail of the partial output: a model resuming generation needs
    # the words immediately before the cut, not the opening paragraph.
    partial = _clip(partial_output, output_budget, from_end=True)

    established = summarize_history(
        request.messages,
        budget=max_chars - len(task) - len(partial),
    )

    return HandoffBriefing(
        task=task,
        reason=reason,
        prior_provider=prior_provider,
        established=established,
        partial_output=partial,
    )


def summarize_history(messages: Sequence[Message], *, budget: int) -> List[str]:
    """One line per earlier turn, newest first, until the budget runs out.

    No model call: a briefing that needs an LLM to build is a briefing that
    fails exactly when every model is rate limited.
    """
    if budget <= 0 or len(messages) <= 1:
        return []

    lines: List[str] = []
    spent = 0
    per_line = max(80, budget // max(1, min(len(messages), 8)))

    # Skip the final user message — it is already the TASK line.
    for message in reversed(list(messages)[:-1]):
        role = message.get("role", "user")
        if role == "system":
            continue
        line = f"{role}: {_clip(message.get('content', ''), per_line)}"
        if spent + len(line) > budget:
            break
        lines.append(line)
        spent += len(line)

    return list(reversed(lines))


def apply_briefing(messages: Sequence[Message], briefing: Optional[HandoffBriefing]) -> List[Message]:
    """Return the message list the next provider should actually receive."""
    if briefing is None:
        return list(messages)
    return [briefing.to_message()] + list(messages)
