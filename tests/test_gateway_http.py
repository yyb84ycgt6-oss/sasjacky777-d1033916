"""Live HTTP tests. Skipped unless the gateway extra is installed.

These exist because the pure-function tests could not have caught a 422 caused
by how FastAPI resolves handler annotations — only a real request could.
"""

import pytest

fastapi = pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from jackierouter import EchoAdapter, Provider, RateLimited, Router  # noqa: E402
from jackierouter.gateway import create_app  # noqa: E402


class Dead:
    def complete(self, messages, request):
        raise RateLimited("quota spent", provider="dead", retry_after=60)


@pytest.fixture
def client():
    router = Router(
        [
            Provider(name="dead", model="dead-1", adapter=Dead(), tier=0),
            Provider(name="backup", model="backup-1", adapter=EchoAdapter(reply="carried on"), tier=1),
        ]
    )
    return TestClient(create_app(router))


def test_generate_returns_200_and_the_legacy_shape(client):
    response = client.post("/api/generate", json={"messages": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 200
    body = response.json()
    assert body["result"] == "carried on"
    assert body["model_used"] == "backup-1"
    assert body["handoffs"] == 1
    assert [(t["provider"], t["outcome"]) for t in body["trace"]] == [
        ("dead", "rate_limited"),
        ("backup", "ok"),
    ]


def test_bare_prompt_still_works(client):
    assert client.post("/api/generate", json={"prompt": "hi"}).status_code == 200


def test_unservable_request_is_a_503_with_the_reason(client):
    response = client.post("/api/generate", json={"prompt": "hi", "model": "nonexistent"})
    assert response.status_code == 503
    assert response.json()["trace"][0]["detail"] == "pinned provider is not configured"


def test_probes_and_status(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json()["providers"] == ["dead", "backup"]
    assert {p["name"] for p in client.get("/status").json()["providers"]} == {"dead", "backup"}
