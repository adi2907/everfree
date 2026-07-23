# ADR 0001: GitHub auth and credential storage

- Status: accepted
- Date: 2026-07-21
- Amended: 2026-07-23 (browser token storage — see "Credential handling")

## Decision

EverFree keeps the existing device-code user experience and authenticates with
the existing GitHub OAuth App. The only supported workspace is the signed-in
user's private `<user>/everfree-notes` repository.

GitHub's OAuth `repo` scope is broader than one repository because GitHub has
no single-repository OAuth scope. EverFree still checks every repository object
and Git remote against the fixed invariant, and never enumerates, reads, or
writes another repository. A repository picker and custom repository names are
intentionally unsupported.

The OAuth App requests the existing `repo` permission so it can create and sync
the private notes repository. This broad grant is documented as a limitation.

## Credential handling

Desktop access and refresh tokens are stored through Python `keyring`:

- macOS: Keychain
- Windows: Credential Locker
- Linux desktop: Secret Service or KWallet, depending on the installed backend

Only non-secret metadata (username, fixed repo, repository ID, and expiry
timestamps) is written to `~/.everfree_auth.json`, with mode `0600`. Legacy
plaintext OAuth tokens in that file are removed and are not migrated because
their permissions are broader. Legacy token-bearing Git remotes are rewritten
to clean HTTPS URLs before any network operation.

Git receives its access token through an ephemeral per-process HTTP
authorization header. The token is not placed in `.git/config`, a command-line
argument, or an EverFree log.

Linux servers/headless sessions often have no unlocked Secret Service or
KWallet. EverFree fails closed and asks the user to configure a secure keyring;
it does not fall back to a plaintext file. Windows/Linux desktop packaging must
test the appropriate backend before those platforms are advertised.

The web and mobile clients keep the OAuth access token in `localStorage`, so a
session ends only at an explicit sign out.

This supersedes the tab-scoped `sessionStorage` decision (commit `5759c38`,
2026-07-21), which was reversed on 2026-07-23. Two reasons:

1. It did not deliver what it promised. EverFree's OAuth App issues
   non-expiring `gho_` tokens, so GitHub omits `expires_in` from the device-flow
   response. The client computed `Date.now() + NaN`, and its start-up guard read
   a falsy expiry as *expired*, signing the user out on **every** page load —
   including a reload in the same tab. Expiry is now only enforced when GitHub
   actually advertises one; `0` means "no expiry advertised".
2. Its security benefit is narrower than it appears. The clients call
   `api.github.com` directly, so the token must sit in page memory whenever the
   app is open. Against XSS during an active session the two stores are
   equivalent; `sessionStorage` only shortens the window for an attacker
   reading storage at rest, and it does so by charging a full device-flow
   re-login on every browser start.

The residual risk is real: a token at rest in `localStorage` is readable by any
XSS on the origin, and it carries the broad `repo` scope. The accepted
mitigation is that sign-out clears it (along with the cached note metadata), and
that EverFree ships no third-party scripts on the app origin.

The durable fix remains the one previously noted: move the token into an
encrypted server-side session behind an HttpOnly, Secure, SameSite cookie. Done
properly that also means proxying GitHub API calls, since a token the page can
read is a token XSS can read. That adds hosted auth state, a GitHub API proxy,
and per-request latency, and has not been built.

## Rejected alternatives

- OAuth App with `repo` scope: one-step device flow, but grants broad private
  repository access and cannot be constrained to `everfree-notes`.
- Authorization-code OAuth in the desktop app: a public/distributed client
  cannot safely keep the required client secret. PKCE does not remove GitHub's
  client-secret requirement for OAuth App token exchange.
- Fine-grained personal access token: repository-scoped, but requires manual
  token creation/copying and creates poor onboarding and rotation behavior.
- SSH deploy key: repository-scoped and useful for a self-hosted mode, but adds
  key lifecycle/recovery complexity and does not expire automatically.
- Git Credential Manager: reasonable for a developer/self-hosted workflow, but
  is an additional system dependency and has no universal secure-store default
  on Linux. EverFree's packaged desktop app uses `keyring` directly.

## References

- [GitHub OAuth authorization](https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps)
- [Python keyring](https://keyring.readthedocs.io/en/latest/)
