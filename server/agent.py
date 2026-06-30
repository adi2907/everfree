"""
EverFree — Writing Assist Agent

Provider-selectable agent: text generation can run through LM Studio,
OpenRouter, or the Gemini API. Image generation goes through OpenRouter.
Web search uses Serper, and result pages are fetched and reduced to readable
text with a stdlib HTML parser so no extra dependencies enter the bundle.

Settings (provider URLs, models, and API keys) live in
~/.everfree_agent.json, managed through /api/agent/settings.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger("everfree.agent")

router = APIRouter(prefix="/api/agent")

NOTES_DIR = Path(os.environ.get("EVERFREE_DIR", Path.home() / "Documents" / "EverFree"))
SETTINGS_FILE = Path.home() / ".everfree_agent.json"
# Chat sessions live on local disk, outside the notes repo so they are never
# pushed to GitHub. One JSON file per chat, indexed by the note it belongs to.
CHATS_DIR = Path(os.environ.get("EVERFREE_CHATS_DIR", Path.home() / ".everfree_chats"))
# Background deep-research jobs persist here (outside the notes repo) so they
# survive panel close, note switches, and server restarts. One JSON per job.
RESEARCH_DIR = Path(os.environ.get("EVERFREE_RESEARCH_DIR", Path.home() / ".everfree_research"))

DEFAULT_SETTINGS = {
    "active_provider": "lmstudio",
    "lmstudio_url": "http://localhost:1234/v1",
    "lmstudio_model": "",
    "openrouter_api_key": "",
    "openrouter_model": "",
    "gemini_api_key": "",
    "gemini_model": "gemini-2.5-flash",
    "serper_api_key": "",
    "image_model": "google/gemini-2.5-flash-image",
    # Deep research can run on a separate, usually larger model. Blank values
    # fall back to the active provider / its normal model.
    "research_provider": "",
    "research_model": "",
}

PROVIDERS = {"lmstudio", "openrouter", "gemini"}

# Foreground chat allows a handful of tool rounds; background research plans
# over many more searches and page reads before it synthesizes a report.
MAX_TOOL_ROUNDS = 8
RESEARCH_MAX_ROUNDS = 18
NOTE_CONTEXT_LIMIT = 8000
PAGE_TEXT_LIMIT = 6000
SEARCH_RESULT_COUNT = 6
LLM_TIMEOUT = httpx.Timeout(180.0, connect=10.0)


# ── Settings ─────────────────────────────────────────────────
def _load_settings() -> dict:
    settings = DEFAULT_SETTINGS.copy()
    try:
        if SETTINGS_FILE.exists():
            saved = json.loads(SETTINGS_FILE.read_text())
            settings.update({k: v for k, v in saved.items() if k in DEFAULT_SETTINGS})
    except Exception:
        logger.exception("Failed to read agent settings")
    return settings


def _save_settings(settings: dict) -> None:
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    SETTINGS_FILE.chmod(0o600)


def _public_settings(settings: dict) -> dict:
    return {
        "active_provider": settings["active_provider"],
        "lmstudio_url": settings["lmstudio_url"],
        "lmstudio_model": settings["lmstudio_model"],
        "openrouter_model": settings["openrouter_model"],
        "gemini_model": settings["gemini_model"],
        "image_model": settings["image_model"],
        "research_provider": settings["research_provider"],
        "research_model": settings["research_model"],
        "openrouter_api_key_set": bool(settings["openrouter_api_key"]),
        "gemini_api_key_set": bool(settings["gemini_api_key"]),
        "serper_api_key_set": bool(settings["serper_api_key"]),
    }


@router.get("/settings")
async def get_settings():
    return _public_settings(_load_settings())


@router.post("/settings")
async def update_settings(request: Request):
    body = await request.json()
    settings = _load_settings()
    for key in DEFAULT_SETTINGS:
        if key in body and isinstance(body[key], str):
            settings[key] = body[key].strip()
    if settings["active_provider"] not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid AI provider")
    if settings["research_provider"] and settings["research_provider"] not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid research provider")
    _save_settings(settings)
    return _public_settings(settings)


@router.get("/status")
async def agent_status():
    settings = _load_settings()
    provider = settings["active_provider"]
    labels = {"lmstudio": "Local LLM", "openrouter": "OpenRouter", "gemini": "Gemini"}
    model = settings.get(f"{provider}_model", "")
    ready = False
    detail = ""

    if provider == "lmstudio":
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                resp = await client.get(f"{settings['lmstudio_url'].rstrip('/')}/models")
            ready = resp.status_code == 200 and bool(resp.json().get("data"))
            if ready and not model:
                model = resp.json()["data"][0].get("id", "")
        except Exception:
            detail = "Start LM Studio, load a model, and enable its local server."
    elif provider == "openrouter":
        ready = bool(settings["openrouter_api_key"] and settings["openrouter_model"])
        detail = "Add an OpenRouter API key and select a model."
    else:
        ready = bool(settings["gemini_api_key"] and settings["gemini_model"])
        detail = "Add a Gemini API key and select a model."

    return {
        "provider": provider,
        "provider_label": labels[provider],
        "model": model,
        "ready": ready,
        "detail": detail,
    }


@router.post("/models/{provider}")
async def provider_models(provider: str, request: Request):
    """Return selectable text-generation models for one provider."""
    settings = _load_settings()
    body = await request.json()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if provider == "lmstudio":
                base_url = (body.get("lmstudio_url") or settings["lmstudio_url"]).strip().rstrip("/")
                resp = await client.get(f"{base_url}/models")
                resp.raise_for_status()
                models = [m.get("id", "") for m in resp.json().get("data", [])]
            elif provider == "openrouter":
                api_key = (body.get("api_key") or settings["openrouter_api_key"]).strip()
                headers = {}
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                resp = await client.get("https://openrouter.ai/api/v1/models", headers=headers)
                resp.raise_for_status()
                models = [m.get("id", "") for m in resp.json().get("data", [])]
            elif provider == "gemini":
                api_key = (body.get("api_key") or settings["gemini_api_key"]).strip()
                if not api_key:
                    return {"models": []}
                resp = await client.get(
                    "https://generativelanguage.googleapis.com/v1beta/models",
                    params={"key": api_key, "pageSize": 1000},
                )
                resp.raise_for_status()
                models = [
                    m.get("baseModelId") or m.get("name", "").removeprefix("models/")
                    for m in resp.json().get("models", [])
                    if "generateContent" in (m.get("supportedGenerationMethods") or [])
                ]
            else:
                raise HTTPException(status_code=404, detail="Unknown AI provider")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not load {provider} models: {exc}") from exc
    return {"models": sorted({m for m in models if m})}


# ── Chat session persistence ─────────────────────────────────
def _ensure_chats_dir() -> None:
    CHATS_DIR.mkdir(parents=True, exist_ok=True)


def _safe_chat_path(chat_id: str) -> Path:
    if not re.match(r"^[A-Za-z0-9_-]{1,128}$", chat_id or ""):
        raise HTTPException(status_code=400, detail="Invalid chat id")
    return CHATS_DIR / f"{chat_id}.json"


def _chat_summary(data: dict) -> dict:
    return {
        "id": data.get("id"),
        "notebook": data.get("notebook"),
        "note": data.get("note"),
        "title": data.get("title") or "Untitled chat",
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "message_count": len(data.get("messages") or []),
    }


@router.get("/chats")
async def list_chats(notebook: str = "", note: str = "", q: str = ""):
    """List saved chats, scoped to a note when given, optionally filtered by text."""
    _ensure_chats_dir()
    needle = q.strip().lower()
    results = []
    for path in CHATS_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        if notebook and data.get("notebook") != notebook:
            continue
        if note and data.get("note") != note:
            continue
        if needle:
            haystack = (data.get("title", "") + " " + " ".join(
                m.get("content", "") for m in data.get("messages") or []
            )).lower()
            if needle not in haystack:
                continue
        results.append(_chat_summary(data))
    results.sort(key=lambda c: c.get("updated_at") or 0, reverse=True)
    return results


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str):
    path = _safe_chat_path(chat_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Chat not found")
    return json.loads(path.read_text())


@router.put("/chats/{chat_id}")
async def save_chat(chat_id: str, request: Request):
    path = _safe_chat_path(chat_id)
    body = await request.json()
    _ensure_chats_dir()

    existing = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except Exception:
            existing = {}

    now = time.time()

    def _clean(m: dict) -> dict:
        # `content` is what the model sees (selection folded in); `text` and
        # `context` are kept only so the UI can re-render the excerpt on reload.
        out = {"role": m.get("role"), "content": m.get("content", "")}
        if isinstance(m.get("text"), str) and m["text"]:
            out["text"] = m["text"]
        if isinstance(m.get("context"), str) and m["context"]:
            out["context"] = m["context"]
        return out

    messages = [
        _clean(m)
        for m in (body.get("messages") or [])
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ]
    data = {
        "id": chat_id,
        "notebook": (body.get("notebook") or existing.get("notebook") or "").strip(),
        "note": (body.get("note") or existing.get("note") or "").strip(),
        "title": (body.get("title") or existing.get("title") or "Untitled chat").strip()[:80],
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
        "messages": messages,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return _chat_summary(data)


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str):
    path = _safe_chat_path(chat_id)
    if path.exists():
        path.unlink()
    return {"status": "deleted", "id": chat_id}


# ── HTML → text extraction ───────────────────────────────────
_SKIP_TAGS = {"script", "style", "noscript", "svg", "header", "footer", "nav", "form", "iframe", "aside"}
_BLOCK_TAGS = {
    "p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6",
    "tr", "section", "article", "blockquote", "pre",
}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._chunks: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
        elif tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data):
        if not self._skip_depth and data.strip():
            self._chunks.append(data)

    def text(self) -> str:
        lines = ("".join(self._chunks)).splitlines()
        cleaned = (" ".join(line.split()) for line in lines)
        return "\n".join(line for line in cleaned if line)


def extract_page_text(html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    return parser.text()


# ── Agent tools ──────────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web with Google. Returns titles, links, and snippets of the top results.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_page",
            "description": (
                "Fetch a web page and return its readable text. "
                "Use after web_search to read the most promising results before answering."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full http(s) URL of the page to read"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_notes",
            "description": (
                "Full-text search the user's own notes (across every notebook). "
                "Returns matching notes as 'notebook/note — snippet' lines. "
                "Use this to ground answers in what the user has already written."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words or phrase to look for"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_note",
            "description": "Read the full Markdown content of one of the user's notes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "notebook": {"type": "string", "description": "Notebook (folder) name"},
                    "note": {"type": "string", "description": "Note file name, e.g. 'Ideas.md'"},
                },
                "required": ["notebook", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_notebooks",
            "description": "List the user's notebook (folder) names.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_notes",
            "description": "List the note file names inside one notebook.",
            "parameters": {
                "type": "object",
                "properties": {
                    "notebook": {"type": "string", "description": "Notebook (folder) name"},
                },
                "required": ["notebook"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_note",
            "description": (
                "Create a NEW Markdown note. Never overwrites: if the title is taken, "
                "a numbered suffix is added. Use only when the user asks you to save or "
                "create a note; for normal answers just reply and let the user insert."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "notebook": {"type": "string", "description": "Notebook to create the note in (created if missing)"},
                    "title": {"type": "string", "description": "Title / file name for the new note"},
                    "content": {"type": "string", "description": "Full Markdown body of the note"},
                },
                "required": ["notebook", "title", "content"],
            },
        },
    },
]

# Tools offered to background research: read + web only. The single output
# note is written by the research runner itself, not by a tool call.
RESEARCH_TOOLS = [t for t in TOOLS if t["function"]["name"] != "create_note"]


async def _tool_web_search(query: str, settings: dict) -> str:
    api_key = settings["serper_api_key"]
    if not api_key:
        return "Error: no Serper API key is configured. Ask the user to add one in the assistant settings."
    if not query:
        return "Error: empty search query."
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://google.serper.dev/search",
                headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
                json={"q": query, "num": SEARCH_RESULT_COUNT},
            )
    except httpx.HTTPError as exc:
        return f"Error reaching Serper: {exc}"
    if resp.status_code != 200:
        return f"Error: Serper returned HTTP {resp.status_code}: {resp.text[:200]}"

    data = resp.json()
    lines = []
    answer = data.get("answerBox", {}).get("answer") or data.get("answerBox", {}).get("snippet")
    if answer:
        lines.append(f"Answer box: {answer}")
    for item in data.get("organic", [])[:SEARCH_RESULT_COUNT]:
        lines.append(f"- {item.get('title', '')}\n  {item.get('link', '')}\n  {item.get('snippet', '')}")
    return "\n".join(lines) or "No results."


async def _tool_read_page(url: str) -> str:
    if not re.match(r"^https?://", url or ""):
        return "Error: only full http(s) URLs can be read."
    try:
        async with httpx.AsyncClient(
            timeout=20,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) EverFree/1.0"},
        ) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        return f"Error fetching page: {exc}"
    if resp.status_code != 200:
        return f"Error: HTTP {resp.status_code} from {url}"
    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type and "text" not in content_type:
        return f"Error: cannot read content type {content_type or 'unknown'}"

    text = extract_page_text(resp.text)
    if len(text) > PAGE_TEXT_LIMIT:
        text = text[:PAGE_TEXT_LIMIT] + "\n[truncated]"
    return text or "No readable text found on the page."


# ── Note tools (reuse server.app helpers; imported lazily to avoid the
#    app→agent import cycle) ────────────────────────────────────────────
async def _tool_search_notes(query: str) -> str:
    if not (query or "").strip():
        return "Error: empty search query."
    from server import app as app_module
    results = await asyncio.to_thread(app_module._run_search, query)
    if not results:
        return "No matching notes."
    lines = []
    for r in results[:12]:
        snippet = r.get("snippet") or ""
        line = f"- {r['notebook']}/{r['note']} — {r['title']}"
        if snippet:
            line += f": {snippet}"
        lines.append(line)
    return "\n".join(lines)


async def _tool_read_note(notebook: str, note: str) -> str:
    from server import app as app_module
    note = (note or "").strip()
    if note and not note.endswith(".md"):
        note += ".md"
    try:
        path = app_module._safe_note_path(notebook, note)
    except Exception:
        return f"Error: invalid note path {notebook}/{note}."
    if not path.exists():
        return f"Error: note not found: {notebook}/{note}."
    text = await asyncio.to_thread(app_module._cached_note_text, path)
    if len(text) > NOTE_CONTEXT_LIMIT:
        text = text[:NOTE_CONTEXT_LIMIT] + "\n[truncated]"
    return text or "(this note is empty)"


async def _tool_list_notebooks() -> str:
    def _list() -> list[str]:
        if not NOTES_DIR.exists():
            return []
        names = [d.name for d in NOTES_DIR.iterdir() if d.is_dir() and not d.name.startswith(".")]
        return sorted(names, key=str.lower)
    names = await asyncio.to_thread(_list)
    return "\n".join(f"- {n}" for n in names) or "No notebooks yet."


async def _tool_list_notes(notebook: str) -> str:
    from server import app as app_module
    try:
        nb_path = app_module._safe_notebook_path(notebook)
    except Exception:
        return f"Error: invalid notebook {notebook}."
    if not nb_path.exists():
        return f"Error: notebook not found: {notebook}."

    def _list() -> list[str]:
        names = [f.name for f in nb_path.iterdir() if f.is_file() and f.suffix == ".md"]
        return sorted(names, key=str.lower)
    notes = await asyncio.to_thread(_list)
    return "\n".join(f"- {n}" for n in notes) or "(no notes in this notebook)"


async def _create_note_file(notebook: str, title: str, content: str) -> str:
    """Create a new note, never overwriting. Returns the final file name.
    Raises on invalid input. Shared by the create_note tool and research."""
    from server import app as app_module
    notebook = (notebook or "").strip()
    title = (title or "").strip()
    if not notebook or not title:
        raise ValueError("both notebook and title are required")
    stem = re.sub(r"[\\/]+", "-", title).strip().removesuffix(".md").strip()
    if not stem:
        raise ValueError("invalid title")
    app_module._safe_notebook_path(notebook)  # validate early

    def _write() -> str:
        nb_path = app_module._safe_notebook_path(notebook)
        nb_path.mkdir(parents=True, exist_ok=True)
        name = f"{stem}.md"
        candidate = app_module._safe_note_path(notebook, name)
        n = 2
        while candidate.exists():
            name = f"{stem} {n}.md"
            candidate = app_module._safe_note_path(notebook, name)
            n += 1
        body = content or ""
        if not body.lstrip().startswith("#"):
            body = f"# {stem}\n\n{body}"
        app_module._atomic_write_text(candidate, body)
        return name

    name = await asyncio.to_thread(_write)
    app_module.request_sync()
    return name


async def _tool_create_note(notebook: str, title: str, content: str) -> str:
    try:
        name = await _create_note_file(notebook, title, content)
    except Exception as exc:
        return f"Error creating note: {exc}"
    return f"Created note '{name}' in notebook '{notebook}'."


# ── Streamed-reasoning helpers ───────────────────────────────
def _safe_emit_len(buf: str, tag: str) -> int:
    """Length of `buf` that is safe to emit without slicing through a partial
    occurrence of `tag` sitting at the very end (tags can straddle chunks)."""
    for k in range(min(len(tag) - 1, len(buf)), 0, -1):
        if buf.endswith(tag[:k]):
            return len(buf) - k
    return len(buf)


def _split_think(buf: str, in_think: bool) -> tuple[list[tuple[str, str]], str, bool]:
    """Split streamed `content` into ('reason', text) inside <think>…</think>
    and ('answer', text) outside it. Consumes only the unambiguous prefix of
    `buf`, returning (events, remaining_buf, in_think) so partial tags carry
    over to the next chunk. Local reasoning models emit thinking this way."""
    open_tag, close_tag = "<think>", "</think>"
    events: list[tuple[str, str]] = []
    while buf:
        if in_think:
            idx = buf.find(close_tag)
            if idx == -1:
                cut = _safe_emit_len(buf, close_tag)
                if cut:
                    events.append(("reason", buf[:cut]))
                    buf = buf[cut:]
                break
            if idx:
                events.append(("reason", buf[:idx]))
            buf = buf[idx + len(close_tag):]
            in_think = False
        else:
            idx = buf.find(open_tag)
            if idx == -1:
                cut = _safe_emit_len(buf, open_tag)
                if cut:
                    events.append(("answer", buf[:cut]))
                    buf = buf[cut:]
                break
            if idx:
                events.append(("answer", buf[:idx]))
            buf = buf[idx + len(open_tag):]
            in_think = True
    return events, buf, in_think


# ── Prompts ──────────────────────────────────────────────────
CHAT_SYSTEM_PROMPT = """You are the agentic writing assistant built into EverFree, a Markdown note-taking app.
The user is writing a note; its current content may be provided below. Match its tone, voice, and formatting.

