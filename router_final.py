#!/usr/bin/env python3
"""Local AI Router Gateway — thin HTTP shell over the jackierouter library.

Jackie → Router → (local Ollama first, cloud only when it must)

The routing intelligence lives in ``jackierouter/``: quota forecasting, the
cost ladder, the budget guard, and context-preserving handoff. This file is
only the port it listens on. Configure the provider ladder with a JSON file
and point ``JACKIEROUTER_CONFIG`` at it — see ``router.config.example.json``.
"""

import logging

from jackierouter.gateway import create_app

logging.basicConfig(level=logging.INFO)

app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=4000)
