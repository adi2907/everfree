# EverFree

I had to pay $100 for an Evernote renewal. For my notes. No way.

EverFree started as a script to get my notes out of Evernote, and grew into
the writing tool I actually wanted: an editor where an AI assistant sits next
to the draft — rewriting a paragraph, continuing where I stalled, checking a
claim — while the notes themselves stay plain Markdown files in a repo I own.
Think Cursor, but for writing.

It's free, MIT-licensed, and the Mac app ships as a signed and notarized DMG.

## Links

- Web app: [everfree.vercel.app](https://everfree.vercel.app)
- Mobile app: [everfree.vercel.app/mobile](https://everfree.vercel.app/mobile/)
- Mac DMG: [EverFree.dmg](https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg)
- Source code: [github.com/adi2907/everfree](https://github.com/adi2907/everfree)
- License: [MIT](LICENSE)

## What it is

EverFree is a three-pane note editor — notebooks, notes, and a real writing
surface — with an AI assistant wired into it the way Cursor is wired into
code. The assistant reads the note you have open, and when you select a
passage and press ⌘L, that exact excerpt becomes the context for your next
message. From there you can ask it to continue a stalled draft, rewrite a
section, summarize the note, search the web and read pages before answering,
generate an image with `/image`, or create a new note entirely.

The same workspace is available three ways: a Mac app that works on local
files, a web editor at [everfree.vercel.app](https://everfree.vercel.app), and
a lightweight mobile client for capture and reading. All three edit the same
notes, synced through a GitHub repository you own.

## Setting up the AI

The editor works without any AI configuration. When you want the assistant,
bring your own key: the desktop app supports LM Studio (fully local, no key
needed), OpenRouter, and Gemini; the web app supports OpenRouter and Gemini.
Web search needs a free [Serper](https://serper.dev) key — without it the
assistant can't check the web. Image generation uses your Gemini key first
and falls back to OpenRouter.

Keys are entered in the assistant settings. In the web app they are stored
only in your browser and sent only with the request being made — nothing is
retained server-side.

## Getting started on the Mac

Download the [DMG](https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg)
and open it. The app is signed and notarized, so there are no Gatekeeper
workarounds. On first launch, a setup wizard walks you through the rest:

1. Allow access to your Documents folder.
2. Connect Evernote (optional) to import your old notebooks as Markdown.
3. Connect GitHub so your workspace syncs.

Notes live locally in `~/Documents/EverFree`, and the default sync repo is
called `everfree-notes`. The app runs a local server at
`http://127.0.0.1:52321`; if that port is busy it takes the next open one.

One caveat on Evernote import: the conversion step needs `evernote2md`, which
isn't bundled in the DMG. Install it with `brew install evernote2md`, or let
the setup wizard install it for you if Homebrew is available — it will ask
first.

## The web and mobile editors

The web app runs on Vercel. It signs in with GitHub (a one-time device code,
no password) and edits the same workspace through the GitHub Contents API, so
there is no EverFree account and no EverFree database holding your notes.

The mobile client at [/mobile/](https://everfree.vercel.app/mobile/) is a
browser app built for capture, reading, and light edits — useful when a
thought arrives and the laptop is elsewhere.

## How sync works

GitHub is the sync layer. The desktop app saves changes locally, commits
them, and pushes; on startup it pulls whatever changed elsewhere. The web and
mobile editors commit directly through the GitHub API. Keep the workspace
repo private — it's your notes.

Under the hood everything is Markdown files in ordinary folders. You rarely
need to care, but it means that if this project disappeared tomorrow, your
notes would still be sitting in your repo as plain files you can open
anywhere.

## Development

Create a local environment and run the desktop app:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Then open `http://127.0.0.1:52321`.

Useful environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `EVERFREE_DIR` | `~/Documents/EverFree` | Local workspace folder |
| `EVERFREE_PORT` | `52321` | Desktop server port |
| `EVERFREE_EVERNOTE_OAUTH_PORT` | `10500` | Evernote OAuth callback port |

Before opening a pull request, these quick checks catch most mistakes:

```bash
python3 -m py_compile run.py server/app.py server/agent.py packaging/setup_py2app.py
node --check frontend/app.js
node --check frontend/setup.js
node --check frontend/assist.js
node --check web/app.js
node --check web/mobile/app.js
git diff --check
```

## Building the DMG

The build depends on `create-dmg`:

```bash
brew install create-dmg
```

Build a local DMG with `./packaging/build_dmg.sh`, or a release build with
`./packaging/build_dmg.sh --release`. Both produce:

```text
dist/EverFree.app
dist/EverFree.dmg
```

The release build signs the app, submits the DMG for notarization, staples
the ticket, and validates the result. The script creates `.build-venv` from
scratch on every run, so a clean machine works fine.

## Deploying the web app

The Vercel project root is `web/` — deploy from inside that directory, not
the repo root:

```bash
cd web
vercel --prod
```

If Vercel is connected to GitHub, pushing to `main` deploys automatically.

## Project layout

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

## Contributing

Contributions are welcome — the editor, the assistant, importers, sync,
packaging, tests, and docs all have room to grow. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Credits

EverFree stands on two excellent tools: `evernote-backup` for Evernote auth,
sync, and ENEX export, and `evernote2md` for converting ENEX to Markdown.