Think before you act. Decide whether a question is best answered from the note in front of you, from the user's other notes, or from the web, then use tools to gather what you need before replying.

Tools:
- search_notes / read_note / list_notebooks / list_notes — search and read the user's own notes. Prefer these to ground answers in what they have already written.
- web_search (Google) then read_page — for external facts. Read the 2-3 most promising results before answering, and end such a passage with a "Sources:" line of Markdown links.
- create_note — only when the user explicitly asks you to save or create a note. It never overwrites existing notes.

Your final reply is inserted directly into the note, so reply with clean Markdown only — no preamble like "Here is...", no code fences wrapping the whole reply, no commentary about what you did."""

CONTINUE_SYSTEM_PROMPT = """You are the writing assistant built into EverFree, a Markdown note-taking app.
Continue the user's note from exactly where it stops. If the last sentence is unfinished, finish it. Add at most one short sentence after that, in the same voice, tone, and formatting. Do not keep expanding the note.
Reply with the continuation text only — no preamble, no quotes, and do not repeat any of the existing text."""


# ── Agent loop ───────────────────────────────────────────────
async def _resolve_local_model(client: httpx.AsyncClient, base_url: str, settings: dict) -> str:
    if settings["lmstudio_model"]:
        return settings["lmstudio_model"]
    resp = await client.get(f"{base_url}/models")
    resp.raise_for_status()
    models = resp.json().get("data", [])
    if not models:
        raise RuntimeError("No model is loaded in LM Studio.")
    return models[0]["id"]


async def _run_tool(name: str, args: dict, settings: dict) -> tuple[str, str]:
    if name == "web_search":
        detail = args.get("query", "")
        return detail, await _tool_web_search(detail, settings)
    if name == "read_page":
        detail = args.get("url", "")
        return detail, await _tool_read_page(detail)
    if name == "search_notes":
        detail = args.get("query", "")
        return detail, await _tool_search_notes(detail)
    if name == "read_note":
        notebook, note = args.get("notebook", ""), args.get("note", "")
        return f"{notebook}/{note}".strip("/"), await _tool_read_note(notebook, note)
    if name == "list_notebooks":
        return "", await _tool_list_notebooks()
    if name == "list_notes":
        notebook = args.get("notebook", "")
        return notebook, await _tool_list_notes(notebook)
    if name == "create_note":
        notebook, title = args.get("notebook", ""), args.get("title", "")
        return f"{notebook}/{title}".strip("/"), await _tool_create_note(notebook, title, args.get("content", ""))
    return "", f"Error: unknown tool {name}"


def _empty_completion_event(finish_reason: str | None) -> dict:
    """Build a user-facing error for a completion that came back with no text.
    Reasoning/thinking models can spend the whole token budget on hidden
    reasoning and return empty content — surface that instead of silently
    yielding nothing."""
    if (finish_reason or "").lower() in {"length", "max_tokens"}:
        detail = ("The model hit its output-token limit before replying — often a "
                  "reasoning model. Try again, shorten the note, or use a smaller model.")
    else:
        detail = "The model returned no text. Try again or pick a different model."
    return {"type": "error", "detail": detail}


def _content_text(value) -> str:
    """Normalize OpenAI/OpenRouter content shapes into visible text.

    Most providers stream a string in delta.content, but OpenRouter can expose
    provider-native structured content parts. Treat only text-like parts as
    visible answer text and ignore images/tool annotations here.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    if isinstance(value, dict):
        text = value.get("text") or value.get("content")
        return text if isinstance(text, str) else ""
    return ""


