# ExitNote

A rebellion against $100/year note-taking subscriptions.

Note-taking should be simple: basic notebooks, markdown, and code editors. There is no reason to pay a massive annual fee for software that is essentially doing something free.

ExitNote is a 100% free, end-to-end Evernote alternative. It keeps all your data local and uses a private GitHub repository as your database.

The Ecosystem:

- **Desktop:** A macOS `.dmg` app that reads/writes local `.md` files and silently auto-syncs to GitHub.
- **Web:** A Chrome Extension that edits your GitHub notes directly from the browser (no hosting required).
- **Mobile:** Access your data via any Git-backed mobile app (e.g., GitJournal).

## 🚀 Quick Start (Development)

Notes are plain `.md` files organized in folders (notebooks) under `~/Documents/ExitNote`.

```bash
# 1. Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run the app
python run.py
```

The app runs at [http://localhost:52321](http://localhost:52321) and auto-opens in your default browser.

## 📦 Evernote Migration & Setup

ExitNote has a built-in onboarding wizard, but you can also run the migration manually.

```bash
pip install evernote-backup
brew install evernote2md

chmod +x scripts/export_evernote.sh
./scripts/export_evernote.sh
```

Runs: `init-db` → `sync` → `export` → `evernote2md` → `git init` → `git push`.

## 🔄 Git-Backed Sync

Every save, create, and delete auto-commits and pushes to GitHub. On startup, the server pulls the latest changes. If setting up manually:

```bash
cd ~/Documents/ExitNote
git init
git remote add origin git@github.com:YOU/your-private-repo.git
git add . && git commit -m "init" && git push -u origin main
```

⚠️ Make sure your GitHub repo is **PRIVATE**.

## 🍏 Build macOS `.dmg`

To package the app for distribution to other users:

```bash
brew install create-dmg

chmod +x packaging/build_dmg.sh
./packaging/build_dmg.sh
```

Output: `dist/ExitNote.dmg`

## 📂 Project Structure

```text
ExitNote/
├── scripts/export_evernote.sh    # Evernote → Markdown → Git pipeline
├── server/app.py                 # FastAPI backend (API + Git wrapper)
├── frontend/                     # Vanilla HTML/JS/CSS + EasyMDE
├── packaging/                    # py2app + create-dmg scripts
├── requirements.txt
├── run.py                        # App entry point
└── README.md
```

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `EXITNOTE_DIR` | `~/Documents/ExitNote` | Notes directory |
| `EXITNOTE_PORT` | `52321` | Server port |

## 🤝 Contributing

This is an open-source alternative to SaaS monopolies. We want people to contribute and help build a completely different, community-driven note-taking ecosystem. Pull requests for the Python backend, UI, and Chrome extension are welcome!
