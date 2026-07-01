# EverFree

I had to pay $100 for an Evernote renewal.

For my notes.

No way.

So I built EverFree.

It started as a way to get my notes out of Evernote. It grew into an AI
writing IDE. Think Cursor for writing.

Open a note. Select a paragraph. Ask the assistant to rewrite it. Ask it to
continue. Ask it to research a claim. Ask it to generate an image. Stay in the
flow.

Since this is a writing app, AI should sit next to the draft. It should help
while you still know what you meant.

EverFree is completely free and open source. The Mac app ships as a signed and
notarized DMG.

## Links

- Web app: [everfree.vercel.app](https://everfree.vercel.app)
- Mobile app: [everfree.vercel.app/mobile](https://everfree.vercel.app/mobile/)
- Mac DMG: [EverFree.dmg](https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg)
- Source code: [github.com/adi2907/everfree](https://github.com/adi2907/everfree)
- License: [MIT](LICENSE)

## What You Can Do With It

EverFree gives you:

- A writing editor for notes, drafts, and research.
- An AI assistant inside the editor.
- Evernote sync through the Mac app.
- Web, mobile, and Mac access.
- GitHub-backed sync.
- Local files you can inspect and move.

The assistant can:

- Continue a draft.
- Rewrite selected text.
- Summarize a note.
- Search the web.
- Read related notes.
- Generate images.
- Create new notes.

## AI setup

Bring your own OpenRouter key or Gemini key.

The desktop app supports:

- LM Studio
- OpenRouter
- Gemini

The web app supports:

- OpenRouter
- Gemini

Image generation uses Gemini first. It can fall back to OpenRouter.

Web search uses a Serper API key.

Keys are configured in the assistant settings. In the web app, keys stay in the
browser and are sent only for the request being made.

## Evernote Sync

Evernote sync starts in the Mac app.

The setup flow is:

1. Install the Mac DMG.
2. Launch EverFree.
3. Allow Documents folder access.
4. Connect Evernote.
5. Connect GitHub.
6. Import and sync.

After that, the same workspace opens on Mac, web, and mobile.

The default local folder is:

```text
~/Documents/EverFree
```

The default GitHub repo is:

```text
everfree-notes
```

## Mac App

Download:

```text
https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg
```

The app runs a local server at:

```text
http://127.0.0.1:52321
```

If that port is busy, EverFree uses the next open local port.

The app stores notes locally, imports Evernote, and syncs through GitHub.

## Evernote Import Requirements

The DMG bundles the Python app and its Python dependencies.

Evernote conversion also needs `evernote2md`.

Install it with:

```bash
brew install evernote2md
```

The setup wizard checks for this tool. If Homebrew is available, EverFree can
install it after you approve the action.

## Web and mobile

The web app runs on Vercel.

It signs in with GitHub and edits the same workspace through the GitHub
Contents API.

The mobile app is a browser client. It is useful for capture, reading, and
light editing.

Mobile is served from:

```text
/mobile/
```

## Sync Model

EverFree uses GitHub for sync.

Desktop saves changes locally, commits them, and pushes them.

On startup, the desktop server pulls the latest changes.

Web and mobile edit through GitHub OAuth and the GitHub Contents API.

Keep the workspace repo private.

The files are Markdown under the hood. You rarely need to care.

## Development

Create a local environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run the desktop app:

```bash
python run.py
```

Open:

```text
http://127.0.0.1:52321
```

Useful environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `EVERFREE_DIR` | `~/Documents/EverFree` | Local workspace folder |
| `EVERFREE_PORT` | `52321` | Desktop server port |
| `EVERFREE_EVERNOTE_OAUTH_PORT` | `10500` | Evernote OAuth callback port |

## Build the DMG

Install the DMG tool:

```bash
brew install create-dmg
```

Build a local DMG:

```bash
./packaging/build_dmg.sh
```

Build a release DMG:

```bash
./packaging/build_dmg.sh --release
```

Output:

```text
dist/EverFree.app
dist/EverFree.dmg
```

The release build signs the app, submits the DMG for notarization, staples the
ticket, and validates the result.

The build script creates `.build-venv` from scratch each time.

## Deploy the web app

The Vercel app root is:

```text
web/
```

Manual production deploy:

```bash
cd web
vercel --prod
```

If Vercel is connected to GitHub, deploy from the connected branch:

```bash
git push origin main
```

## Project Layout

```text
EverFree/
  server/             FastAPI backend and agent routes
  frontend/           Desktop editor served by the local app
  web/                Vercel web and mobile clients
  web/api/github/     GitHub device-flow endpoints
  web/mobile/         Mobile browser client
  packaging/          py2app and DMG build scripts
  scripts/            Helper scripts
  requirements.txt    Python dependencies
  run.py              Desktop entry point
```

## Local Checks

```bash
python3 -m py_compile run.py server/app.py server/agent.py packaging/setup_py2app.py
node --check frontend/app.js
node --check frontend/setup.js
node --check frontend/assist.js
node --check web/app.js
node --check web/mobile/app.js
git diff --check
```

## Contributing

EverFree is open source.

Contributions are welcome for the editor, assistant, importers, sync,
packaging, tests, and docs.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Credits

EverFree uses:

- `evernote-backup` for Evernote auth, sync, and ENEX export.
- `evernote2md` for ENEX to Markdown conversion.