def _append_visible_text(text: str, answer_text: str, think_buf: str, in_think: bool):
    if not text:
        return answer_text, think_buf, in_think, []
    pieces, think_buf, in_think = _split_think(think_buf + text, in_think)
    events = []
    for kind, piece in pieces:
        if kind == "reason":
            events.append({"type": "reason", "text": piece})
        else:
            answer_text += piece
            events.append({"type": "delta", "text": piece})
    return answer_text, think_buf, in_think, events


async def _openai_compatible_events(
    messages: list[dict], tools: list | None, settings: dict, max_tokens: int,
    no_thinking: bool = False, max_rounds: int = MAX_TOOL_ROUNDS,
):
    """Stream an OpenAI-compatible tool loop, surfacing reasoning live.

    `reasoning` / `reasoning_content` deltas (OpenRouter) and inline
    <think>…</think> spans (local models) become `reason` events; visible
    answer text becomes `delta` events. Streamed tool-call fragments are
    reassembled across chunks, executed, and the loop continues.
    """
    provider = settings["active_provider"]
    if provider == "lmstudio":
        base_url = settings["lmstudio_url"].rstrip("/")
        headers = {}
    else:
        if not settings["openrouter_api_key"]:
            raise RuntimeError("Add an OpenRouter API key in assistant settings.")
        base_url = "https://openrouter.ai/api/v1"
        headers = {"Authorization": f"Bearer {settings['openrouter_api_key']}"}

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT, headers=headers) as client:
        if provider == "lmstudio":
            model = await _resolve_local_model(client, base_url, settings)
        else:
            model = settings["openrouter_model"]
            if not model:
                raise RuntimeError("Select an OpenRouter chat model in assistant settings.")

        for _ in range(max_rounds):
            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.7,
                "stream": True,
            }
            if provider == "openrouter":
                payload["max_completion_tokens"] = max_tokens
                if no_thinking:
                    payload["reasoning"] = {"effort": "minimal", "exclude": True}
            else:
                payload["max_tokens"] = max_tokens
            if tools:
                payload["tools"] = tools

            answer_text = ""           # visible answer with <think> spans removed
            snapshot_text = ""         # full-message snapshots some providers stream
            tool_acc: dict[int, dict] = {}
            finish_reason = None
            think_buf, in_think = "", False

            async with client.stream("POST", f"{base_url}/chat/completions", json=payload) as resp:
                if resp.status_code != 200:
                    raw = (await resp.aread()).decode("utf-8", "replace")
                    label = "LM Studio" if provider == "lmstudio" else "OpenRouter"
                    raise RuntimeError(f"{label} error HTTP {resp.status_code}: {raw[:300]}")
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    choice = (chunk.get("choices") or [{}])[0]
                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]
                    delta = choice.get("delta") or {}

                    reason = delta.get("reasoning") or delta.get("reasoning_content")
                    if not reason:
                        reason = (choice.get("message") or {}).get("reasoning")
                    if reason:
                        yield {"type": "reason", "text": reason}

                    content = _content_text(delta.get("content"))
                    if not content:
                        message_content = _content_text((choice.get("message") or {}).get("content"))
                        if message_content:
                            if message_content.startswith(snapshot_text):
                                content = message_content[len(snapshot_text):]
                            else:
                                content = message_content
                            snapshot_text = message_content

                    answer_text, think_buf, in_think, events = _append_visible_text(
                        content, answer_text, think_buf, in_think
                    )
                    for event in events:
                        yield event

                    for tc in delta.get("tool_calls") or []:
                        slot = tool_acc.setdefault(
                            tc.get("index", 0), {"id": None, "name": "", "arguments": ""}
                        )
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["arguments"] += fn["arguments"]

            if think_buf:  # flush text held back as a possible partial tag
                if in_think:
                    yield {"type": "reason", "text": think_buf}
                else:
                    answer_text += think_buf
                    yield {"type": "delta", "text": think_buf}

            tool_calls = [tool_acc[i] for i in sorted(tool_acc)]
            if not tool_calls:
                if answer_text:
                    yield {"type": "done"}
                else:
                    yield _empty_completion_event(finish_reason)
                return

            messages.append({
                "role": "assistant",
                "content": answer_text or None,
                "tool_calls": [
                    {
                        "id": tc["id"] or f"call_{i}",
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"] or "{}"},
                    }
                    for i, tc in enumerate(tool_calls)
                ],
            })
            for i, tc in enumerate(tool_calls):
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except ValueError:
                    args = {}
                detail, result = await _run_tool(tc["name"], args, settings)
                yield {"type": "tool", "name": tc["name"], "detail": detail}
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"] or f"call_{i}",
                    "content": result,
                })

        yield {"type": "error", "detail": "The agent hit the tool-call limit without finishing."}


