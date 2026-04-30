"""
EverFree — py2app Configuration
Bundles the FastAPI server + frontend into a standalone macOS .app.

Usage:
    python packaging/setup_py2app.py py2app
"""

from setuptools import setup
from pathlib import Path

APP = ["run.py"]
DATA_FILES = [
    ('frontend', [
        'frontend/index.html',
        'frontend/style.css',
        'frontend/app.js',
        'frontend/setup.html',
        'frontend/setup.css',
        'frontend/setup.js',
    ]),
    ('frontend/assets', [
        'frontend/assets/everfree-logo.svg',
    ])
]

OPTIONS = {
    "argv_emulation": False,
    "packages": [
        # FastAPI and its dependencies — all need explicit inclusion
        # because they rely on dynamic imports that py2app can't trace.
        "fastapi",
        "starlette",
        "uvicorn",
        "pydantic",
        "pydantic_core",
        "anyio",
        "httpx",
        # Evernote import pipeline. evernote-backup is a Python package in
        # requirements.txt, so bundle it instead of relying on a shell command.
        "evernote_backup",
        "evernote",
        "thrift",
        "requests",
        "requests_oauthlib",
        "requests_sse",
        "xmltodict",
        "click",
        "click_option_group",
        # Server code
        "server",
    ],
    "includes": [
        "jaraco.text",
        "jaraco.functools",
        "jaraco.context",
        "more_itertools",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
    ],
    "plist": {
        "CFBundleName": "EverFree",
        "CFBundleDisplayName": "EverFree",
        "CFBundleIdentifier": "com.everfree.app",
        "CFBundleVersion": "1.0.0",
        "CFBundleShortVersionString": "1.0.0",
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
    },
}

ICON_FILE = Path("packaging/EverFree.icns")
if ICON_FILE.exists():
    OPTIONS["iconfile"] = str(ICON_FILE)

setup(
    name="EverFree",
    app=APP,
    data_files=DATA_FILES,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
