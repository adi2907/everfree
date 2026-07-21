from __future__ import annotations

import unittest

from server.github_auth import (
    ACCESS_TOKEN_ACCOUNT,
    KEYRING_SERVICE,
    CredentialStoreError,
    RepositoryAccessError,
    SecureCredentialStore,
    add_git_http_auth,
    clean_everfree_remote,
    metadata_without_secrets,
    validate_repository,
)


class _FakeBackend:
    priority = 1


class _FakeKeyring:
    def __init__(self):
        self.values = {}

    def get_keyring(self):
        return _FakeBackend()

    def get_password(self, service, account):
        return self.values.get((service, account))

    def set_password(self, service, account, password):
        self.values[(service, account)] = password

    def delete_password(self, service, account):
        self.values.pop((service, account), None)


class GitHubAuthSecurityTests(unittest.TestCase):
    def test_legacy_token_remote_is_cleaned(self):
        remote = "https://gho_legacy-secret@github.com/octocat/everfree-notes.git"
        self.assertEqual(
            clean_everfree_remote(remote),
            "https://github.com/octocat/everfree-notes.git",
        )

    def test_non_everfree_remote_is_rejected(self):
        with self.assertRaises(RepositoryAccessError):
            clean_everfree_remote("https://github.com/octocat/private-notes.git")

    def test_repository_object_must_match_fixed_owner_and_name(self):
        validate_repository({"full_name": "octocat/everfree-notes"}, "octocat")
        with self.assertRaises(RepositoryAccessError):
            validate_repository({"full_name": "someone-else/everfree-notes"}, "octocat")

    def test_secure_store_accepts_only_github_oauth_tokens(self):
        backend = _FakeKeyring()
        store = SecureCredentialStore(backend)
        store.save("gho_access")
        self.assertEqual(
            backend.values[(KEYRING_SERVICE, ACCESS_TOKEN_ACCOUNT)],
            "gho_access",
        )
        with self.assertRaises(CredentialStoreError):
            store.save("ghu_app-token")

    def test_git_auth_is_ephemeral_environment_configuration(self):
        original = {"PATH": "/usr/bin"}
        configured = add_git_http_auth(original, "gho_access")
        self.assertNotIn("GIT_CONFIG_COUNT", original)
        self.assertEqual(configured["GIT_CONFIG_COUNT"], "1")
        self.assertEqual(
            configured["GIT_CONFIG_KEY_0"],
            "http.https://github.com/.extraHeader",
        )
        self.assertNotIn("ghu_access", configured["GIT_CONFIG_VALUE_0"])
        self.assertEqual(configured["GIT_TRACE_REDACT"], "1")

    def test_plaintext_tokens_are_removed_from_metadata(self):
        cleaned = metadata_without_secrets({
            "auth_type": "github_oauth_device",
            "username": "octocat",
            "repository": "everfree-notes",
            "access_token": "secret",
            "refresh_token": "secret",
        })
        self.assertNotIn("access_token", cleaned)
        self.assertNotIn("refresh_token", cleaned)
        self.assertEqual(cleaned["repository"], "everfree-notes")


if __name__ == "__main__":
    unittest.main()
