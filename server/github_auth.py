"""Security-sensitive GitHub authentication helpers for EverFree.

This module intentionally contains no HTTP or application state. Keeping the
credential and remote-validation rules here makes them easy to test without
starting the FastAPI application.
"""

from __future__ import annotations

import base64
import os
import re
from urllib.parse import urlsplit


REPOSITORY_NAME = "everfree-notes"
DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liunA4WFlhQQO9KG"
KEYRING_SERVICE = "com.everfree.app.github"
ACCESS_TOKEN_ACCOUNT = "github-oauth-access-token"
LEGACY_ACCESS_TOKEN_ACCOUNT = "github-app-access-token"
LEGACY_REFRESH_TOKEN_ACCOUNT = "github-app-refresh-token"


class CredentialStoreError(RuntimeError):
    """Raised when the platform has no usable secure credential store."""


class RepositoryAccessError(RuntimeError):
    """Raised when a GitHub resource is not the fixed EverFree repository."""


class SecureCredentialStore:
    """Store GitHub tokens in the operating system's credential vault.

    ``keyring`` maps this to macOS Keychain, Windows Credential Locker, and a
    desktop secret service such as Secret Service/KWallet on Linux. Tokens are
    never deliberately persisted to an EverFree-owned plaintext file.
    """

    def __init__(self, keyring_module=None):
        self._keyring_module = keyring_module

    def _keyring(self):
        if self._keyring_module is not None:
            return self._keyring_module
        try:
            import keyring
        except ImportError as exc:  # pragma: no cover - packaging failure
            raise CredentialStoreError(
                "Secure credential storage is unavailable. Install the 'keyring' package."
            ) from exc
        self._keyring_module = keyring
        return keyring

    def ensure_available(self) -> str:
        keyring = self._keyring()
        try:
            backend = keyring.get_keyring()
            priority = float(getattr(backend, "priority", 0))
        except Exception as exc:
            raise CredentialStoreError(
                "The operating system credential store could not be opened."
            ) from exc
        if priority <= 0:
            raise CredentialStoreError(
                "No secure operating system credential store is available."
            )
        return f"{backend.__class__.__module__}.{backend.__class__.__name__}"

    def get_access_token(self) -> str | None:
        return self._get(ACCESS_TOKEN_ACCOUNT)

    def save(self, access_token: str) -> None:
        self.ensure_available()
        if not access_token.startswith("gho_"):
            raise CredentialStoreError(
                "GitHub returned an unexpected OAuth token type; refusing to store it."
            )
        keyring = self._keyring()
        try:
            keyring.set_password(KEYRING_SERVICE, ACCESS_TOKEN_ACCOUNT, access_token)
        except Exception as exc:
            raise CredentialStoreError(
                "GitHub credentials could not be saved in the operating system credential store."
            ) from exc

    def clear(self) -> None:
        keyring = self._keyring()
        for account in (
            ACCESS_TOKEN_ACCOUNT,
            LEGACY_ACCESS_TOKEN_ACCOUNT,
            LEGACY_REFRESH_TOKEN_ACCOUNT,
        ):
            try:
                keyring.delete_password(KEYRING_SERVICE, account)
            except Exception:
                # Missing credentials and an unavailable backend both leave no
                # EverFree plaintext credential behind, which is the invariant.
                pass

    def _get(self, account: str) -> str | None:
        self.ensure_available()
        try:
            return self._keyring().get_password(KEYRING_SERVICE, account)
        except Exception as exc:
            raise CredentialStoreError(
                "GitHub credentials could not be read from the operating system credential store."
            ) from exc


def github_oauth_client_id() -> str:
    """Return the public client ID for EverFree's OAuth App."""
    return os.environ.get(
        "EVERFREE_GITHUB_CLIENT_ID",
        DEFAULT_GITHUB_OAUTH_CLIENT_ID,
    ).strip()


