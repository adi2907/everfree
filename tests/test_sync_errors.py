"""Sync fault classification.

A stalled backup that reports itself as "retrying" or "offline" is worse than
one that reports nothing, because the user stops looking. These tests pin the
boundary between faults that time will fix and faults that only the user can.
"""

import os
import subprocess
import unittest
from unittest import mock

os.environ.setdefault("EVERFREE_DIR", "/tmp/everfree-tests-notes")

import server.app as app


RATE_LIMITED_403 = (
    "remote: You have exceeded a secondary rate limit. "
    "Please wait a few minutes before you try again.\n"
    "fatal: unable to access 'https://github.com/octocat/everfree-notes.git/': "
    "The requested URL returned error: 403"
)


def _completed(returncode: int = 0, stdout: str = "", stderr: str = ""):
    return subprocess.CompletedProcess(
        args=["git"], returncode=returncode, stdout=stdout, stderr=stderr,
    )


class FakeGit:
    """Stands in for `_git`, replying per subcommand.

    `push_stderr` makes the push fail; everything else answers the way a clean
    repo with one unpushed commit would.
    """

    def __init__(self, *, push_stderr: str | None = None, ahead: int = 1, dirty: bool = False):
        self.push_stderr = push_stderr
        self.ahead = ahead
        self.dirty = dirty
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args: str, check: bool = True, cwd: str | None = None):
        self.calls.append(args)
        command = args[0]
        if command == "status":
            return _completed(stdout=" M note.md\n" if self.dirty else "")
        if command == "rev-list":
            return _completed(stdout=f"{self.ahead}\n")
        if command == "remote":
            return _completed(stdout="https://github.com/octocat/everfree-notes.git\n")
        if command == "push" and self.push_stderr:
            return _completed(returncode=1, stderr=self.push_stderr)
        return _completed()

    def ran(self, command: str) -> bool:
        return any(call[0] == command for call in self.calls)


class GitFailureClassificationTests(unittest.TestCase):
    def test_rejected_credentials_are_not_reported_as_offline(self):
        # GitHub answers a revoked token with an HTTP 403 whose text also
        # contains "unable to access", which the network test matches. If the
        # auth check does not run first, a dead token reads as a lost network
        # and the user waits for a reconnection that changes nothing.
        stderr = (
            "fatal: unable to access 'https://github.com/octocat/everfree-notes.git/': "
            "The requested URL returned error: 403"
        )
        self.assertTrue(app._is_network_error(stderr))
        self.assertTrue(app._is_auth_error(stderr))

        action, message = app._classify_git_failure(stderr)
        self.assertEqual(action, "reauth")
        self.assertIn("Sign in again", message)

    def test_authentication_failure_asks_for_sign_in(self):
        stderr = (
            "remote: Invalid username or token. Password authentication is not supported.\n"
            "fatal: Authentication failed for 'https://github.com/octocat/everfree-notes.git/'"
        )
        action, _ = app._classify_git_failure(stderr)
        self.assertEqual(action, "reauth")

    def test_missing_repository_points_at_the_remote(self):
        stderr = (
            "remote: Repository not found.\n"
            "fatal: repository 'https://github.com/octocat/everfree-notes.git/' not found"
        )
        action, message = app._classify_git_failure(stderr)
        self.assertEqual(action, "remote")
        self.assertIn(app.REPOSITORY_NAME, message)

    def test_genuine_network_loss_stays_transient(self):
        stderr = "fatal: unable to access: Could not resolve host: github.com"
        self.assertIsNone(app._classify_git_failure(stderr))
        self.assertTrue(app._is_network_error(stderr))

    def test_unrecognised_failure_is_not_treated_as_terminal(self):
        # Anything we cannot positively identify keeps retrying rather than
        # dead-ending the user on a guess.
        self.assertIsNone(app._classify_git_failure("error: failed to push some refs"))


