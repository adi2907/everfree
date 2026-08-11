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

    def test_deleting_a_notebook_takes_its_notes_and_leaves_the_rest(self):
        for notebook in ("Doomed", "Keeper"):
            self.client.post("/api/notebooks", json={"name": notebook})
            self.client.post(f"/api/notebooks/{notebook}/notes", json={"name": "One"})
            self.client.post(f"/api/notebooks/{notebook}/notes", json={"name": "Two"})

        deleted = self.client.delete("/api/notebooks/Doomed")
        self.assertEqual(deleted.status_code, 200, deleted.text)

        library = self.client.get("/api/library").json()
        self.assertNotIn("Doomed", library["notebooks"])
        self.assertEqual(self.client.get("/api/notebooks/Doomed/notes/One.md").status_code, 404)

        # A neighbour must survive: the delete removes one directory, not a
        # prefix match across the notes tree.
        self.assertIn("Keeper", library["notebooks"])
        self.assertEqual(self.client.get("/api/notebooks/Keeper/notes/One.md").status_code, 200)

    def test_deleting_an_unknown_notebook_is_a_404(self):
        self.assertEqual(self.client.delete("/api/notebooks/NoSuchThing").status_code, 404)

    # ── Rename ──────────────────────────────────────────────
    def test_renaming_a_note_retitles_it_and_frees_the_old_name(self):
        self.client.post("/api/notebooks", json={"name": "Renames"})
        self.client.post("/api/notebooks/Renames/notes", json={"name": "Before"})
        self.client.put(
            "/api/notebooks/Renames/notes/Before.md",
            json={"content": "# Before\n\nBody that must survive.\n"})

        renamed = self.client.post(
            "/api/notebooks/Renames/notes/Before.md/rename", json={"new_name": "After"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["note"], "After.md")

        read = self.client.get("/api/notebooks/Renames/notes/After.md")
        self.assertEqual(read.status_code, 200, read.text)
        # The web client titles a note by its H1, so the rename has to move the
        # heading too or the note reads by its old name on every other client.
        self.assertEqual(read.json()["content"], "# After\n\nBody that must survive.\n")
        self.assertEqual(self.client.get("/api/notebooks/Renames/notes/Before.md").status_code, 404)

    def test_renaming_a_note_without_a_heading_adds_none(self):
        self.client.post("/api/notebooks", json={"name": "Headless"})
        self.client.post("/api/notebooks/Headless/notes", json={"name": "Plain"})
        self.client.put(
            "/api/notebooks/Headless/notes/Plain.md", json={"content": "just a line\n"})

        self.client.post(
            "/api/notebooks/Headless/notes/Plain.md/rename", json={"new_name": "Renamed"})

        # Such a note already displays as its file name, so there is nothing to
        # rewrite — and inserting a heading would put content in the note that
        # the user never wrote.
        read = self.client.get("/api/notebooks/Headless/notes/Renamed.md")
        self.assertEqual(read.json()["content"], "just a line\n")

    def test_renaming_a_notebook_leaves_its_notes_untouched(self):
        self.client.post("/api/notebooks", json={"name": "Before"})
        self.client.post("/api/notebooks/Before/notes", json={"name": "Note"})
        self.client.put(
            "/api/notebooks/Before/notes/Note.md", json={"content": "# Note\n\nBody.\n"})

        self.client.post("/api/notebooks/Before/rename", json={"new_name": "After"})

        # Only a note rename retitles: a note's heading is its own name, not its
        # notebook's, so moving the folder must not rewrite a byte of it.
        read = self.client.get("/api/notebooks/After/notes/Note.md")
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(read.json()["content"], "# Note\n\nBody.\n")

    def test_renaming_a_note_onto_an_existing_one_is_rejected(self):
        self.client.post("/api/notebooks", json={"name": "Clash"})
        self.client.post("/api/notebooks/Clash/notes", json={"name": "One"})
        self.client.post("/api/notebooks/Clash/notes", json={"name": "Two"})

        # Silently overwriting here would destroy a note the user never named.
        clash = self.client.post(
            "/api/notebooks/Clash/notes/One.md/rename", json={"new_name": "Two"})
        self.assertEqual(clash.status_code, 409)
        self.assertEqual(self.client.get("/api/notebooks/Clash/notes/One.md").status_code, 200)

    def test_renaming_a_note_out_of_its_notebook_is_rejected(self):
        self.client.post("/api/notebooks", json={"name": "Fenced"})
        self.client.post("/api/notebooks/Fenced/notes", json={"name": "Inside"})

        escaped = self.client.post(
            "/api/notebooks/Fenced/notes/Inside.md/rename", json={"new_name": "../Outside"})
        self.assertEqual(escaped.status_code, 400)
        self.assertEqual(self.client.get("/api/notebooks/Fenced/notes/Inside.md").status_code, 200)

    def test_renaming_a_notebook_takes_its_notes_and_leaves_the_rest(self):
        for notebook in ("Old", "Bystander"):
            self.client.post("/api/notebooks", json={"name": notebook})
            self.client.post(f"/api/notebooks/{notebook}/notes", json={"name": "One"})

        renamed = self.client.post("/api/notebooks/Old/rename", json={"new_name": "New"})
        self.assertEqual(renamed.status_code, 200, renamed.text)

        library = self.client.get("/api/library").json()
        self.assertIn("New", library["notebooks"])
        self.assertNotIn("Old", library["notebooks"])
        self.assertEqual(self.client.get("/api/notebooks/New/notes/One.md").status_code, 200)

        # A neighbour must survive: the rename moves one directory, not a prefix
        # match across the notes tree.
        self.assertIn("Bystander", library["notebooks"])
        self.assertEqual(self.client.get("/api/notebooks/Bystander/notes/One.md").status_code, 200)

    def test_renaming_a_notebook_onto_an_existing_one_is_rejected(self):
        for notebook in ("Source", "Target"):
            self.client.post("/api/notebooks", json={"name": notebook})
        clash = self.client.post("/api/notebooks/Source/rename", json={"new_name": "Target"})
        self.assertEqual(clash.status_code, 409)
        self.assertIn("Source", self.client.get("/api/library").json()["notebooks"])

    # ── Sign-out ────────────────────────────────────────────
    def test_sign_out_clears_credentials_without_touching_notes(self):
        # The real endpoint deletes the OS keyring entry and the auth file, so
        # both are redirected here. Without this the test suite would sign the
        # developer running it out of their own installation.
        cleared = []

        class _FakeStore:
            def clear(self):
                cleared.append(True)

        note = Path(self._tmp.name) / "Keep" / "note.md"
        note.parent.mkdir(parents=True)
        note.write_text("# Keep me\n", encoding="utf-8")

        original_store, original_auth_file = app.GITHUB_CREDENTIALS, app.AUTH_FILE
        app.GITHUB_CREDENTIALS = _FakeStore()
        app.AUTH_FILE = Path(self._tmp.name) / "auth.json"
        app.AUTH_FILE.write_text("{}", encoding="utf-8")
        app.github_auth_state.update({"access_token": "gho_x", "username": "octocat",
                                      "status": "authorized"})
        try:
            response = self.client.post("/api/auth/github/logout")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "signed_out")
            self.assertTrue(cleared, "the credential store was never cleared")
            self.assertFalse(app.AUTH_FILE.exists())

            # The in-memory copy is checked before the vault, so leaving it set
            # would keep the running process authorized after signing out.
            self.assertIsNone(app.github_auth_state["access_token"])
            self.assertIsNone(app.github_auth_state["username"])
            self.assertEqual(app.github_auth_state["status"], "idle")

            # Signing out hands back a token; it does not discard work.
            self.assertTrue(note.exists())
            self.assertIn("Keep me", note.read_text(encoding="utf-8"))

            self.assertEqual(app.sync_state["status"], "blocked")
            self.assertEqual(app.sync_state["action"], "reauth")
        finally:
            app.GITHUB_CREDENTIALS = original_store
            app.AUTH_FILE = original_auth_file
            app.github_auth_state.update({"access_token": None, "username": None,
                                          "status": "idle"})
            app._set_sync_state(status="idle", action=None, detail="")

    def test_sign_out_survives_an_unavailable_credential_store(self):
        class _BrokenStore:
            def clear(self):
                raise app.CredentialStoreError("vault locked")

        original_store, original_auth_file = app.GITHUB_CREDENTIALS, app.AUTH_FILE
        app.GITHUB_CREDENTIALS = _BrokenStore()
        app.AUTH_FILE = Path(self._tmp.name) / "auth.json"
        try:
            response = self.client.post("/api/auth/github/logout")
            # A locked vault must not strand the user signed in.
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn("vault locked", " ".join(response.json()["problems"]))
            self.assertIsNone(app.github_auth_state["access_token"])
        finally:
            app.GITHUB_CREDENTIALS = original_store
            app.AUTH_FILE = original_auth_file
            app._set_sync_state(status="idle", action=None, detail="")

    def test_static_assets_must_be_revalidated(self):
        # A cached script paired with an updated backend makes new features
        # render but do nothing, which reads as "the feature is broken".
        response = self.client.get("/static/app.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("cache-control"), "no-cache")
        self.assertTrue(response.headers.get("etag"), "revalidation needs an ETag")

    def test_path_traversal_is_refused(self):
        response = self.client.get("/api/notebooks/..%2F..%2Fetc/notes")
        self.assertIn(response.status_code, (400, 403, 404))
        self.assertFalse((Path(self._tmp.name).parent / "etc").exists())


if __name__ == "__main__":
    unittest.main()