def _gemini_request(messages: list[dict]) -> tuple[dict | None, list[dict]]:
    system_instruction = None
    contents = []
    for message in messages:
        role = message.get("role")
        text = message.get("content")
        if role == "system":
            system_instruction = {"parts": [{"text": text or ""}]}
        elif role in {"user", "assistant"} and isinstance(text, str):
            contents.append({
                "role": "model" if role == "assistant" else "user",
                "parts": [{"text": text}],
            })
    return system_instruction, contents


def _gemini_tools(tools: list) -> list[dict]:
    decls = []
    for tool in tools:
        fn = tool["function"]
        decl = {"name": fn["name"], "description": fn["description"]}
        params = fn.get("parameters") or {}
        if params.get("properties"):  # Gemini rejects empty parameter objects
            decl["parameters"] = params
        decls.append(decl)
    return [{"functionDeclarations": decls}]


async def _gemini_events(
    messages: list[dict], tools: list | None, settings: dict, max_tokens: int,
    no_thinking: bool = False, max_rounds: int = MAX_TOOL_ROUNDS,
):
    if not settings["gemini_api_key"]:
        raise RuntimeError("Add a Gemini API key in assistant settings.")
    model = settings["gemini_model"]
    if not model:
        raise RuntimeError("Select a Gemini model in assistant settings.")
    model = model.removeprefix("models/")
    system_instruction, contents = _gemini_request(messages)
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:streamGenerateContent?alt=sse"
    )

    async with httpx.AsyncClient(
        timeout=LLM_TIMEOUT,
        headers={"x-goog-api-key": settings["gemini_api_key"]},
    ) as client:
        for _ in range(max_rounds):
            generation_config = {"temperature": 0.7, "maxOutputTokens": max_tokens}
            # Gemini 2.5 models "think" by default; thinking tokens count against
            # maxOutputTokens. For a short continuation that can eat the whole
            # budget, so disable it; otherwise ask for thought summaries to stream.
            if no_thinking:
                generation_config["thinkingConfig"] = {"thinkingBudget": 0}
            else:
                generation_config["thinkingConfig"] = {"includeThoughts": True}
            payload = {"contents": contents, "generationConfig": generation_config}
            if system_instruction:
                payload["systemInstruction"] = system_instruction
            if tools:
                payload["tools"] = _gemini_tools(tools)

            answer_text = ""
            function_calls = []
            model_parts = []           # functionCall parts echoed back (keep signatures)
            finish_reason = None

            async with client.stream("POST", url, json=payload) as resp:
                if resp.status_code != 200:
                    raw = (await resp.aread()).decode("utf-8", "replace")
                    raise RuntimeError(f"Gemini error HTTP {resp.status_code}: {raw[:300]}")
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    cand = (chunk.get("candidates") or [{}])[0]
                    if cand.get("finishReason"):
                        finish_reason = cand["finishReason"]
                    for part in (cand.get("content") or {}).get("parts") or []:
                        if part.get("functionCall"):
                            function_calls.append(part["functionCall"])
                            model_parts.append(part)
                        elif "text" in part:
                            if part.get("thought"):
                                yield {"type": "reason", "text": part["text"]}
                            else:
                                answer_text += part["text"]
                                yield {"type": "delta", "text": part["text"]}

            if not function_calls:
                if answer_text:
                    yield {"type": "done"}
                else:
                    yield _empty_completion_event(finish_reason)
                return

            if answer_text:
                model_parts.append({"text": answer_text})
            contents.append({"role": "model", "parts": model_parts})
            response_parts = []
            for call in function_calls:
                name = call.get("name", "")
                args = call.get("args") or {}
                detail, result = await _run_tool(name, args, settings)
                yield {"type": "tool", "name": name, "detail": detail}
                response_parts.append({
                    "functionResponse": {"name": name, "response": {"result": result}}
                })
            contents.append({"role": "user", "parts": response_parts})

        yield {"type": "error", "detail": "The agent hit the tool-call limit without finishing."}


