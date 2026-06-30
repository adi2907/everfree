#!/usr/bin/env python3
"""
EverFree — Application Entry Point
Starts the uvicorn server. Browser auto-opens via FastAPI lifespan.
"""

import os
import socket
import urllib.error
import urllib.request
import webbrowser
import uvicorn
import server.app as server_app


DEFAULT_PORT = 52321
PORT_SCAN_LIMIT = 20


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _everfree_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/sync/status",
            timeout=0.5,
        ) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def _reuse_existing(port: int) -> None:
    url = f"http://127.0.0.1:{port}"
    print(f"EverFree is already running at {url}")
    if not os.environ.get("EVERFREE_NO_BROWSER"):
        webbrowser.open(url)


def _resolve_port() -> tuple[int, bool]:
    configured = os.environ.get("EVERFREE_PORT")
    if configured:
        port = int(configured)
        if _port_available(port):
            return port, False
        if _everfree_running(port):
            return port, True
        raise RuntimeError(f"Configured port {port} is already in use")

    for port in range(DEFAULT_PORT, DEFAULT_PORT + PORT_SCAN_LIMIT):
        if not _port_available(port) and _everfree_running(port):
            return port, True

    for port in range(DEFAULT_PORT, DEFAULT_PORT + PORT_SCAN_LIMIT):
        if _port_available(port):
            return port, False

    raise RuntimeError(f"No available local port found in {DEFAULT_PORT}-{DEFAULT_PORT + PORT_SCAN_LIMIT - 1}")


def main():
    port, existing = _resolve_port()
    if existing:
        _reuse_existing(port)
        return

    server_app.PORT = port
    log_level = os.environ.get("EVERFREE_LOG_LEVEL", "warning").lower()
    uvicorn.run(
        server_app.app,
        host="127.0.0.1",
        port=port,
        log_level=log_level,
        access_log=False,
    )


if __name__ == "__main__":
    main()
