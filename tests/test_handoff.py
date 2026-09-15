from jackierouter import RouteRequest, build_briefing
from jackierouter.handoff import apply_briefing, summarize_history


def request():
    return RouteRequest(
        messages=[
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Port the payments migration to Postgres 16."},
            {"role": "assistant", "content": "Starting with the schema diff."},
            {"role": "user", "content": "Now write the down-migration."},
        ]
    )


def test_briefing_names_the_task_and_the_reason():
    briefing = build_briefing(
        request(), prior_provider="groq/llama", reason="rate limited", partial_output=""
    )
    rendered = briefing.render()
    assert "Now write the down-migration." in rendered
    assert "HANDOFF REASON: rate limited" in rendered
    assert "Do not restart" in rendered


def test_briefing_carries_earlier_turns():
    rendered = build_briefing(request(), prior_provider="x", reason="y").render()
    assert "Port the payments migration" in rendered
    assert "schema diff" in rendered


def test_partial_output_keeps_the_tail_not_the_head():
    partial = "A" * 500 + "THE-CUT-POINT"
    briefing = build_briefing(
        request(), prior_provider="x", reason="y", partial_output=partial, max_chars=600
    )
    rendered = briefing.render()
    assert "THE-CUT-POINT" in rendered  # a resuming model needs the last words
    assert "Resume from the end of that text." in rendered


def test_briefing_respects_its_character_budget():
    request_with_bulk = RouteRequest(
        messages=[{"role": "user", "content": "x" * 5000} for _ in range(10)]
    )
    briefing = build_briefing(
        request_with_bulk,
        prior_provider="x",
        reason="y",
        partial_output="z" * 5000,
        max_chars=1500,
    )
    # Budget governs the variable parts; the fixed rule text is not compressible.
    assert len(briefing.render()) < 1500 + len("You are taking over") + 600


def test_system_messages_are_not_replayed_as_established_facts():
    lines = summarize_history(request().messages, budget=2000)
    assert not any(line.startswith("system:") for line in lines)


def test_apply_briefing_prepends_a_system_message():
    req = request()
    briefing = build_briefing(req, prior_provider="x", reason="y")
    messages = apply_briefing(req.messages, briefing)
    assert messages[0]["role"] == "system"
    assert len(messages) == len(req.messages) + 1
    assert apply_briefing(req.messages, None) == req.messages
