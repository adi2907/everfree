# EverFree project memory

Read [`docs/adr/0001-github-auth-and-credential-storage.md`](docs/adr/0001-github-auth-and-credential-storage.md)
before changing auth, setup, sync, or GitHub repository behavior.

EverFree is intentionally locked to the signed-in user's private
`everfree-notes` repository. It uses the existing GitHub OAuth App Device Flow
with the `repo` scope (GitHub has no single-repository OAuth scope). Desktop credentials are stored through the operating-system
credential vault; Git remotes must remain credential-free. Do not reintroduce a
repo picker, custom repo names, plaintext token files, or token-bearing remotes.

The browser clients deliberately keep their OAuth token in `localStorage`, so a
session survives a browser or system restart and ends only at an explicit sign
out. This reverses the tab-scoped `sessionStorage` rule that commit `5759c38`
introduced; do not switch it back without raising it first. ADR 0001 records the
trade and the cookie-based alternative that would replace it.
