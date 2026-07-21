# EverFree project memory

Read [`docs/adr/0001-github-auth-and-credential-storage.md`](docs/adr/0001-github-auth-and-credential-storage.md)
before changing auth, setup, sync, or GitHub repository behavior.

EverFree is intentionally locked to the signed-in user's private
`everfree-notes` repository. It uses the existing GitHub OAuth App Device Flow
with the `repo` scope (GitHub has no single-repository OAuth scope). Desktop credentials are stored through the operating-system
credential vault; Git remotes must remain credential-free. Do not reintroduce a
repo picker, custom repo names, plaintext token files, token-bearing remotes,
or persistent browser token storage.
