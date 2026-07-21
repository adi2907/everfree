# EverFree agent notes

Before changing authentication, onboarding, sync, or repository selection, read
[`docs/adr/0001-github-auth-and-credential-storage.md`](docs/adr/0001-github-auth-and-credential-storage.md).

The following are product invariants, not defaults:

- EverFree uses exactly one private repository owned by the signed-in user:
  `everfree-notes`. Do not add a repository picker, alternate name, or fallback
  to a similarly described repository.
- GitHub authentication is the existing OAuth App Device Flow with `repo`.
  GitHub has no single-repository OAuth scope, so application code must enforce
  use of only `<user>/everfree-notes`.
- Never put a GitHub token in a Git remote, URL, command argument, log, plaintext
  file, or browser `localStorage`.
- Desktop tokens belong in the OS credential vault through `keyring`. Web/mobile
  tokens are short-lived and tab-scoped in `sessionStorage`.
