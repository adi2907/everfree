"""
EverFree — FastAPI Backend (Git-Backed + OAuth Onboarding)

On startup:
  - If ~/Documents/EverFree exists and is a git repo → boot normally
  - Otherwise → serve setup.html onboarding wizard

Setup wizard orchestrates Evernote OAuth → GitHub OAuth → repo creation,
all without the user ever touching a terminal or pasting tokens.
"""

import os
import re
import sys
import secrets
import shutil
import asyncio
import logging
import subprocess
import tempfile
import webbrowser
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ── Configuration ────────────────────────────────────────────
NOTES_DIR = Path(os.environ.get("EVERFREE_DIR", Path.home() / "Documents" / "EverFree"))
PORT = int(os.environ.get("EVERFREE_PORT", 52321))
GITHUB_CLIENT_ID = os.environ.get("EVERFREE_GITHUB_CLIENT_ID", "Ov23liunA4WFlhQQO9KG")
GITHUB_REQUEST_TIMEOUT = float(os.environ.get("EVERFREE_GITHUB_REQUEST_TIMEOUT", 20))
EVERNOTE_SYNC_TIMEOUT = int(os.environ.get("EVERFREE_EVERNOTE_SYNC_TIMEOUT", 3600))
EVERNOTE_SYNC_MAX_DOWNLOAD_WORKERS = int(
    os.environ.get("EVERFREE_EVERNOTE_SYNC_MAX_DOWNLOAD_WORKERS", 10)
)
if os.environ.get("RESOURCEPATH"):
    FRONTEND_DIR = Path(os.environ["RESOURCEPATH"]) / "frontend"
else:
    FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

logger = logging.getLogger("everfree")

AUTH_FILE = Path.home() / ".everfree_auth.json"

# ── Shared state ─────────────────────────────────────────────
setup_progress = {
    "running": False,
    "step": "",
    "detail": "",
    "error": None,
    "complete": False,
}

github_auth_state = {
    "access_token": None,
    "username": None,
    "status": "idle",  # idle | pending | authorized | error
    "error": None,
    "user_code": None,
    "verification_uri": None,
}

# Restore a previously saved GitHub token so restarts don't lose auth
def _load_saved_auth() -> None:
    try:
        if AUTH_FILE.exists():
            import json
            data = json.loads(AUTH_FILE.read_text())
            if data.get("access_token") and data.get("username"):
                github_auth_state.update({
                    "access_token": data["access_token"],
                    "username": data["username"],
                    "status": "authorized",
                })
    except Exception:
        pass

def _save_auth() -> None:
    try:
        import json
        AUTH_FILE.write_text(json.dumps({
            "access_token": github_auth_state["access_token"],
            "username": github_auth_state["username"],
        }))
        AUTH_FILE.chmod(0o600)
    except Exception:
        pass

_load_saved_auth()

evernote_auth_state = {
    "status": "idle",  # idle | running | done | error
    "detail": "",
    "error": None,
}

import_tool_install_state = {
    "running": False,
    "detail": "",
    "error": None,
}


def _is_configured() -> bool:
    """EverFree is fully set up: directory exists AND is a git repo."""
    return NOTES_DIR.is_dir() and (NOTES_DIR / ".git").is_dir()


def _is_evernote_synced() -> bool:
    """Notes have already been imported from Evernote (dir exists with content)."""
    return NOTES_DIR.is_dir() and any(NOTES_DIR.iterdir())


def _has_local_note_content() -> bool:
    """Local notes exist beyond generated metadata files."""
    if not NOTES_DIR.is_dir():
        return False
    ignored = {".git", ".gitignore", ".DS_Store"}
    return any(item.name not in ignored for item in NOTES_DIR.iterdir())


def _clone_existing_repo(auth_url: str) -> None:
    """Clone an existing notes repo into NOTES_DIR when this Mac has no notes yet."""
    if _is_git_repo():
        _git("pull", "--ff-only", cwd=str(NOTES_DIR))
        return

    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    for item in list(NOTES_DIR.iterdir()):
        if item.name == ".DS_Store":
            item.unlink()

    if any(NOTES_DIR.iterdir()):
        raise RuntimeError(
            f"Cannot clone existing notes repo because {NOTES_DIR} is not empty."
        )

    NOTES_DIR.rmdir()
    _git("clone", auth_url, str(NOTES_DIR), cwd=str(NOTES_DIR.parent))


