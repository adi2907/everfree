#!/usr/bin/env python3
"""
EverFree MCP — the executable coding agents launch.

py2app builds this into `EverFree.app/Contents/MacOS/everfree-mcp`, alongside
the main application binary and sharing its bundled Python and site-packages.
That is the whole point of it existing: without it, connecting an agent would
mean a source checkout, a virtualenv and a working directory, none of which a
user who installed a DMG has.

It speaks MCP over stdio and talks to the running EverFree backend over HTTP,
so the app must be open — which is also what keeps a single process in charge
of writing the notes repository.
"""

import sys

from server.mcp_server import main

if __name__ == "__main__":
    sys.exit(main())
