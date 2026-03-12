"""
ExitNote — FastAPI Backend (Git-Backed + OAuth Onboarding)

On startup:
  - If ~/Documents/ExitNote exists and is a git repo → boot normally
  - Otherwise → serve setup.html onboarding wizard

Setup wizard orchestrates Evernote OAuth → GitHub Device Flow → repo creation,
all without the user ever touching a terminal or pasting tokens.
"""

import os
import re
import shutil
import asyncio
import logging
import subprocess
import tempfile
import webbrowser
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ── Configuration ────────────────────────────────────────────
NOTES_DIR = Path(os.environ.get("EXITNOTE_DIR", Path.home() / "Documents" / "ExitNote"))
PORT = int(os.environ.get("EXITNOTE_PORT", 52321))
if os.environ.get("RESOURCEPATH"):
    FRONTEND_DIR = Path(os.environ["RESOURCEPATH"]) / "frontend"
else:
    FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

logger = logging.getLogger("exitnote")

# ── Shared state ─────────────────────────────────────────────
setup_progress = {
    "running": False,
    "step": "",
    "detail": "",
    "error": None,
    "complete": False,
}

github_auth_state = {
    "device_code": None,
    "user_code": None,
    "verification_uri": None,
    "interval": 5,
    "access_token": None,
    "username": None,
    "status": "idle",  # idle | pending | authorized | error
    "error": None,
}

evernote_auth_state = {
    "status": "idle",  # idle | running | done | error
    "detail": "",
    "error": None,
}


def _is_configured() -> bool:
    """ExitNote is fully set up: directory exists AND is a git repo."""
    return NOTES_DIR.is_dir() and (NOTES_DIR / ".git").is_dir()


def _get_subprocess_env() -> dict[str, str]:
    """
    Returns an environment dict with standard macOS paths appended.
    Crucial for py2app bundles, which lack the user's $PATH, to find
    tools like 'evernote-backup' or 'git' installed via Homebrew.
    """
    env = os.environ.copy()
    current_path = env.get("PATH", "")
    paths_to_add = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin"
    ]
    new_path_parts = current_path.split(os.pathsep) if current_path else []
    for p in paths_to_add:
        if p not in new_path_parts:
            new_path_parts.append(p)
    env["PATH"] = os.pathsep.join(new_path_parts)
    return env


# ── Git Helpers ──────────────────────────────────────────────
def _git(*args: str, check: bool = True, cwd: str | None = None) -> subprocess.CompletedProcess:
    env = _get_subprocess_env()
    git_bin = shutil.which("git", path=env["PATH"]) or "git"
    cmd = [git_bin, *args]
    logger.info("git %s", " ".join(args))
    return subprocess.run(
        cmd, cwd=cwd or str(NOTES_DIR), env=env,
        capture_output=True, text=True, check=check, timeout=60,
    )


def _is_git_repo() -> bool:
    return (NOTES_DIR / ".git").is_dir()


def git_pull():
    if not _is_git_repo():
        return True, "Not a git repo — skipping pull"
    try:
        result = _git("pull", "origin", "main", check=True)
        return True, result.stdout.strip() or "Up to date"
    except subprocess.CalledProcessError as e:
        return False, e.stderr.strip()


def git_push(message: str):
    if not _is_git_repo():
        return True, "Not a git repo — skipping push"
    try:
        _git("add", ".", check=True)
        status = _git("status", "--porcelain", check=True)
        if not status.stdout.strip():
            return True, "Nothing to commit"
        _git("commit", "-m", message, check=True)
        _git("push", "origin", "main", check=True)
        return True, "Pushed to GitHub"
    except subprocess.CalledProcessError as e:
        return False, e.stderr.strip()


def git_sync():
    ok, msg = git_pull()
    if not ok:
        return False, f"Pull failed: {msg}"
    ok, msg = git_push("Sync: manual sync from ExitNote")
    if not ok:
        return False, f"Push failed: {msg}"
    return True, "Synced successfully"


# ── Lifespan ─────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    if _is_git_repo():
        ok, msg = git_pull()
        logger.info("Startup pull: %s", msg if ok else f"FAILED: {msg}")

    async def _open_browser():
        await asyncio.sleep(0.5)
        webbrowser.open(f"http://localhost:{PORT}")

    asyncio.create_task(_open_browser())
    yield


