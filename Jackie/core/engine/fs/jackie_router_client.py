"""
Jackie OS — Router Client
=========================

Deterministic, pod-aware, backpack-aware client for talking to the router.
This is the canonical client Jackie will use to send requests.
"""

import requests
from typing import Dict, Any, Optional


class JackieRouterClient:
    """
    Jackie → Router → Ollama

    Deterministic sovereign OS client.

    Never rewrites itself.
    Never rewrites the router.
    Never mutates payloads.
    Never tries to be 'helpful'.
    Never calls tools.
    Never spawns subprocesses.
    Never changes your environment.
    """

    def __init__(self, router_url: str = "http://127.0.0.1:4000"):
        self.router_url = router_url.rstrip("/")

    # ────────────────────────────────────────
    # Core call builder
    # ────────────────────────────────────────

    def build_payload(
        self,
        task: str,
        content: str,
        pod: str = "general",
        backpack: str = "general",
        model: str = "auto",
        agent: str = "Jackie",
        memory_partition: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Build a router-compatible payload."""
        payload = {
            "agent": agent,
            "task": task,
            "model": model,
            "pod_id": pod,
            "backpack_id": backpack,
            "messages": [{"role": "user", "content": content}],
        }

        if memory_partition:
            payload["memory_partition"] = memory_partition

        return payload

    # ────────────────────────────────────────
    # Main call to router
    # ────────────────────────────────────────

    def send(
        self,
        task: str,
        content: str,
        pod: str = "general",
        backpack: str = "general",
        model: str = "auto",
        agent: str = "Jackie",
        memory_partition: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a request to the router and return the result."""
        payload = self.build_payload(
            task=task,
            content=content,
            pod=pod,
            backpack=backpack,
            model=model,
            agent=agent,
            memory_partition=memory_partition,
        )

        try:
            resp = requests.post(
                f"{self.router_url}/chat/completions",
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()

        except Exception as e:
            return {
                "error": str(e),
                "router_url": self.router_url,
                "payload": payload,
            }

    # ────────────────────────────────────────
    # Lightweight auto-complete endpoint
    # ────────────────────────────────────────

    def auto(self, prompt: str, model: str = "auto") -> Dict[str, Any]:
        """Send a lightweight auto-complete request."""
        try:
            resp = requests.post(
                f"{self.router_url}/complete/auto",
                json={"prompt": prompt, "model": model},
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()

        except Exception as e:
            return {"error": str(e), "prompt": prompt}

    # ────────────────────────────────────────
    # Health checks
    # ────────────────────────────────────────

    def ready(self) -> Dict[str, Any]:
        """Check if the router is running."""
        try:
            return requests.get(f"{self.router_url}/ready", timeout=5).json()
        except Exception as e:
            return {"ready": False, "error": str(e)}

    def health(self) -> Dict[str, Any]:
        """Get detailed router health info."""
        try:
            return requests.get(f"{self.router_url}/health", timeout=5).json()
        except Exception as e:
            return {"status": "offline", "error": str(e)}
