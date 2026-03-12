# ExitNote

A minimal, Git-backed Markdown note-taking app for macOS — with an Evernote migration pipeline.

Notes are plain `.md` files organized in folders (notebooks) under `~/Documents/ExitNote`, automatically synced to a **private GitHub repository**.

---

## Quick Start (Development)

```bash
cd /Users/adityaganguli/tech/ExitNote

# 1. Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. (Optional) Create some sample data
mkdir -p ~/Documents/ExitNote/Welcome
echo "# Hello" > ~/Documents/ExitNote/Welcome/hello.md

# 4. Run the app — opens in your browser automatically
python run.py
```

The app runs at **http://localhost:52321** and auto-opens in your default browser.

---

## Git-Backed Sync

Every save, create, and delete auto-commits and pushes to GitHub. On startup, the server pulls the latest changes. To set up:

```bash
cd ~/Documents/ExitNote
git init
git remote add origin git@github.com:YOU/your-private-repo.git
git add . && git commit -m "init" && git push -u origin main
```

> ⚠️ Make sure your GitHub repo is **PRIVATE**.

---

## Evernote Migration

```bash
pip install evernote-backup
brew install evernote2md

chmod +x scripts/export_evernote.sh
./scripts/export_evernote.sh
```

Runs: `init-db` → `sync` → `export` → `evernote2md` → `git init` → `git push`.

---

## Build macOS `.dmg`

```bash
brew install create-dmg

chmod +x packaging/build_dmg.sh
./packaging/build_dmg.sh
```

Output: `dist/ExitNote.dmg`

---

## Project Structure

```
ExitNote/
├── scripts/export_evernote.sh    # Evernote → Markdown → Git pipeline
├── server/app.py                 # FastAPI backend (API + Git wrapper)
├── frontend/                     # Vanilla HTML/JS/CSS + EasyMDE
├── packaging/                    # py2app + create-dmg scripts
├── requirements.txt
├── run.py                        # App entry point
└── README.md
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `EXITNOTE_DIR` | `~/Documents/ExitNote` | Notes directory |
| `EXITNOTE_PORT` | `52321` | Server port |