app = FastAPI(title="ExitNote", version="4.0.0", lifespan=lifespan)


# ══════════════════════════════════════════════════════════════
#  GITHUB DEVICE FLOW OAUTH
# ══════════════════════════════════════════════════════════════

@app.post("/api/auth/github/start")
async def github_auth_start(request: Request):
    """
    Start the GitHub Device Flow.
    Requires: { "client_id": "Ox..." } from user's registered OAuth App.
    Returns the user_code and verification_uri for the user to authorize.
    """
    body = await request.json()
    client_id = body.get("client_id", "").strip()
    if not client_id:
        raise HTTPException(status_code=400, detail="GitHub OAuth App client_id is required")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://github.com/login/device/code",
            data={"client_id": client_id, "scope": "repo"},
            headers={"Accept": "application/json"},
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"GitHub API error: {resp.text}")

    data = resp.json()
    if "error" in data:
        raise HTTPException(status_code=400, detail=data.get("error_description", data["error"]))

    github_auth_state.update({
        "device_code": data["device_code"],
        "user_code": data["user_code"],
        "verification_uri": data.get("verification_uri", "https://github.com/login/device"),
        "interval": data.get("interval", 5),
        "access_token": None,
        "username": None,
        "status": "pending",
        "error": None,
        "client_id": client_id,
    })

    return {
        "user_code": data["user_code"],
        "verification_uri": data.get("verification_uri", "https://github.com/login/device"),
        "expires_in": data.get("expires_in", 900),
    }


@app.post("/api/auth/github/poll")
async def github_auth_poll():
    """
    Poll GitHub to check if the user has authorized the device.
    Call this repeatedly from the frontend until status is 'authorized' or 'error'.
    """
    if github_auth_state["status"] != "pending":
        return {
            "status": github_auth_state["status"],
            "username": github_auth_state.get("username"),
        }

    client_id = github_auth_state.get("client_id", "")
    device_code = github_auth_state["device_code"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            data={
                "client_id": client_id,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json"},
        )

    data = resp.json()

    if "access_token" in data:
        token = data["access_token"]
        # Fetch username
        async with httpx.AsyncClient() as client:
            user_resp = await client.get(
                "https://api.github.com/user",
                headers={"Authorization": f"token {token}"},
            )
        username = user_resp.json().get("login", "unknown") if user_resp.status_code == 200 else "unknown"

        github_auth_state.update({
            "access_token": token,
            "username": username,
            "status": "authorized",
        })
        return {"status": "authorized", "username": username}

    error = data.get("error", "")
    if error == "authorization_pending":
        return {"status": "pending"}
    elif error == "slow_down":
        github_auth_state["interval"] = data.get("interval", github_auth_state["interval"] + 5)
        return {"status": "pending", "slow_down": True}
    elif error == "expired_token":
        github_auth_state["status"] = "error"
        github_auth_state["error"] = "Authorization expired. Please try again."
        return {"status": "error", "detail": "Authorization expired"}
    elif error == "access_denied":
        github_auth_state["status"] = "error"
        github_auth_state["error"] = "Access denied by user."
        return {"status": "error", "detail": "Access denied"}
    else:
        github_auth_state["status"] = "error"
        github_auth_state["error"] = data.get("error_description", error)
        return {"status": "error", "detail": github_auth_state["error"]}


@app.get("/api/auth/github/status")
async def github_auth_status():
    return {
        "status": github_auth_state["status"],
        "username": github_auth_state.get("username"),
        "user_code": github_auth_state.get("user_code"),
    }


# ══════════════════════════════════════════════════════════════
#  EVERNOTE AUTH (via evernote-backup's built-in OAuth)
# ══════════════════════════════════════════════════════════════

@app.post("/api/auth/evernote/start")
async def evernote_auth_start():
    """
    Start the Evernote sync process. evernote-backup handles OAuth
    by opening the user's browser automatically.
    """
    if evernote_auth_state["status"] == "running":
        return {"status": "running", "detail": "Already running"}

    evernote_auth_state.update({"status": "running", "detail": "Starting...", "error": None})

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _evernote_sync_pipeline)

    return {"status": "started"}