def _get_subprocess_env() -> dict[str, str]:
    """
    Returns an environment dict with standard macOS paths appended.
    Crucial for py2app bundles, which lack the user's $PATH, to find
    tools like 'evernote2md' or 'git' installed via Homebrew / Xcode tools.
    """
    env = os.environ.copy()
    current_path = env.get("PATH", "")
    paths_to_add = [
        # Prefer the bin dir of the running Python (works in any venv or install)
        str(Path(sys.executable).parent),
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
    ok, msg = git_push("Sync: manual sync from EverFree")
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
        webbrowser.open(f"http://127.0.0.1:{PORT}")

    asyncio.create_task(_open_browser())
    yield


app = FastAPI(title="EverFree", version="4.0.0", lifespan=lifespan)


# ══════════════════════════════════════════════════════════════
#  GITHUB OAUTH (device flow — no client_secret, no redirect)
# ══════════════════════════════════════════════════════════════

@app.post("/api/auth/github/start")
async def github_auth_start(background_tasks: BackgroundTasks):
    """Start the GitHub Device Flow. Returns user_code to display to the user."""
    github_auth_state.update({
        "access_token": None,
        "username": None,
        "status": "pending",
        "error": None,
        "user_code": None,
        "verification_uri": None,
    })

    try:
        async with httpx.AsyncClient(timeout=GITHUB_REQUEST_TIMEOUT) as client:
            resp = await client.post(
                "https://github.com/login/device/code",
                data={"client_id": GITHUB_CLIENT_ID, "scope": "repo"},
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        detail = f"Could not reach GitHub to start sign-in. Check internet access and try again. ({exc})"
        logger.exception("GitHub device-flow start failed")
        github_auth_state.update({"status": "error", "error": detail})
        raise HTTPException(status_code=502, detail=detail) from exc

    try:
        data = resp.json()
    except ValueError as exc:
        detail = f"GitHub returned a non-JSON response while starting sign-in: HTTP {resp.status_code}."
        logger.error("%s Body: %s", detail, resp.text[:500])
        github_auth_state.update({"status": "error", "error": detail})
        raise HTTPException(status_code=502, detail=detail) from exc

    if not resp.is_success:
        detail = data.get("error_description") or data.get("error") or f"GitHub sign-in failed: HTTP {resp.status_code}"
        github_auth_state.update({"status": "error", "error": detail})
        raise HTTPException(status_code=502, detail=detail)

    if "error" in data:
        detail = data.get("error_description", data["error"])
        github_auth_state.update({"status": "error", "error": detail})
        raise HTTPException(status_code=400, detail=detail)

    required_fields = {"device_code", "user_code", "verification_uri"}
    if not required_fields.issubset(data):
        detail = "GitHub returned an incomplete device-flow response. Please try again."
        logger.error("%s Response: %s", detail, data)
        github_auth_state.update({"status": "error", "error": detail})
        raise HTTPException(status_code=502, detail=detail)

    device_code = data["device_code"]
    user_code = data["user_code"]
    verification_uri = data["verification_uri"]
    interval = data.get("interval", 5)
    expires_in = data.get("expires_in", 900)

    github_auth_state.update({"user_code": user_code, "verification_uri": verification_uri})

    # Open the verification page after the response is sent (avoids Safari mid-request tab switch)
    background_tasks.add_task(webbrowser.open, verification_uri)

    # Poll in background until user authorizes or code expires
    asyncio.create_task(_poll_device_flow(device_code, interval, expires_in))

    return {"user_code": user_code, "verification_uri": verification_uri}


async def _poll_device_flow(device_code: str, interval: int, expires_in: int):
    """Background task: polls GitHub until user completes device authorization."""
    import time
    deadline = time.time() + expires_in

    while time.time() < deadline:
        await asyncio.sleep(interval)

        try:
            async with httpx.AsyncClient(timeout=GITHUB_REQUEST_TIMEOUT) as client:
                resp = await client.post(
                    "https://github.com/login/oauth/access_token",
                    data={
                        "client_id": GITHUB_CLIENT_ID,
                        "device_code": device_code,
                        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    },
                    headers={"Accept": "application/json"},
                )
        except httpx.HTTPError as exc:
            detail = f"Could not reach GitHub while waiting for authorization. ({exc})"
            logger.exception("GitHub device-flow poll failed")
            github_auth_state.update({"status": "error", "error": detail})
            return

        try:
            data = resp.json()
        except ValueError:
            detail = f"GitHub returned a non-JSON response while waiting for authorization: HTTP {resp.status_code}."
            logger.error("%s Body: %s", detail, resp.text[:500])
            github_auth_state.update({"status": "error", "error": detail})
            return

        if not resp.is_success:
            detail = data.get("error_description") or data.get("error") or f"GitHub authorization failed: HTTP {resp.status_code}"
            github_auth_state.update({"status": "error", "error": detail})
            return

        error = data.get("error")

        if error == "authorization_pending":
            continue
        elif error == "slow_down":
            interval += 5
            continue
        elif error == "access_denied":
            github_auth_state.update({"status": "error", "error": "Authorization denied."})
            return
        elif error:
            github_auth_state.update({"status": "error", "error": data.get("error_description", error)})
            return

        token = data.get("access_token")
        if token:
            try:
                async with httpx.AsyncClient(timeout=GITHUB_REQUEST_TIMEOUT) as client:
                    user_resp = await client.get(
                        "https://api.github.com/user",
                        headers={"Authorization": f"token {token}"},
                    )
                username = user_resp.json().get("login", "unknown") if user_resp.status_code == 200 else "unknown"
            except Exception as exc:
                logger.exception("Failed to fetch GitHub user after authorization")
                github_auth_state.update({
                    "status": "error",
                    "error": f"GitHub authorized, but EverFree could not fetch your GitHub profile. ({exc})",
                })
                return
            github_auth_state.update({"access_token": token, "username": username, "status": "authorized"})
            _save_auth()
            return

    github_auth_state.update({"status": "error", "error": "Device code expired. Please try again."})


@app.get("/api/auth/github/status")
async def github_auth_status():
    return {
        "status": github_auth_state["status"],
        "username": github_auth_state.get("username"),
        "detail": github_auth_state.get("error"),
    }


# ══════════════════════════════════════════════════════════════
#  EVERNOTE AUTH + SYNC
# ══════════════════════════════════════════════════════════════

EVERNOTE_OAUTH_PORT = int(os.environ.get("EVERFREE_EVERNOTE_OAUTH_PORT", 10500))


def _find_tool(name: str) -> str | None:
    env = _get_subprocess_env()
    return shutil.which(name, path=env["PATH"])


def _get_import_tools_status() -> dict:
    evernote2md_path = _find_tool("evernote2md")
    brew_path = _find_tool("brew")
    return {
        "evernote2md": {
            "installed": bool(evernote2md_path),
            "path": evernote2md_path,
        },
        "homebrew": {
            "installed": bool(brew_path),
            "path": brew_path,
        },
        "install": import_tool_install_state.copy(),
    }


@app.get("/api/setup/import-tools/status")
async def import_tools_status():
    return _get_import_tools_status()


@app.post("/api/setup/import-tools/install")
async def install_import_tools():
    """Install the Evernote ENEX -> Markdown converter after explicit user action."""
    if _find_tool("evernote2md"):
        return {"status": "installed", **_get_import_tools_status()}
    if import_tool_install_state["running"]:
        return {"status": "running", **_get_import_tools_status()}

    brew_path = _find_tool("brew")
    if not brew_path:
        raise HTTPException(
            status_code=400,
            detail="Homebrew is required to install evernote2md. Install Homebrew, then retry.",
        )

    import_tool_install_state.update({
        "running": True,
        "detail": "Installing evernote2md with Homebrew...",
        "error": None,
    })

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _install_evernote2md, brew_path)

    return {"status": "started", **_get_import_tools_status()}


def _install_evernote2md(brew_path: str):
    try:
        env = _get_subprocess_env()
        result = subprocess.run(
            [brew_path, "install", "evernote2md"],
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=900,
        )
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "brew install evernote2md failed").strip()
            raise RuntimeError(msg)
        import_tool_install_state.update({
            "running": False,
            "detail": "evernote2md installed.",
            "error": None,
        })
    except Exception as e:
        import_tool_install_state.update({
            "running": False,
            "detail": "",
            "error": str(e),
        })


