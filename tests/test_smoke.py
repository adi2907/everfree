"""End-to-end smoke test: boot the app and exercise the core note lifecycle.

The suite otherwise covers only `github_auth`, so a merge that breaks routing
or note I/O in the 2000-line `app` module passes silently. This is the gate for
integrating branches: it starts the real ASGI app and drives real requests.

It never touches the network or the user's notes — `NOTES_DIR` is redirected to
a temporary directory and no git repo exists there, so the sync worker stays
idle.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

# Must be set before `server.app` binds its module-level configuration.
os.environ.setdefault("EVERFREE_DIR", tempfile.mkdtemp(prefix="everfree-smoke-"))
os.environ["EVERFREE_NO_BROWSER"] = "1"

from fastapi.testclient import TestClient

import server.app as app


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="everfree-smoke-")
        self._original_notes_dir = app.NOTES_DIR
        # Module functions read this global at call time, so redirecting it
        # keeps every route inside the sandbox.
        app.NOTES_DIR = Path(self._tmp.name)
        self.client = TestClient(app.app)

    def tearDown(self):
        app.NOTES_DIR = self._original_notes_dir
        self._tmp.cleanup()

    # ── Routing ─────────────────────────────────────────────
    def test_root_serves_a_page(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("<html", response.text.lower())

    def test_setup_route_is_reachable_regardless_of_auth_state(self):
        # The blocked-sync banner sends users here to re-authorize, so it must
        # not depend on the in-memory "authorized" flag that a revoked token
        # leaves stale.
        app.github_auth_state["status"] = "authorized"
        try:
            response = self.client.get("/setup")
        finally:
            app.github_auth_state["status"] = None
        self.assertEqual(response.status_code, 200)
        self.assertIn("<html", response.text.lower())

    # ── Status endpoints ────────────────────────────────────
    def test_sync_status_reports_local_only_without_a_repo(self):
        payload = self.client.get("/api/sync/status").json()
        self.assertFalse(payload["git"])
        self.assertEqual(payload["status"], "local")

    def test_setup_status_responds(self):
        response = self.client.get("/api/setup/status")
        self.assertEqual(response.status_code, 200)
        self.assertIn("notes_dir", response.json())

    # ── Note lifecycle ──────────────────────────────────────
    def test_notebook_and_note_round_trip(self):
        created = self.client.post("/api/notebooks", json={"name": "Smoke"})
        self.assertEqual(created.status_code, 200, created.text)

        note = self.client.post("/api/notebooks/Smoke/notes", json={"name": "Hello"})
        self.assertEqual(note.status_code, 200, note.text)
        self.assertEqual(note.json()["note"], "Hello.md")

        saved = self.client.put(
            "/api/notebooks/Smoke/notes/Hello.md",
            json={"content": "# Hello\n\nSmoke test body.\n"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)

        read = self.client.get("/api/notebooks/Smoke/notes/Hello.md")
        self.assertEqual(read.status_code, 200)
        self.assertIn("Smoke test body.", read.json()["content"])

        library = self.client.get("/api/library").json()
        self.assertIn("Smoke", library["notebooks"])

        deleted = self.client.delete("/api/notebooks/Smoke/notes/Hello.md")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(self.client.get("/api/notebooks/Smoke/notes/Hello.md").status_code, 404)

    def test_duplicate_notebook_is_rejected(self):
        self.client.post("/api/notebooks", json={"name": "Dup"})
        again = self.client.post("/api/notebooks", json={"name": "Dup"})
        self.assertEqual(again.status_code, 409)

    def test_path_traversal_is_refused(self):
        response = self.client.get("/api/notebooks/..%2F..%2Fetc/notes")
        self.assertIn(response.status_code, (400, 403, 404))
        self.assertFalse((Path(self._tmp.name).parent / "etc").exists())


if __name__ == "__main__":
    unittest.main()