def require_github_oauth_client_id() -> str:
    client_id = github_oauth_client_id()
    if not client_id:
        raise RuntimeError(
            "EverFree's GitHub OAuth App is not configured. Set EVERFREE_GITHUB_CLIENT_ID."
        )
    return client_id


def expected_repository_full_name(owner: str) -> str:
    if not owner or "/" in owner:
        raise RepositoryAccessError("Invalid GitHub account name.")
    return f"{owner}/{REPOSITORY_NAME}"


def validate_repository(repo: dict, owner: str) -> None:
    """Reject any API repository object outside ``owner/everfree-notes``."""
    expected = expected_repository_full_name(owner).lower()
    full_name = str(repo.get("full_name") or "").lower()
    if full_name != expected:
        raise RepositoryAccessError(
            f"EverFree only supports {expected_repository_full_name(owner)}."
        )


_SCP_GITHUB_REMOTE = re.compile(
    r"^(?:[^@\s]+@)?github\.com:(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?$",
    re.IGNORECASE,
)


def github_remote_repository(remote_url: str) -> tuple[str, str]:
    """Extract ``(owner, repo)`` from supported GitHub HTTPS/SSH remotes."""
    value = remote_url.strip()
    scp_match = _SCP_GITHUB_REMOTE.match(value)
    if scp_match:
        return scp_match.group("owner"), scp_match.group("repo")

    parsed = urlsplit(value)
    if (parsed.hostname or "").lower() != "github.com":
        raise RepositoryAccessError("EverFree sync requires a github.com repository.")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        raise RepositoryAccessError("The GitHub remote must identify one repository.")
    owner, repo = parts
    if repo.lower().endswith(".git"):
        repo = repo[:-4]
    return owner, repo


def credential_free_github_remote(remote_url: str) -> str:
    """Return a credential-free HTTPS URL without changing the repository."""
    owner, repo = github_remote_repository(remote_url)
    return f"https://github.com/{owner}/{repo}.git"


def clean_everfree_remote(remote_url: str) -> str:
    """Return a credential-free HTTPS URL for the fixed EverFree repository."""
    owner, repo = github_remote_repository(remote_url)
    if repo.lower() != REPOSITORY_NAME:
        raise RepositoryAccessError(
            f"EverFree refuses to sync repository '{repo}'; only {REPOSITORY_NAME} is allowed."
        )
    return f"https://github.com/{owner}/{REPOSITORY_NAME}.git"


def clean_clone_url(owner: str) -> str:
    return clean_everfree_remote(f"https://github.com/{owner}/{REPOSITORY_NAME}.git")


def add_git_http_auth(env: dict[str, str], token: str) -> dict[str, str]:
    """Add an ephemeral GitHub auth header to a child Git process environment."""
    if not token.startswith("gho_"):
        raise CredentialStoreError(
            "EverFree requires a GitHub OAuth token for Git synchronization."
        )
    result = dict(env)
    try:
        index = int(result.get("GIT_CONFIG_COUNT", "0"))
    except ValueError:
        index = 0
    basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
    result["GIT_CONFIG_COUNT"] = str(index + 1)
    result[f"GIT_CONFIG_KEY_{index}"] = "http.https://github.com/.extraHeader"
    result[f"GIT_CONFIG_VALUE_{index}"] = f"Authorization: Basic {basic}"
    result["GIT_TERMINAL_PROMPT"] = "0"
    result["GIT_TRACE_REDACT"] = "1"
    return result


def auth_metadata_is_current(data: dict) -> bool:
    return (
        data.get("auth_type") == "github_oauth_device"
        and data.get("repository") == REPOSITORY_NAME
        and bool(data.get("username"))
    )


def metadata_without_secrets(data: dict) -> dict:
    """Keep only non-secret fields when migrating the legacy auth file."""
    allowed = {
        "auth_type",
        "username",
        "repository",
        "repository_id",
    }
    return {key: data[key] for key in allowed if key in data}