def _evernote_sync_pipeline():
    """Run evernote-backup init + sync + export + convert in background."""
    global evernote_auth_state
    try:
        tmp_dir = tempfile.mkdtemp(prefix="exitnote_en_")
        db_path = os.path.join(tmp_dir, "en_backup.db")
        enex_dir = os.path.join(tmp_dir, "enex_export")

        env = _get_subprocess_env()
        evernote_backup_bin = shutil.which("evernote-backup", path=env["PATH"])
        evernote2md_bin = shutil.which("evernote2md", path=env["PATH"])

        if not evernote_backup_bin:
            raise FileNotFoundError("evernote-backup is not installed or not found in PATH")
        if not evernote2md_bin:
            raise FileNotFoundError("evernote2md is not installed or not found in PATH")

        evernote_auth_state["detail"] = "Initializing database..."
        subprocess.run(
            [evernote_backup_bin, "init-db", "--database", db_path],
            cwd=tmp_dir, env=env, check=True, capture_output=True, text=True,
        )

        evernote_auth_state["detail"] = "Authenticating & syncing (check your browser)..."
        # evernote-backup sync will open the browser for OAuth automatically
        subprocess.run(
            [evernote_backup_bin, "sync", "--database", db_path],
            cwd=tmp_dir, env=env, check=True, capture_output=True, text=True, timeout=600,
        )

        evernote_auth_state["detail"] = "Exporting .enex files..."
        os.makedirs(enex_dir, exist_ok=True)
        subprocess.run(
            [evernote_backup_bin, "export", "--database", db_path, enex_dir],
            cwd=tmp_dir, env=env, check=True, capture_output=True, text=True,
        )

        evernote_auth_state["detail"] = "Converting to Markdown..."
        NOTES_DIR.mkdir(parents=True, exist_ok=True)
        enex_files = list(Path(enex_dir).glob("*.enex"))
        for i, enex_file in enumerate(enex_files, 1):
            notebook_name = enex_file.stem
            notebook_dir = NOTES_DIR / notebook_name
            notebook_dir.mkdir(parents=True, exist_ok=True)
            evernote_auth_state["detail"] = f"Converting {notebook_name} ({i}/{len(enex_files)})..."
            subprocess.run(
                [evernote2md_bin, str(enex_file), str(notebook_dir)],
                env=env, check=True, capture_output=True, text=True,
            )

        shutil.rmtree(tmp_dir, ignore_errors=True)
        evernote_auth_state.update({"status": "done", "detail": f"Imported {len(enex_files)} notebook(s)"})

    except subprocess.CalledProcessError as e:
        evernote_auth_state.update({
            "status": "error",
            "error": f"{' '.join(e.cmd)}: {e.stderr}",
        })
    except Exception as e:
        evernote_auth_state.update({"status": "error", "error": str(e)})


@app.get("/api/auth/evernote/status")
async def evernote_auth_status():
    return evernote_auth_state


# ══════════════════════════════════════════════════════════════
#  SETUP PIPELINE (repo creation + git init)
# ══════════════════════════════════════════════════════════════

@app.get("/api/setup/status")
async def get_setup_status():
    return {"configured": _is_configured(), "notes_dir": str(NOTES_DIR)}


@app.get("/api/setup/progress")
async def get_setup_progress():
    return setup_progress


@app.post("/api/setup/run")
async def run_setup(request: Request):
    """
    Final setup step: create GitHub repo + git init + push.
    Uses the access_token from the Device Flow (already stored in github_auth_state).
    """
    if setup_progress["running"]:
        raise HTTPException(status_code=409, detail="Setup is already running")
    if _is_configured():
        raise HTTPException(status_code=409, detail="Already configured")

    body = await request.json()
    repo_name = body.get("repo_name", "").strip()

    if not repo_name:
        raise HTTPException(status_code=400, detail="Repository name is required")
    if not re.match(r'^[a-zA-Z0-9._-]+$', repo_name):
        raise HTTPException(status_code=400, detail="Invalid repository name")

    token = github_auth_state.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="GitHub not authenticated. Please sign in first.")

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _setup_repo_pipeline, token, repo_name)

    return {"status": "started"}


def _update_progress(step: str, detail: str = ""):
    setup_progress["step"] = step
    setup_progress["detail"] = detail
    setup_progress["error"] = None
    logger.info("Setup [%s]: %s", step, detail)


