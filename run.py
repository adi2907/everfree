#!/usr/bin/env python3
"""
EverFree — Application Entry Point
Starts the uvicorn server. Browser auto-opens via FastAPI lifespan.
"""

import os
import socket
import uvicorn
import server.app as server_app


DEFAULT_PORT = 52321


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _resolve_port() -> int:
    configured = os.environ.get("EVERFREE_PORT")
    if configured:
        return int(configured)

    for port in range(DEFAULT_PORT, DEFAULT_PORT + 20):
        if _port_available(port):
            return port

    raise RuntimeError(f"No available local port found in {DEFAULT_PORT}-{DEFAULT_PORT + 19}")


def main():
    port = _resolve_port()
    server_app.PORT = port
    uvicorn.run(
        server_app.app,
        host="127.0.0.1",
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
