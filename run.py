#!/usr/bin/env python3
"""
EverFree — Application Entry Point
Starts the uvicorn server. Browser auto-opens via FastAPI lifespan.
"""

import os
import uvicorn
from server.app import app


def main():
    port = int(os.environ.get("EVERFREE_PORT", 52321))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