@app.post("/api/auth/evernote/start")
async def evernote_auth_start():
    """Start Evernote OAuth + full sync pipeline in a background thread."""
    if evernote_auth_state["status"] == "running":
        return {"status": "running", "detail": "Already running"}
    if not _find_tool("evernote2md"):
        raise HTTPException(
            status_code=409,
            detail="evernote2md is required before importing Evernote notes.",
        )

    evernote_auth_state.update({"status": "running", "detail": "Starting...", "error": None})

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _evernote_sync_pipeline)

    return {"status": "started"}


def _evernote_sync_pipeline():
    """
    Full pipeline:
      1. OAuth via evernote-backup's Python API (no TTY needed)
      2. Initialize evernote-backup's database through its Python API
      3. Sync Evernote notes through its Python API
      4. Export .enex files through its Python API
      5. evernote2md convert
    """
    global evernote_auth_state
    try:
        from evernote_backup import cli_app, config_defaults
        from evernote_backup.evernote_client_oauth import (
            EvernoteOAuthCallbackHandler,
            EvernoteOAuthClient,
            OAuthDeclinedError,
        )
        from evernote_backup.cli_app_util import get_api_data

        tmp_dir = tempfile.mkdtemp(prefix="everfree_en_")
        db_path = os.path.join(tmp_dir, "en_backup.db")
        enex_dir = os.path.join(tmp_dir, "enex_export")

        env = _get_subprocess_env()
        evernote2md_bin = shutil.which("evernote2md", path=env["PATH"])

        if not evernote2md_bin:
            raise FileNotFoundError("evernote2md is not installed or not found in PATH")

        # Step 1: OAuth — use the Python API directly so no TTY is required
        evernote_auth_state["detail"] = "Opening Evernote login in your browser..."
        consumer_key, consumer_secret = get_api_data("evernote", None)
        oauth_client = EvernoteOAuthClient(
            backend="evernote",
            consumer_key=consumer_key,
            consumer_secret=consumer_secret,
        )
        oauth_handler = EvernoteOAuthCallbackHandler(
            oauth_client, EVERNOTE_OAUTH_PORT, "localhost"
        )
        oauth_url = oauth_handler.get_oauth_url()
        webbrowser.open(oauth_url)

        evernote_auth_state["detail"] = "Waiting for Evernote authorization (check your browser)..."
        try:
            token = oauth_handler.wait_for_token()
        except OAuthDeclinedError:
            raise RuntimeError("Evernote authorization was declined.")

        # Step 2: init-db with the token we just obtained (bypasses TTY check)
        evernote_auth_state["detail"] = "Initializing database..."
        cli_app.init_db(
            database=Path(db_path),
            auth_user=None,
            auth_password=None,
            auth_oauth_port=EVERNOTE_OAUTH_PORT,
            auth_oauth_host="localhost",
            auth_token=token,
            force=False,
            backend="evernote",
            network_retry_count=config_defaults.NETWORK_ERROR_RETRY_COUNT,
            use_system_ssl_ca=False,
            custom_api_data=None,
        )

        # Step 3: sync
        evernote_auth_state["detail"] = "Syncing notes from Evernote..."
        cli_app.sync(
            database=Path(db_path),
            max_chunk_results=config_defaults.SYNC_CHUNK_MAX_RESULTS,
            max_download_workers=EVERNOTE_SYNC_MAX_DOWNLOAD_WORKERS,
            download_cache_memory_limit=config_defaults.SYNC_DOWNLOAD_CACHE_MEMORY_LIMIT,
            network_retry_count=config_defaults.NETWORK_ERROR_RETRY_COUNT,
            use_system_ssl_ca=False,
            include_tasks=False,
            token=None,
        )

        # Step 4: export to .enex
        evernote_auth_state["detail"] = "Exporting .enex files..."
        os.makedirs(enex_dir, exist_ok=True)
        cli_app.export(
            database=Path(db_path),
            single_notes=False,
            include_trash=False,
            no_export_date=False,
            add_guid=False,
            add_metadata=False,
            overwrite=False,
            notebooks=(),
            tags=(),
            output_path=Path(enex_dir),
        )

        # Step 5: convert to Markdown
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
        evernote_auth_state.update({
            "status": "done",
            "detail": f"Imported {len(enex_files)} notebook(s)",
        })

    except subprocess.CalledProcessError as e:
        evernote_auth_state.update({
            "status": "error",
            "error": f"{' '.join(e.cmd)}: {(e.stderr or str(e)).strip()}",
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
    return {
        "configured": _is_configured(),
        "evernote_synced": _is_evernote_synced(),
        "notes_dir": str(NOTES_DIR),
        "port": PORT,
    }


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
        local_has_content = _has_local_note_content()

        # ── Create private GitHub repo ───────────────────────
        _update_progress("github_create", f"Connecting private repo '{repo_name}'...")
        owner = github_auth_state.get("username", "unknown")
        repo_exists = False

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
                    "description": "EverFree — Git-backed Markdown notes",
                    "auto_init": False,
                },
            )
            if resp.status_code == 201:
                repo_data = resp.json()
                owner = repo_data["owner"]["login"]
            elif resp.status_code == 422:
                existing_resp = client.get(
                    f"https://api.github.com/repos/{owner}/{repo_name}",
                    headers={
                        "Authorization": f"token {token}",
                        "Accept": "application/vnd.github.v3+json",
                    },
                )
                if existing_resp.status_code != 200:
                    raise RuntimeError(f"GitHub API error {resp.status_code}: {resp.text}")
                repo_data = existing_resp.json()
                owner = repo_data["owner"]["login"]
                repo_exists = True
                _update_progress("github_create", "Repo already exists, using it...")
            else:
                raise RuntimeError(f"GitHub API error {resp.status_code}: {resp.text}")

        clone_url = f"https://github.com/{owner}/{repo_name}.git"
        auth_url = clone_url.replace("https://", f"https://{token}@")

        if repo_exists and not local_has_content:
            _update_progress("git_init", "Cloning existing notes repository...")
            _clone_existing_repo(auth_url)
            _update_progress("complete", "All set! Redirecting...")
            setup_progress["complete"] = True
            return

        # Create welcome notebook only for a brand-new local notes repo.
        if not local_has_content:
            welcome_dir = NOTES_DIR / "Welcome"
            welcome_dir.mkdir(parents=True, exist_ok=True)
            (welcome_dir / "Getting Started.md").write_text(
                "# Getting Started\n\nWelcome to **EverFree**!\n\n"
                "- **Edit** notes with the Markdown editor\n"
                "- **Create** notebooks and notes from the sidebar\n"
                "- **Sync** automatically to GitHub on every save\n\n"
                "Happy writing!\n",
                encoding="utf-8",
            )

        # ── Git init + push ──────────────────────────────────
        _update_progress("git_init", "Initializing Git repository...")
        (NOTES_DIR / ".gitignore").write_text(".DS_Store\n*.swp\n*.swo\n*~\n", encoding="utf-8")

        _git("init", cwd=str(NOTES_DIR))
        _git("branch", "-M", "main", cwd=str(NOTES_DIR))
        _git("remote", "add", "origin", auth_url, cwd=str(NOTES_DIR), check=False)
        _git("remote", "set-url", "origin", auth_url, cwd=str(NOTES_DIR), check=False)

        _update_progress("git_push", "Pushing notes to GitHub...")
        _git("add", ".", cwd=str(NOTES_DIR))
        _git("commit", "-m", "Initial import from EverFree", cwd=str(NOTES_DIR))
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


