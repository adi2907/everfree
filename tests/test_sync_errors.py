"""Sync fault classification.

A stalled backup that reports itself as "retrying" or "offline" is worse than
one that reports nothing, because the user stops looking. These tests pin the
boundary between faults that time will fix and faults that only the user can.
"""

import os
import unittest

os.environ.setdefault("EVERFREE_DIR", "/tmp/everfree-tests-notes")

import server.app as app


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


if __name__ == "__main__":
    unittest.main()
