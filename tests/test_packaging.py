"""The DMG has to contain everything a documented workflow needs.

Agent access was documented as `python3 -m server.mcp_server`, which only works
in a source checkout with the right working directory. Someone who installed
the app from the DMG had no way to run it at all. These checks keep the bundle
and the instructions describing the same product.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / "packaging" / "setup_py2app.py"


def _py2app_options() -> dict:
    """Read OPTIONS out of the setup script without importing setuptools."""
    tree = ast.parse(SETUP.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "OPTIONS" for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("packaging/setup_py2app.py no longer defines OPTIONS")


def _data_files() -> list[tuple[str, list[str]]]:
    """Read DATA_FILES without importing the setuptools build script."""
    tree = ast.parse(SETUP.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "DATA_FILES" for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("packaging/setup_py2app.py no longer defines DATA_FILES")


class BundledMcpTests(unittest.TestCase):
    def setUp(self):
        self.options = _py2app_options()

    def test_the_mcp_launcher_is_built_into_the_bundle(self):
        scripts = self.options.get("extra_scripts") or []
        self.assertIn(
            "packaging/everfree-mcp.py", scripts,
            "the MCP server must ship as an executable in the .app, or a DMG "
            "user cannot connect an agent at all",
        )

    def test_the_launcher_exists_and_starts_the_mcp_server(self):
        launcher = ROOT / "packaging" / "everfree-mcp.py"
        self.assertTrue(launcher.is_file())
        source = launcher.read_text(encoding="utf-8")
        self.assertIn("from server.mcp_server import main", source)

    def test_the_server_package_is_bundled(self):
        self.assertIn("server", self.options.get("packages") or [])

    def test_documentation_points_at_the_bundled_executable(self):
        """The README must not tell a DMG user to run a module they don't have."""
        for relative in ("README.md", "docs/agent-access.md"):
            text = (ROOT / relative).read_text(encoding="utf-8")
            if "python3 -m server.mcp_server" in text:
                self.assertIn(
                    "source checkout", text,
                    f"{relative} gives the module command without saying it is "
                    "for a source checkout",
                )
            self.assertIn("everfree-mcp", text, f"{relative}")

    def test_assistant_ui_is_not_copied_into_the_desktop_frontend(self):
        """Desktop and web must serve the same assistant source file."""
        destinations = {destination: files for destination, files in _data_files()}
        self.assertIn("web", destinations)
        self.assertIn("web/assistant.js", destinations["web"])
        self.assertNotIn("web/assistant.js", destinations.get("frontend", []))
        self.assertIn("web/lib/assistant-config.json", destinations["frontend"])


if __name__ == "__main__":
    unittest.main()