class BlockedStateTests(unittest.TestCase):
    def setUp(self):
        self._original = dict(app.sync_state)

    def tearDown(self):
        with app._sync_lock:
            app.sync_state.clear()
            app.sync_state.update(self._original)

    def test_blocked_state_carries_the_reason_and_the_fix(self):
        app._set_sync_blocked("reauth", "GitHub rejected the saved sign-in.")
        self.assertTrue(app._sync_is_blocked())
        self.assertEqual(app.sync_state["action"], "reauth")
        self.assertIn("rejected", app.sync_state["detail"])
        # Blocked is a fault we can describe, not a lost connection.
        self.assertTrue(app.sync_state["online"])

    def test_detail_is_bounded_so_git_output_cannot_flood_the_banner(self):
        app._set_sync_blocked("remote", "x" * 900)
        self.assertLessEqual(len(app.sync_state["detail"]), 300)

    def test_blocked_state_is_not_sticky_once_a_cycle_succeeds(self):
        app._set_sync_blocked("reauth", "GitHub rejected the saved sign-in.")
        # The success path clears the action alongside the status.
        with app._sync_lock:
            app.sync_state.update({"status": "idle", "action": None, "detail": "Synced to GitHub"})
        self.assertFalse(app._sync_is_blocked())
        self.assertIsNone(app.sync_state["action"])


class RateLimitClassificationTests(unittest.TestCase):
    """GitHub answers a secondary rate limit with the same 403 a revoked token
    gets. Reading that as an auth fault blocks sync and tells the user to sign
    in again, which cannot help — the throttle clears on its own."""

    def test_secondary_rate_limit_is_not_terminal(self):
        self.assertTrue(app._is_rate_limit_error(RATE_LIMITED_403))
        # The 403 needle still matches; the ordering is what saves us.
        self.assertTrue(app._is_auth_error(RATE_LIMITED_403))
        self.assertIsNone(app._classify_git_failure(RATE_LIMITED_403))

    def test_429_and_abuse_wording_are_recognised(self):
        for stderr in (
            "fatal: unable to access '…': The requested URL returned error: 429",
            "remote: You have triggered an abuse detection mechanism.",
            "remote: API rate limit exceeded for user ID 1234.",
            "error: RPC failed; HTTP 403 — retry-after: 60",
        ):
            with self.subTest(stderr=stderr):
                self.assertTrue(app._is_rate_limit_error(stderr))
                self.assertIsNone(app._classify_git_failure(stderr))

    def test_a_real_credential_rejection_is_still_terminal(self):
        # The rate-limit check must not swallow genuine auth faults.
        stderr = (
            "fatal: unable to access 'https://github.com/octocat/everfree-notes.git/': "
            "The requested URL returned error: 403"
        )
        self.assertFalse(app._is_rate_limit_error(stderr))
        action, _ = app._classify_git_failure(stderr)
        self.assertEqual(action, "reauth")


class _OneShotEvent:
    """A `_sync_wanted` stand-in whose wait() returns a fixed value."""

    def __init__(self, triggered: bool):
        self.triggered = triggered

    def wait(self, timeout=None):
        return self.triggered

    def clear(self):
        pass

    def set(self):
        pass

    def is_set(self):
        return self.triggered


class _StopAfterFirstCycle:
    """A `_sync_stop` stand-in that reads as set once the fake git has been
    touched, so `_sync_worker_loop` runs one cycle and exits. The check counter
    is a backstop against hanging the suite if no cycle ever runs."""

    def __init__(self, fake: "FakeGit"):
        self.fake = fake
        self.checks = 0

    def is_set(self):
        self.checks += 1
        return bool(self.fake.calls) or self.checks > 10

    def set(self):
        self.checks = 99


