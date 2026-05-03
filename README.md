# EverFree

EverFree helps you leave expensive note-taking apps without losing control of
your notes. It imports your notes into Markdown, syncs them to **your private
GitHub repository**, and lets you access them from web, mobile, and the native
Mac app.

Use the hosted app at [everfree.vercel.app](https://everfree.vercel.app). If
you are already signed in, it opens your notes. If not, it shows the public
landing page and lets you connect GitHub.

## Quick Links

- **Hosted web and mobile app:** [everfree.vercel.app](https://everfree.vercel.app)
- **Download Mac DMG:** [EverFree.dmg](https://github.com/adi2907/everfree/releases/download/v1.0.0/EverFree.dmg)
- **Self-host or inspect the code:** [github.com/adi2907/everfree](https://github.com/adi2907/everfree)
- **Default notes repo:** `everfree-notes` in your own GitHub account

## Why EverFree

- **Always free:** no subscription wall just to access your own notes.
- **Your data is yours:** notes are plain Markdown files that you can clone,
  inspect, export, or move.
- **Your GitHub is the backend:** EverFree creates or reuses a private
  `everfree-notes` repo under your GitHub profile. There is no hosted EverFree
  database holding your notes.
- **Web, mobile, and native Mac:** use the hosted browser app, mobile web app,
  and the fully featured macOS app against the same GitHub-backed notes.
- **Easy migration:** the Mac app imports Evernote, converts notes to Markdown,
  stores them locally in `~/Documents/EverFree`, and pushes the backup to your
  private GitHub repository.
- **Self-hostable:** deploy the web client yourself or run the local app from
  source if you want full control over the stack.

## Current Product Shape

- **Desktop DMG:** signed macOS app that runs a local FastAPI server, stores
  notes as Markdown, imports Evernote, and syncs to GitHub.
- **Web client:** hosted on Vercel at
  [everfree.vercel.app](https://everfree.vercel.app), signs in with GitHub,
  auto-connects to the user's EverFree repo, and edits notes through the GitHub
  Contents API.
- **Mobile client:** browser-based mobile UI at
  [everfree.vercel.app/mobile/](https://everfree.vercel.app/mobile/), using the
  same GitHub login and repo.
- **Repository:** the canonical default repo is `everfree-notes`.

## Important Flow

For a user migrating from Evernote, the desktop app is the first step.

1. Install the EverFree DMG on macOS.
2. Launch EverFree and allow access to the Documents folder.
3. Import Evernote through the setup wizard.
4. Connect GitHub.
5. EverFree creates or reuses the private `everfree-notes` repo and pushes the
   imported Markdown notes to your GitHub profile.
6. After that, the same notes are available from desktop, web, and mobile.

The web and mobile clients can create/use the GitHub repo and edit notes, but
they cannot run the Evernote import pipeline because browsers cannot access the
local Evernote data or run local conversion tools.

## Desktop App

The desktop app starts a local server at:

```text
http://127.0.0.1:52321
```

If that port is occupied, the launcher falls back to the next available local
port. `52321` remains the default.

Notes live here by default:

```text
~/Documents/EverFree
```

The macOS permission prompt for Documents access is expected on first launch.

## Evernote Import Requirements

The DMG bundles the Python app and Python dependencies, including
`evernote-backup`.

One external converter is still required:

```bash
brew install evernote2md
```

The setup wizard checks for `evernote2md`. If Homebrew is available, the app can
install `evernote2md` after the user explicitly clicks the install button.

## Development

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

Useful environment variables:

| Variable | Default | Description |
|---|---:|---|
| `EVERFREE_DIR` | `~/Documents/EverFree` | Local notes directory |
| `EVERFREE_PORT` | `52321` | Fixed local server port |
| `EVERFREE_EVERNOTE_OAUTH_PORT` | `10500` | Local Evernote OAuth callback port |

## Build The DMG

Prerequisite:

```bash
brew install create-dmg
```

Build:

```bash
./packaging/build_dmg.sh
```

Output:

```text
dist/EverFree.app
dist/EverFree.dmg
```

The build script creates a fresh `.build-venv`, installs dependencies, packages
the app with `py2app`, and creates the DMG with `create-dmg`.

## Distribution

Do not commit the DMG to the repository. Publish it as a release asset, for
example on GitHub Releases, and link to that download from the web app and this
README.

Current public DMG:

```text
https://github.com/adi2907/everfree/releases/download/v1.0.0/EverFree.dmg
```

Public macOS releases should be signed with an Apple Developer ID Application
certificate and notarized by Apple before distribution.

## Vercel Deployment

The Vercel app root is `web/`.

Manual production deploy:

```bash
cd web
vercel --prod
```

If the Vercel project is connected to GitHub, pushing to the connected branch
should deploy automatically:

```bash
git push origin main
```

Mobile is served at:

```text
/mobile/
```

## GitHub Sync

Desktop saves, creates, and deletes auto-commit and push to GitHub. On startup,
the desktop server pulls the latest changes.

Web and mobile edit the same repository using GitHub OAuth and the GitHub
Contents API.

Keep the notes repo private.

## Search

Desktop, web, and mobile support simple keyword search across note titles,
notebook names, and Markdown content.

## Roadmap

Proposed next steps:

- Add import support for paid or lock-in note apps first, starting with
  Evernote and then apps like Notion, Craft, Bear, and Roam Research.
- Add export/interoperability support for Markdown-first tools like Obsidian and
  Joplin so users can move their notes anywhere.
- Improve conflict handling with a clear in-app resolution UI instead of
  requiring terminal-based Git recovery.
- Add attachment handling for images, PDFs, and Evernote resources.
- Add offline-first behavior for the web and mobile clients with queued sync.
- Add tags, backlinks, and richer Markdown navigation while keeping files
  portable.
- Add full-text indexing for faster search on large note collections.
- Ship signed and notarized macOS releases, then add auto-update support.
- Explore Windows and Linux desktop builds after the macOS release is stable.
- Add export tools so users can leave EverFree with plain Markdown and assets at
  any time.
- Add a public plugin/importer interface for community-maintained connectors.

## Contributing

EverFree is open source. Contributions are welcome for importers, sync
reliability, UI, packaging, documentation, and tests.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

EverFree is released under the [MIT License](LICENSE).

## Project Structure

```text
EverFree/
├── server/                  # FastAPI backend and setup/import pipeline
├── frontend/                # Desktop browser UI served by the local app
├── web/                     # Vercel-hosted web and mobile clients
│   ├── api/github/          # GitHub device-flow proxy endpoints
│   └── mobile/              # Mobile browser client
├── packaging/               # py2app, DMG build script, macOS icon
├── scripts/                 # Legacy/manual helper scripts
├── CONTRIBUTING.md
├── LICENSE
├── requirements.txt
├── run.py                   # Desktop app entry point
└── README.md
```

## Local Checks

```bash
python3 -m py_compile run.py server/app.py packaging/setup_py2app.py
node --check frontend/app.js
node --check frontend/setup.js
node --check web/app.js
node --check web/mobile/app.js
git diff --check
```

## Credits

EverFree builds on open-source migration tools:

- `evernote-backup` for Evernote authentication, sync, and ENEX export.
- `evernote2md` for converting exported ENEX files into Markdown.
