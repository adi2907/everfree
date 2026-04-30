# Contributing to EverFree

EverFree is an open-source notes app focused on user-owned data, local Markdown
files, and private GitHub-backed sync.

## Contribution Rules

- Keep user data ownership central. Features should preserve local Markdown and
  user-controlled GitHub storage.
- Do not introduce a hosted database for notes unless it is optional and clearly
  separated from the default Git-backed model.
- Keep the default repository private and scoped to the user's own GitHub
  account.
- Do not commit secrets, tokens, personal backups, generated DMGs, or local
  virtual environments.
- Prefer small, reviewable changes with clear behavior and tests/checks.
- Preserve the desktop-first Evernote import flow unless adding another import
  path.
- Keep mobile and web behavior aligned with the desktop data model.
- Treat migration code carefully: avoid destructive deletes or irreversible
  transforms without explicit user confirmation.

## Development Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Open:

```text
http://127.0.0.1:52321
```

## Checks Before Opening a PR

Run the checks relevant to the files you changed:

```bash
python3 -m py_compile run.py server/app.py packaging/setup_py2app.py
node --check frontend/app.js
node --check frontend/setup.js
node --check web/app.js
node --check web/mobile/app.js
git diff --check
```

For DMG-related changes, also run:

```bash
./packaging/build_dmg.sh
hdiutil verify dist/EverFree.dmg
codesign --verify --deep --strict --verbose=2 dist/EverFree.app
```

## Pull Request Guidelines

- Explain the user-facing problem and the behavior after the change.
- Include screenshots or screen recordings for UI changes.
- Mention any migration, sync, OAuth, filesystem, or signing/notarization risks.
- Do not bundle unrelated refactors with feature work.
- Update `README.md` when setup, deployment, packaging, or user flow changes.
