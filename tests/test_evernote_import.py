"""Desktop Evernote import: pipeline, re-entry, and platform scope.

The import is the one flow that cannot be exercised against the real service
without a human at an Evernote login page. Everything on the EverFree side of
that login can still be checked, so this suite fakes exactly two things — the
OAuth handshake and the note download — and runs the rest for real: the real
`evernote-backup` sqlite storage, its real `.enex` exporter, and the real
`evernote2md` binary. A pass therefore means Markdown actually landed in the
notes directory, not that a mock was called.

Three separate claims are covered:

1. The import works on first run (desktop only).
2. It disappears from the wizard once notes exist, without becoming
   unreachable.
3. Nothing in `web/` or `web/mobile/` can reach it, so the browser clients do
   not advertise a flow they cannot run.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("EVERFREE_DIR", tempfile.mkdtemp(prefix="everfree-evernote-"))
os.environ["EVERFREE_NO_BROWSER"] = "1"

from fastapi.testclient import TestClient

import server.app as app

REPO_ROOT = Path(__file__).resolve().parent.parent

try:
    from evernote.edam.type.ttypes import Note, Notebook
    from evernote_backup import cli_app, cli_app_util, note_storage
    from evernote_backup import evernote_client_oauth as oauth_module

    EVERNOTE_BACKUP_AVAILABLE = True
except ImportError:  # pragma: no cover - desktop-only dependency
    EVERNOTE_BACKUP_AVAILABLE = False


requires_evernote_backup = unittest.skipUnless(
    EVERNOTE_BACKUP_AVAILABLE,
    "evernote-backup is not installed in this environment",
)


ENML_NOTE = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">'
    "<en-note><div>Rent is due on the first.</div></en-note>"
)


class _FakeOAuthHandler:
    """Stands in for the browser round trip, and only for that."""

    token = "S=s1:U=fake:E=fake:C=fake:P=fake:A=everfree:V=2:H=fakehash"
    declined = False

    def __init__(self, client, port, host):
        self.port = port

    def get_oauth_url(self):
        return f"https://www.evernote.com/OAuth.action?oauth_token=fake&port={self.port}"

    def wait_for_token(self):
        if type(self).declined:
            raise oauth_module.OAuthDeclinedError("declined")
        return type(self).token


class _FakeSyncClient:
    user = "everfree-test-user"


class _FakeNoteSynchronizer:
    """Writes the notes a real sync would have downloaded.

    `app` reassigns `_sync_chunks` and `_download_scheduled_notes` to report
    progress, so both are called here — that is what keeps the wizard's status
    strings under test rather than only the happy-path file output.
    """

    notebooks = ("Personal", "Work")
    notes_per_notebook = 2

    def __init__(self, note_client, note_storage_, *args):
        self.storage = note_storage_

    def _sync_chunks(self):
        return None

    def _download_scheduled_notes(self, notes_to_sync):
        return None

    def sync(self):
        self._sync_chunks()
        scheduled = []
        now_ms = int(time.time() * 1000)
        for nb_index, nb_name in enumerate(type(self).notebooks):
            nb_guid = f"nb-{nb_index}"
            self.storage.notebooks.add_notebooks(
                [Notebook(guid=nb_guid, name=nb_name, stack=None)]
            )
            for note_index in range(type(self).notes_per_notebook):
                guid = f"note-{nb_index}-{note_index}"
                scheduled.append(guid)
                self.storage.notes.add_note(
                    Note(
                        guid=guid,
                        title=f"{nb_name} note {note_index + 1}",
                        notebookGuid=nb_guid,
                        active=True,
                        content=ENML_NOTE,
                        created=now_ms,
                        updated=now_ms,
                        tagNames=[],
                    )
                )
        self._download_scheduled_notes(scheduled)


class EvernotePipelineTests(unittest.TestCase):
    """Run the real import with only the Evernote network faked."""

    def setUp(self):
        if not EVERNOTE_BACKUP_AVAILABLE:
            self.skipTest("evernote-backup is not installed")
        self._tmp = tempfile.TemporaryDirectory(prefix="everfree-evernote-")
        self._original_notes_dir = app.NOTES_DIR
        app.NOTES_DIR = Path(self._tmp.name) / "EverFree"

        self._patches = []
        self._patch(oauth_module, "EvernoteOAuthCallbackHandler", _FakeOAuthHandler)
        self._patch(oauth_module, "EvernoteOAuthClient", lambda **kw: object())
        self._patch(cli_app_util, "get_api_data", lambda backend, custom: ("key", "secret"))
        self._patch(cli_app, "get_sync_client", lambda **kw: _FakeSyncClient())
        self._patch(cli_app, "NoteSynchronizer", _FakeNoteSynchronizer)
        self._patch(app.webbrowser, "open", lambda url: True)
        _FakeOAuthHandler.declined = False

        app.evernote_auth_state.update({"status": "idle", "error": None, "detail": ""})

    def tearDown(self):
        for module, name, original in reversed(self._patches):
            setattr(module, name, original)
        app.NOTES_DIR = self._original_notes_dir
        self._tmp.cleanup()

    def _patch(self, module, name, replacement):
        self._patches.append((module, name, getattr(module, name)))
        setattr(module, name, replacement)

    # ── The import itself ───────────────────────────────────
    def test_first_run_import_writes_markdown_notebooks(self):
        if not shutil.which("evernote2md", path=app._get_subprocess_env()["PATH"]):
            self.skipTest("evernote2md is not installed (brew install evernote2md)")

        app._evernote_sync_pipeline()

        self.assertEqual(
            app.evernote_auth_state["status"],
            "done",
            app.evernote_auth_state.get("error"),
        )

        for notebook in _FakeNoteSynchronizer.notebooks:
            directory = app.NOTES_DIR / notebook
            self.assertTrue(directory.is_dir(), f"{notebook} was not imported")
            markdown = list(directory.rglob("*.md"))
            self.assertEqual(
                len(markdown),
                _FakeNoteSynchronizer.notes_per_notebook,
                f"{notebook} holds {[m.name for m in markdown]}",
            )
            self.assertIn("Rent is due on the first.", markdown[0].read_text(encoding="utf-8"))

        # The wizard's own "already imported" signal has to agree, or step 1
        # would offer the import again on the next launch.
        self.assertTrue(app._is_evernote_synced())

    def test_progress_reaches_the_user_at_every_stage(self):
        if not shutil.which("evernote2md", path=app._get_subprocess_env()["PATH"]):
            self.skipTest("evernote2md is not installed (brew install evernote2md)")

        app._evernote_sync_pipeline()

        steps = [entry["step"] for entry in app.evernote_auth_state["debug"]]
        for expected in (
            "evernote_oauth_open",
            "evernote_oauth_wait",
            "init_create_db",
            "sync_fetch_index",
            "sync_download_notes",
            "export_enex",
            "convert_markdown",
        ):
            self.assertIn(expected, steps, f"the wizard never reported '{expected}'")

    def test_declined_authorization_is_reported_not_swallowed(self):
        _FakeOAuthHandler.declined = True

        app._evernote_sync_pipeline()

        self.assertEqual(app.evernote_auth_state["status"], "error")
        self.assertIn("declined", app.evernote_auth_state["error"].lower())
        self.assertFalse(app.NOTES_DIR.exists(), "a failed import left a notes directory behind")

    def test_missing_converter_without_homebrew_fails_with_instructions(self):
        empty_bin = Path(self._tmp.name) / "empty-bin"
        empty_bin.mkdir()
        original_env = app._get_subprocess_env
        app._get_subprocess_env = lambda: {**os.environ, "PATH": str(empty_bin)}
        try:
            app._evernote_sync_pipeline()
        finally:
            app._get_subprocess_env = original_env

        self.assertEqual(app.evernote_auth_state["status"], "error")
        self.assertIn("Homebrew", app.evernote_auth_state["error"])


class EvernoteBackupContractTests(unittest.TestCase):
    """Pin the third-party API the pipeline calls.

    `_evernote_sync_pipeline` drives `evernote-backup`'s Python API rather than
    its CLI, so an upstream rename breaks the import at runtime, in the middle
    of a first run, with no compile-time warning.
    """

    @requires_evernote_backup
    def test_pipeline_entry_points_still_exist_with_matching_signatures(self):
        import inspect

        expected = {
            "get_sync_client": [
                "auth_token", "backend", "network_error_retry_count",
                "use_system_ssl_ca", "max_chunk_results", "is_jwt_needed",
            ],
            "initialize_storage": ["database_path", "force"],
            "get_storage": ["database_path"],
            "export": [
                "database", "single_notes", "include_trash", "no_export_date",
                "add_guid", "add_metadata", "overwrite", "notebooks", "tags",
                "output_path",
            ],
        }
        for name, parameters in expected.items():
            function = getattr(cli_app, name, None)
            self.assertIsNotNone(function, f"evernote-backup no longer exposes cli_app.{name}")
            self.assertEqual(
                list(inspect.signature(function).parameters),
                parameters,
                f"cli_app.{name} changed shape; the import call site needs updating",
            )

        for attribute in ("CURRENT_DB_VERSION", "NoteSynchronizer", "WrongAuthUserError",
                          "raise_on_existing_database", "raise_on_old_database_version"):
            self.assertTrue(hasattr(cli_app, attribute), f"cli_app.{attribute} is gone")

        # The progress-bar silencing patches these three by name; a rename
        # would resurface Click's "no context" crash on a real import.
        from evernote_backup import note_exporter, note_synchronizer

        for module in (cli_app_util, note_exporter, note_synchronizer):
            self.assertTrue(
                hasattr(module, "get_progress_output"),
                f"{module.__name__}.get_progress_output is gone",
            )

        self.assertTrue(
            hasattr(note_storage.NoteSynchronizer if hasattr(note_storage, "NoteSynchronizer")
                    else cli_app.NoteSynchronizer, "_sync_chunks"),
            "NoteSynchronizer._sync_chunks is gone; sync progress would go silent",
        )
        self.assertTrue(hasattr(cli_app.NoteSynchronizer, "_download_scheduled_notes"))


class ImportVisibilityTests(unittest.TestCase):
    """Where the import may and may not appear."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="everfree-visibility-")
        self._original_notes_dir = app.NOTES_DIR
        app.NOTES_DIR = Path(self._tmp.name)
        self.client = TestClient(app.app)

    def tearDown(self):
        app.NOTES_DIR = self._original_notes_dir
        self._tmp.cleanup()

    def _configure(self):
        """Make the notes directory look like a finished first run."""
        (app.NOTES_DIR / "Personal").mkdir(parents=True, exist_ok=True)
        (app.NOTES_DIR / "Personal" / "Note.md").write_text("# Note\n", encoding="utf-8")
        (app.NOTES_DIR / ".git").mkdir(exist_ok=True)

    # ── First run ───────────────────────────────────────────
    def test_setup_status_offers_the_import_on_a_first_run(self):
        payload = self.client.get("/api/setup/status").json()
        self.assertFalse(payload["configured"])
        self.assertFalse(payload["evernote_synced"])

    # ── After the first run ─────────────────────────────────
    def test_setup_status_stops_advertising_the_import_once_notes_exist(self):
        self._configure()
        payload = self.client.get("/api/setup/status").json()
        self.assertTrue(payload["configured"])
        self.assertTrue(payload["evernote_synced"])

    def test_import_stays_reachable_after_setup_completes(self):
        """A hidden step is fine; an unreachable one is not.

        Once the wizard hides step 1, the import is only recoverable if some
        route still serves it and the endpoint still answers. This is the
        check that separates "we cleaned up the UI" from "the feature is
        gone".
        """
        self._configure()

        served = self.client.get("/setup")
        self.assertEqual(served.status_code, 200)
        self.assertIn("btn-evernote-connect", served.text)

        status = self.client.get("/api/auth/evernote/status")
        self.assertEqual(status.status_code, 200)
        self.assertIn(status.json()["status"], {"idle", "running", "done", "error"})

        setup_js = (REPO_ROOT / "frontend" / "setup.js").read_text(encoding="utf-8")
        self.assertNotRegex(
            setup_js,
            r"data\.configured\s*\)\s*\{\s*\n\s*window\.location\.href\s*=\s*[\"']/[\"']",
            "setup.js bounces every configured install off /setup, so a user who "
            "skipped the Evernote import on day one can never get back to it",
        )

    # ── Platform scope ──────────────────────────────────────
    def test_browser_clients_carry_no_evernote_machinery(self):
        """Marketing copy may mention Evernote; running code may not.

        The import shells out to `evernote2md` and writes to the local disk,
        so a browser build that offered a button could only fail. The clients
        are checked for a working path, not for the word.
        """
        for relative in ("web/app.js", "web/index.html", "web/mobile/app.js",
                         "web/mobile/index.html"):
            source = (REPO_ROOT / relative).read_text(encoding="utf-8").lower()
            for marker in ("/api/auth/evernote", "btn-evernote", "evernote-idle",
                           "evernote-running", "import-tool-status"):
                self.assertNotIn(
                    marker,
                    source,
                    f"{relative} carries '{marker}', but the import needs a local "
                    f"binary and a local disk, so it cannot run in a browser",
                )

        # Client logic is held to the stricter rule: the word itself has no
        # business in code that only ever talks to the GitHub API.
        for relative in ("web/app.js", "web/mobile/app.js"):
            source = (REPO_ROOT / relative).read_text(encoding="utf-8").lower()
            self.assertNotIn("evernote", source, f"{relative} references Evernote")

    def test_import_endpoints_belong_to_the_desktop_server_only(self):
        vercel_functions = sorted(p.name for p in (REPO_ROOT / "web" / "api").rglob("*.js"))
        self.assertEqual(
            vercel_functions,
            ["chat.js", "device-poll.js", "device-start.js"],
            "a new deployed function appeared; the browser deployment must not "
            "gain an Evernote path",
        )
        for endpoint in ("/api/auth/evernote/start", "/api/auth/evernote/status"):
            self.assertNotEqual(self.client.get(endpoint).status_code, 404)


if __name__ == "__main__":
    unittest.main()