def _setup_repo_pipeline(token: str, repo_name: str):
    """Create GitHub repo + git init + push. Runs in background thread."""
    global setup_progress
    setup_progress = {"running": True, "step": "", "detail": "", "error": None, "complete": False}

    try:
        NOTES_DIR.mkdir(parents=True, exist_ok=True)

        # Create welcome notebook if empty
        notebooks = [d for d in NOTES_DIR.iterdir() if d.is_dir() and not d.name.startswith(".")]
        if not notebooks:
            welcome_dir = NOTES_DIR / "Welcome"
            welcome_dir.mkdir(parents=True, exist_ok=True)
            (welcome_dir / "Getting Started.md").write_text(
                "# Getting Started\n\nWelcome to **ExitNote**! 🎉\n\n"
                "- **Edit** notes with the Markdown editor\n"
                "- **Create** notebooks and notes from the sidebar\n"
                "- **Sync** automatically to GitHub on every save\n\n"
                "Happy writing!\n",
                encoding="utf-8",
            )

        # ── Create private GitHub repo ───────────────────────
        _update_progress("github_create", f"Creating private repo '{repo_name}'...")
        owner = github_auth_state.get("username", "unknown")

        with httpx.Client(timeout=30) as client:
            resp = client.post(
                "https://api.github.com/user/repos",
                headers={
                    "Authorization": f"token {token}",
                    "Accept": "application/vnd.github.v3+json",
                },
                json={
                    "name": repo_name,
                    "private": True,
                    "description": "ExitNote — Git-backed Markdown notes",
                    "auto_init": False,
                },
            )
            if resp.status_code == 201:
                repo_data = resp.json()
                owner = repo_data["owner"]["login"]
            elif resp.status_code == 422:
                _update_progress("github_create", "Repo already exists, using it...")
            else:
                raise RuntimeError(f"GitHub API error {resp.status_code}: {resp.text}")

        clone_url = f"https://github.com/{owner}/{repo_name}.git"
        auth_url = clone_url.replace("https://", f"https://{token}@")

        # ── Git init + push ──────────────────────────────────
        _update_progress("git_init", "Initializing Git repository...")
        (NOTES_DIR / ".gitignore").write_text(".DS_Store\n*.swp\n*.swo\n*~\n", encoding="utf-8")

        _git("init", cwd=str(NOTES_DIR))
        _git("branch", "-M", "main", cwd=str(NOTES_DIR))
        _git("remote", "add", "origin", auth_url, cwd=str(NOTES_DIR), check=False)
        _git("remote", "set-url", "origin", auth_url, cwd=str(NOTES_DIR), check=False)

        _update_progress("git_push", "Pushing notes to GitHub...")
        _git("add", ".", cwd=str(NOTES_DIR))
        _git("commit", "-m", "Initial import from ExitNote", cwd=str(NOTES_DIR))
        _git("push", "-u", "origin", "main", cwd=str(NOTES_DIR))

        _update_progress("complete", "All set! Redirecting...")
        setup_progress["complete"] = True

    except subprocess.CalledProcessError as e:
        setup_progress["error"] = f"Command failed: {' '.join(e.cmd)}\n{e.stderr}"
        setup_progress["running"] = False
    except Exception as e:
        setup_progress["error"] = str(e)
        setup_progress["running"] = False


# ══════════════════════════════════════════════════════════════
#  ROUTING
# ══════════════════════════════════════════════════════════════

@app.get("/")
async def root():
    if _is_configured():
        return HTMLResponse((FRONTEND_DIR / "index.html").read_text(encoding="utf-8"))
    else:
        return HTMLResponse((FRONTEND_DIR / "setup.html").read_text(encoding="utf-8"))


