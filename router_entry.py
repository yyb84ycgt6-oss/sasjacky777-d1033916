#!/usr/bin/env python3
"""Service entrypoint used by install_jackierouter.bat (NSSM)."""

import logging
import os

import uvicorn

from router_final import app

if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("JACKIEROUTER_LOG_LEVEL", "INFO"))
    uvicorn.run(
        app,
        host=os.environ.get("JACKIEROUTER_HOST", "127.0.0.1"),
        port=int(os.environ.get("JACKIEROUTER_PORT", "4000")),
    )