def _resolve_settings(override: dict | None = None) -> dict:
    """Load settings, optionally swapping the active provider/model for one
    run (used by the deep-research override and any per-request override)."""
    settings = _load_settings()
    if override:
        settings = dict(settings)
        provider = override.get("provider")
        if provider in PROVIDERS:
            settings["active_provider"] = provider
        model = override.get("model")
        if model:
            settings[f"{settings['active_provider']}_model"] = model
    return settings


def _override_from(body: dict) -> dict | None:
    provider, model = body.get("provider"), body.get("model")
    return {"provider": provider, "model": model} if (provider or model) else None


async def _agent_events(
    messages: list[dict], tools: list | None, max_tokens: int,
    no_thinking: bool = False, override: dict | None = None,
    max_rounds: int = MAX_TOOL_ROUNDS,
):
    """Run the selected provider and yield UI events."""
    settings = _resolve_settings(override)
    try:
        if settings["active_provider"] == "gemini":
            gen = _gemini_events(messages, tools, settings, max_tokens, no_thinking, max_rounds)
        else:
            gen = _openai_compatible_events(messages, tools, settings, max_tokens, no_thinking, max_rounds)
        async for event in gen:
            yield event
    except httpx.ConnectError:
        yield {
            "type": "error",
            "detail": "Could not reach the selected AI provider. Check its connection and settings.",
        }
    except Exception as exc:
        logger.exception("Agent run failed")
        yield {"type": "error", "detail": str(exc)}