# ── API: Search ─────────────────────────────────────────────
def _search_snippet(content: str, query: str, size: int = 140) -> str:
    lower = content.lower()
    idx = lower.find(query.lower())
    if idx < 0:
        return ""
    start = max(0, idx - size // 2)
    end = min(len(content), idx + len(query) + size // 2)
    snippet = " ".join(content[start:end].split())
    if start > 0:
        snippet = "..." + snippet
    if end < len(content):
        snippet += "..."
    return snippet


@app.get("/api/search")
async def search_notes(q: str = ""):
    query = q.strip()
    if not query:
        return []

    results = []
    lower_query = query.lower()

    for notebook in sorted(d for d in NOTES_DIR.iterdir() if d.is_dir() and not d.name.startswith(".")):
        for note in sorted(notebook.iterdir()):
            if not note.is_file() or note.suffix != ".md":
                continue

            try:
                content = note.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            title = note.name.removesuffix(".md")
            notebook_match = lower_query in notebook.name.lower()
            title_match = lower_query in title.lower()
            content_match = lower_query in content.lower()

            if not (notebook_match or title_match or content_match):
                continue

            results.append({
                "notebook": notebook.name,
                "note": note.name,
                "title": title,
                "snippet": _search_snippet(content, query),
            })
            if len(results) >= 100:
                return results

    return results


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