# ── Helpers ──────────────────────────────────────────────────
def _safe_notebook_path(name: str) -> Path:
    resolved = (NOTES_DIR / name).resolve()
    if not str(resolved).startswith(str(NOTES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid notebook name")
    return resolved


def _safe_note_path(notebook: str, note: str) -> Path:
    nb_path = _safe_notebook_path(notebook)
    resolved = (nb_path / note).resolve()
    if not str(resolved).startswith(str(nb_path.resolve())):
        raise HTTPException(status_code=400, detail="Invalid note name")
    return resolved


# ── API: Sync ────────────────────────────────────────────────
@app.post("/api/sync")
async def manual_sync():
    ok, msg = git_sync()
    if not ok:
        raise HTTPException(status_code=409, detail=msg)
    return {"status": "synced", "message": msg}


@app.get("/api/sync/status")
async def sync_status():
    if not _is_git_repo():
        return {"git": False, "message": "Not a git repository"}
    try:
        result = _git("remote", "get-url", "origin", check=False)
        remote = result.stdout.strip() if result.returncode == 0 else None
        return {"git": True, "remote": remote}
    except Exception:
        return {"git": True, "remote": None}


# ── API: Notebooks ───────────────────────────────────────────
@app.get("/api/notebooks")
async def list_notebooks():
    if not NOTES_DIR.exists():
        return []
    return sorted(d.name for d in NOTES_DIR.iterdir() if d.is_dir() and not d.name.startswith("."))


@app.post("/api/notebooks")
async def create_notebook(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Notebook name is required")
    nb_path = _safe_notebook_path(name)
    if nb_path.exists():
        raise HTTPException(status_code=409, detail="Notebook already exists")
    nb_path.mkdir(parents=True)
    (nb_path / ".gitkeep").touch()
    ok, msg = git_push(f"New notebook: {name}")
    if not ok:
        raise HTTPException(status_code=409, detail=f"Git conflict: {msg}")
    return {"status": "created", "name": name, "git": msg}


# ── API: Notes ───────────────────────────────────────────────
@app.get("/api/notebooks/{notebook}/notes")
async def list_notes(notebook: str):
    nb_path = _safe_notebook_path(notebook)
    if not nb_path.exists():
        raise HTTPException(status_code=404, detail="Notebook not found")
    return sorted(f.name for f in nb_path.iterdir() if f.is_file() and f.suffix == ".md")


@app.get("/api/notebooks/{notebook}/notes/{note}")
async def read_note(notebook: str, note: str):
    note_path = _safe_note_path(notebook, note)
    if not note_path.exists():
        raise HTTPException(status_code=404, detail="Note not found")
    return {"notebook": notebook, "note": note, "content": note_path.read_text(encoding="utf-8")}


@app.put("/api/notebooks/{notebook}/notes/{note}")
async def update_note(notebook: str, note: str, request: Request):
    note_path = _safe_note_path(notebook, note)
    nb_path = _safe_notebook_path(notebook)
    if not nb_path.exists():
        raise HTTPException(status_code=404, detail="Notebook not found")
    body = await request.json()
    note_path.write_text(body.get("content", ""), encoding="utf-8")
    ok, msg = git_push(f"Auto-save: {note.replace('.md', '')}")
    if not ok:
        raise HTTPException(status_code=409, detail=f"Git conflict: {msg}")
    return {"status": "saved", "notebook": notebook, "note": note, "git": msg}


@app.post("/api/notebooks/{notebook}/notes")
async def create_note(notebook: str, request: Request):
    nb_path = _safe_notebook_path(notebook)
    if not nb_path.exists():
        raise HTTPException(status_code=404, detail="Notebook not found")
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Note name is required")
    if not name.endswith(".md"):
        name += ".md"
    note_path = _safe_note_path(notebook, name)
    if note_path.exists():
        raise HTTPException(status_code=409, detail="Note already exists")
    note_path.write_text(f"# {name[:-3]}\n", encoding="utf-8")
    ok, msg = git_push(f"New note: {name.replace('.md', '')}")
    if not ok:
        raise HTTPException(status_code=409, detail=f"Git conflict: {msg}")
    return {"status": "created", "notebook": notebook, "note": name, "git": msg}


@app.delete("/api/notebooks/{notebook}/notes/{note}")
async def delete_note(notebook: str, note: str):
    note_path = _safe_note_path(notebook, note)
    if not note_path.exists():
        raise HTTPException(status_code=404, detail="Note not found")
    note_path.unlink()
    ok, msg = git_push(f"Deleted: {note.replace('.md', '')}")
    if not ok:
        raise HTTPException(status_code=409, detail=f"Git conflict: {msg}")
    return {"status": "deleted", "notebook": notebook, "note": note, "git": msg}


# ── Static assets ────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