def _ndjson(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


@router.post("/chat")
async def agent_chat(request: Request):
    body = await request.json()
    mode = body.get("mode", "chat")
    note = body.get("note") or {}
    history = body.get("messages") or []
    override = _override_from(body)

    note_content = (note.get("content") or "").strip()

    if mode == "continue":
        if not note_content:
            raise HTTPException(status_code=400, detail="The note is empty — write a few words first.")
        messages = [
            {"role": "system", "content": CONTINUE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Continue this note:\n\n{note_content[-NOTE_CONTEXT_LIMIT:]}"},
        ]
        tools = None
        # Brevity is enforced by the prompt; the budget just needs to be large
        # enough that a reasoning model's hidden thinking doesn't crowd out the
        # short continuation. Gemini additionally has thinking disabled below.
        max_tokens = 1024
        no_thinking = True
    else:
        system = CHAT_SYSTEM_PROMPT
        if note_content:
            title = (note.get("note") or "untitled").removesuffix(".md")
            system += f"\n\n--- Current note: {title} ---\n{note_content[-NOTE_CONTEXT_LIMIT:]}"
        messages = [{"role": "system", "content": system}]
        for msg in history[-12:]:
            if msg.get("role") in ("user", "assistant") and isinstance(msg.get("content"), str):
                messages.append({"role": msg["role"], "content": msg["content"]})
        tools = TOOLS
        # Room for live reasoning plus a multi-tool agent run before the answer.
        max_tokens = 2048
        no_thinking = False

    return StreamingResponse(
        (_ndjson(event) async for event in _agent_events(messages, tools, max_tokens, no_thinking, override)),
        media_type="application/x-ndjson",
    )


# ── Deep research (background agent) ─────────────────────────
RESEARCH_SYSTEM_PROMPT = """You are a deep-research agent inside EverFree, a Markdown note-taking app.
You are given a topic. Investigate it thoroughly, then produce a well-structured Markdown report the user can keep as a note.

Method:
- Plan the questions you need to answer.
- Use web_search to find sources, then read_page on the most credible ones before drawing conclusions. Corroborate important claims across more than one source.
- Use search_notes / read_note to fold in anything relevant the user has already written.
- Keep going until you can write a confident, specific report — don't stop after a single search.

Output: a Markdown document that starts with a '# ' title, uses clear sections and bullet points where useful, and ends with a '## Sources' list of the pages you actually used as Markdown links. Write the report itself as your final message — no meta commentary about the process."""

# In-memory mirror of job records + their live asyncio tasks. Records also
# persist to RESEARCH_DIR so they survive panel close, note switches, restarts.
RESEARCH_JOBS: dict[str, dict] = {}
RESEARCH_TASKS: dict[str, asyncio.Task] = {}


def _ensure_research_dir() -> None:
    RESEARCH_DIR.mkdir(parents=True, exist_ok=True)


def _safe_research_path(job_id: str) -> Path:
    if not re.match(r"^[A-Za-z0-9_-]{1,128}$", job_id or ""):
        raise HTTPException(status_code=400, detail="Invalid research id")
    return RESEARCH_DIR / f"{job_id}.json"


def _save_research(job: dict) -> None:
    _ensure_research_dir()
    job["updated_at"] = time.time()
    _safe_research_path(job["id"]).write_text(json.dumps(job, ensure_ascii=False, indent=2))


def _research_log(job: dict, entry: dict) -> None:
    entry["at"] = time.time()
    job.setdefault("events", []).append(entry)
    _save_research(job)


def _finish_research(job: dict, status: str, result: str = "", error: str = "") -> None:
    job["status"] = status
    if result:
        job["result"] = result
    if error:
        job["error"] = error
    _save_research(job)


def _research_summary(job: dict) -> dict:
    return {
        "id": job["id"],
        "topic": job.get("topic", ""),
        "notebook": job.get("notebook", ""),
        "note": job.get("note", ""),
        "status": job.get("status"),
        "new_note": job.get("new_note", ""),
        "provider": job.get("provider", ""),
        "error": job.get("error", ""),
        "event_count": len(job.get("events") or []),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
    }


def _load_research(job_id: str) -> dict | None:
    if job_id in RESEARCH_JOBS:
        return RESEARCH_JOBS[job_id]
    path = _safe_research_path(job_id)
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return None
    return None


def _all_research_jobs() -> list[dict]:
    jobs = dict(RESEARCH_JOBS)
    _ensure_research_dir()
    for path in RESEARCH_DIR.glob("*.json"):
        if path.stem in jobs:
            continue
        try:
            jobs[path.stem] = json.loads(path.read_text())
        except Exception:
            continue
    return list(jobs.values())


def _reap_stale_research() -> None:
    """A job persisted as 'running' with no live task in this process means the
    server restarted mid-run. Mark it interrupted so it never shows a phantom
    spinner forever."""
    for job in _all_research_jobs():
        if job.get("status") == "running" and job["id"] not in RESEARCH_TASKS:
            job["status"] = "interrupted"
            job["error"] = job.get("error") or "The server restarted before this run finished."
            RESEARCH_JOBS[job["id"]] = job
            _save_research(job)


async def _run_research(job_id: str) -> None:
    job = RESEARCH_JOBS.get(job_id)
    if not job:
        return
    settings = _load_settings()
    provider = settings["research_provider"] or settings["active_provider"]
    override = {"provider": provider, "model": settings["research_model"] or None}

    messages = [
        {"role": "system", "content": RESEARCH_SYSTEM_PROMPT},
        {"role": "user", "content": f"Research topic:\n\n{job['topic']}"},
    ]
    report, last_error = "", ""
    try:
        async for event in _agent_events(
            messages, RESEARCH_TOOLS, max_tokens=4096,
            no_thinking=False, override=override, max_rounds=RESEARCH_MAX_ROUNDS,
        ):
            etype = event.get("type")
            if etype == "delta":
                report += event["text"]
            elif etype == "tool":
                _research_log(job, {"type": "tool", "name": event.get("name"), "detail": event.get("detail", "")})
            elif etype == "error":
                last_error = event.get("detail", "")
                _research_log(job, {"type": "error", "detail": last_error})

        report = report.strip()
        if not report:
            _finish_research(job, status="error", error=last_error or "The research run produced no report.")
            return

        notebook = job.get("notebook") or "Research"
        try:
            name = await _create_note_file(notebook, f"Research — {job['topic'][:60]}", report)
            job["new_note"] = name
            job["notebook"] = notebook
            _research_log(job, {"type": "note", "detail": f"{notebook}/{name}"})
        except Exception as exc:
            _research_log(job, {"type": "error", "detail": f"Could not save the report as a note: {exc}"})
        _finish_research(job, status="done", result=report)
    except Exception as exc:
        logger.exception("Research job failed")
        _finish_research(job, status="error", error=str(exc))
    finally:
        RESEARCH_TASKS.pop(job_id, None)


@router.post("/research")
async def start_research(request: Request):
    body = await request.json()
    topic = (body.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="A research topic is required")
    settings = _load_settings()
    provider = settings["research_provider"] or settings["active_provider"]
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "topic": topic,
        "notebook": (body.get("notebook") or "").strip(),
        "note": (body.get("note") or "").strip(),
        "provider": provider,
        "status": "running",
        "events": [],
        "result": "",
        "new_note": "",
        "error": "",
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    RESEARCH_JOBS[job_id] = job
    _save_research(job)
    RESEARCH_TASKS[job_id] = asyncio.create_task(_run_research(job_id))
    return _research_summary(job)


@router.get("/research")
async def list_research(notebook: str = "", note: str = ""):
    _reap_stale_research()
    out = [
        _research_summary(job)
        for job in _all_research_jobs()
        if (not notebook or job.get("notebook") == notebook)
        and (not note or job.get("note") == note)
    ]
    out.sort(key=lambda j: j.get("updated_at") or 0, reverse=True)
    return out


@router.get("/research/{job_id}")
async def get_research(job_id: str):
    job = _load_research(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Research job not found")
    return job


# ── Image generation (OpenRouter → Gemini) ───────────────────
@router.post("/image")
async def agent_image(request: Request):
    body = await request.json()
    prompt = (body.get("prompt") or "").strip()
    notebook = (body.get("notebook") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Image prompt is required")
    if not notebook:
        raise HTTPException(status_code=400, detail="Open a note first so the image can be saved next to it")

    settings = _load_settings()
    if not settings["openrouter_api_key"]:
        raise HTTPException(status_code=400, detail="No OpenRouter API key configured in assistant settings")

    notes_root = NOTES_DIR.resolve()
    notebook_dir = (NOTES_DIR / notebook).resolve()
    if notebook_dir == notes_root or not notebook_dir.is_relative_to(notes_root) or not notebook_dir.is_dir():
        raise HTTPException(status_code=404, detail="Notebook not found")

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {settings['openrouter_api_key']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": settings["image_model"],
                    "messages": [{"role": "user", "content": prompt}],
                    "modalities": ["image", "text"],
                },
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach OpenRouter: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"OpenRouter error HTTP {resp.status_code}: {resp.text[:300]}")

    message = (resp.json().get("choices") or [{}])[0].get("message", {})
    images = message.get("images") or []
    if not images:
        text = (message.get("content") or "no image returned").strip()
        raise HTTPException(status_code=502, detail=f"Model returned no image: {text[:200]}")

    image_url = images[0].get("image_url", {}).get("url", "")
    match = re.match(r"^data:image/(\w+);base64,(.+)$", image_url, re.DOTALL)
    if not match:
        raise HTTPException(status_code=502, detail="Unexpected image format from OpenRouter")

    ext = {"jpeg": "jpg"}.get(match.group(1), match.group(1))
    filename = f"agent-{time.strftime('%Y%m%d-%H%M%S')}.{ext}"
    assets_dir = notebook_dir / "assets"
    assets_dir.mkdir(exist_ok=True)
    (assets_dir / filename).write_bytes(base64.b64decode(match.group(2)))

    rel_path = f"assets/{filename}"
    return {
        "markdown": f"![{prompt[:60]}]({rel_path})",
        "rel_path": rel_path,
        "preview_url": f"/notes/{quote(notebook)}/{rel_path}",
    }