class SyncStateHarness(unittest.TestCase):
    def setUp(self):
        self._original = dict(app.sync_state)
        for event in (app._push_failed, app._sync_wanted, app._sync_now):
            event.clear()
            self.addCleanup(event.clear)

    def tearDown(self):
        with app._sync_lock:
            app.sync_state.clear()
            app.sync_state.update(self._original)

    def run_cycle(self, fake: "FakeGit", **kwargs):
        with mock.patch.object(app, "_git", fake), \
             mock.patch.object(app, "_is_git_repo", return_value=True):
            app._sync_cycle(**kwargs)

    def run_worker_pass(self, fake: "FakeGit", *, triggered: bool):
        """One iteration of `_sync_worker_loop`: `triggered` picks the explicit
        sync branch over the periodic background pull."""
        with mock.patch.object(app, "_git", fake), \
             mock.patch.object(app, "_is_git_repo", return_value=True), \
             mock.patch.object(app, "_sync_wanted", _OneShotEvent(triggered)), \
             mock.patch.object(app, "_sync_stop", _StopAfterFirstCycle(fake)):
            app._sync_worker_loop()


class RateLimitedPushTests(SyncStateHarness):
    def test_rate_limited_push_does_not_block_sync(self):
        self.run_cycle(FakeGit(push_stderr=RATE_LIMITED_403), push=True)

        self.assertFalse(app._sync_is_blocked())
        self.assertIsNone(app.sync_state["action"])
        # The commit is still ours to deliver, and the UI says so.
        self.assertTrue(app.sync_state["pending"])

    def test_rejected_token_still_blocks(self):
        fake = FakeGit(push_stderr="fatal: Authentication failed for 'https://github.com/'")
        self.run_cycle(fake, push=True)
        self.assertTrue(app._sync_is_blocked())
        self.assertEqual(app.sync_state["action"], "reauth")


class PushRetryOnNextSaveTests(SyncStateHarness):
    """The bug: only an explicit user sync ever pushed, so a commit left behind
    by a failed push sat locally until someone noticed."""

    def test_a_save_after_a_failed_push_triggers_a_push(self):
        self.run_cycle(FakeGit(push_stderr=RATE_LIMITED_403), push=True)
        self.assertTrue(app._push_failed.is_set())

        # An ordinary save — not an explicit sync — now wakes the worker.
        app.request_sync()
        self.assertTrue(app._sync_wanted.is_set())
        self.assertTrue(app._sync_now.is_set())

        # And that wake-up lands on the branch that pushes.
        fake = FakeGit()
        self.run_worker_pass(fake, triggered=True)
        self.assertTrue(fake.ran("push"))
        self.assertFalse(app._push_failed.is_set())
        self.assertFalse(app.sync_state["pending"])

    def test_a_failed_push_reports_no_error_only_pending(self):
        # A save that failed to reach GitHub is not worth an error banner; the
        # pending marker already says the note is not backed up.
        self.run_cycle(FakeGit(push_stderr=RATE_LIMITED_403), push=True)
        self.assertEqual(app.sync_state["status"], "idle")
        self.assertTrue(app.sync_state["online"])
        self.assertTrue(app.sync_state["pending"])

    def test_an_ordinary_save_stays_local_when_nothing_failed(self):
        app.request_sync()
        self.assertTrue(app.sync_state["pending"])
        self.assertFalse(app._sync_wanted.is_set())
        self.assertFalse(app._sync_now.is_set())

    def test_background_cycles_still_never_push_or_commit_local_edits(self):
        # The periodic pull is unchanged: edits the user has not asked to save
        # stay dirty in the working tree, and nothing goes out.
        fake = FakeGit(dirty=True)
        self.run_worker_pass(fake, triggered=False)
        self.assertFalse(fake.ran("push"))
        self.assertFalse(fake.ran("commit"))
        self.assertTrue(app.sync_state["pending"])

    def test_a_successful_push_clears_the_flag(self):
        self.run_cycle(FakeGit(push_stderr=RATE_LIMITED_403), push=True)
        self.run_cycle(FakeGit(), push=True)
        self.assertFalse(app._push_failed.is_set())
        self.assertFalse(app.sync_state["pending"])


if __name__ == "__main__":
    unittest.main()
