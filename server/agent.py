"""
EverFree — Writing Assist Agent

Local-first agent: text generation and the search tool-loop run against an
LM Studio server (OpenAI-compatible API on localhost). Image generation goes
through OpenRouter (Gemini image model, "nano banana"). Web search uses
Serper, and result pages are fetched and reduced to readable text with a
stdlib HTML parser so no extra dependencies enter the py2app bundle.

Settings (LM Studio URL/model, OpenRouter + Serper keys) live in
~/.everfree_agent.json, managed through /api/agent/settings.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
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

DEFAULT_SETTINGS = {
    "lmstudio_url": "http://localhost:1234/v1",
    "lmstudio_model": "",
    "openrouter_api_key": "",
    "serper_api_key": "",
    "image_model": "google/gemini-2.5-flash-image",
}

MAX_TOOL_ROUNDS = 6
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
        "lmstudio_url": settings["lmstudio_url"],
        "lmstudio_model": settings["lmstudio_model"],
        "image_model": settings["image_model"],
        "openrouter_api_key_set": bool(settings["openrouter_api_key"]),
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
    _save_settings(settings)
    return _public_settings(settings)


@router.get("/status")
async def agent_status():
    settings = _load_settings()
    base_url = settings["lmstudio_url"].rstrip("/")
    reachable = False
    models: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(f"{base_url}/models")
        if resp.status_code == 200:
            reachable = True
            models = [m.get("id", "") for m in resp.json().get("data", [])]
    except Exception:
        pass
    return {
        "lmstudio_reachable": reachable,
        "models": models,
        "openrouter_api_key_set": bool(settings["openrouter_api_key"]),
        "serper_api_key_set": bool(settings["serper_api_key"]),
    }


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
]


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


# ── Prompts ──────────────────────────────────────────────────
CHAT_SYSTEM_PROMPT = """You are the writing assistant built into EverFree, a Markdown note-taking app.
The user is writing a note; its current content may be provided below. Match its tone, voice, and formatting.

You have tools: web_search (Google search) and read_page (fetch a page's readable text).
When the user asks you to research or search a topic, first call web_search, then call read_page on the 2-3 most promising results, then write your answer grounded in what you read.
When you researched online, end your passage with a "Sources:" line listing the pages you used as Markdown links.

Your final reply is inserted directly into the note, so reply with clean Markdown only — no preamble like "Here is...", no code fences wrapping the whole reply, no commentary about what you did."""

CONTINUE_SYSTEM_PROMPT = """You are the writing assistant built into EverFree, a Markdown note-taking app.
Continue the user's note from exactly where it stops. If the last sentence is unfinished, finish it first, then continue with one or two more sentences or a short paragraph in the same voice, tone, and formatting.
Reply with the continuation text only — no preamble, no quotes, and do not repeat any of the existing text."""


# ── Agent loop ───────────────────────────────────────────────
async def _resolve_model(client: httpx.AsyncClient, base_url: str, settings: dict) -> str:
    if settings["lmstudio_model"]:
        return settings["lmstudio_model"]
    resp = await client.get(f"{base_url}/models")
    resp.raise_for_status()
    models = resp.json().get("data", [])
    if not models:
        raise RuntimeError("No model is loaded in LM Studio.")
    return models[0]["id"]


async def _agent_events(messages: list[dict], use_tools: bool):
    """Run the LM Studio tool-call loop, yielding UI events as dicts."""
    settings = _load_settings()
    base_url = settings["lmstudio_url"].rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            model = await _resolve_model(client, base_url, settings)

            for _ in range(MAX_TOOL_ROUNDS):
                payload = {
                    "model": model,
                    "messages": messages,
                    "stream": True,
                    "temperature": 0.7,
                }
                if use_tools:
                    payload["tools"] = TOOLS

                content_parts: list[str] = []
                tool_calls: dict[int, dict] = {}
                finish_reason = None

                async with client.stream(
                    "POST", f"{base_url}/chat/completions", json=payload
                ) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        raise RuntimeError(f"LM Studio error HTTP {resp.status_code}: {body[:300]}")
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except ValueError:
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        if delta.get("content"):
                            content_parts.append(delta["content"])
                            yield {"type": "delta", "text": delta["content"]}
                        for tc in delta.get("tool_calls") or []:
                            slot = tool_calls.setdefault(
                                tc.get("index", 0), {"id": "", "name": "", "arguments": ""}
                            )
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
                        if choice.get("finish_reason"):
                            finish_reason = choice["finish_reason"]

                if finish_reason != "tool_calls" or not tool_calls:
                    yield {"type": "done"}
                    return

                assistant_msg = {
                    "role": "assistant",
                    "content": "".join(content_parts) or None,
                    "tool_calls": [
                        {
                            "id": slot["id"] or f"call_{i}",
                            "type": "function",
                            "function": {"name": slot["name"], "arguments": slot["arguments"]},
                        }
                        for i, slot in sorted(tool_calls.items())
                    ],
                }
                messages.append(assistant_msg)

                for call in assistant_msg["tool_calls"]:
                    name = call["function"]["name"]
                    try:
                        args = json.loads(call["function"]["arguments"] or "{}")
                    except ValueError:
                        args = {}
                    if name == "web_search":
                        detail = args.get("query", "")
                        yield {"type": "tool", "name": name, "detail": detail}
                        result = await _tool_web_search(detail, settings)
                    elif name == "read_page":
                        detail = args.get("url", "")
                        yield {"type": "tool", "name": name, "detail": detail}
                        result = await _tool_read_page(detail)
                    else:
                        result = f"Error: unknown tool {name}"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": result,
                    })

            yield {"type": "error", "detail": "The agent hit the tool-call limit without finishing."}
    except httpx.ConnectError:
        yield {
            "type": "error",
            "detail": f"Could not reach LM Studio at {base_url}. Start LM Studio, load a model, "
                      "and enable its local server (or fix the URL in assistant settings).",
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

    note_content = (note.get("content") or "").strip()

    if mode == "continue":
        if not note_content:
            raise HTTPException(status_code=400, detail="The note is empty — write a few words first.")
        messages = [
            {"role": "system", "content": CONTINUE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Continue this note:\n\n{note_content[-NOTE_CONTEXT_LIMIT:]}"},
        ]
        use_tools = False
    else:
        system = CHAT_SYSTEM_PROMPT
        if note_content:
            title = (note.get("note") or "untitled").removesuffix(".md")
            system += f"\n\n--- Current note: {title} ---\n{note_content[-NOTE_CONTEXT_LIMIT:]}"
        messages = [{"role": "system", "content": system}]
        for msg in history[-12:]:
            if msg.get("role") in ("user", "assistant") and isinstance(msg.get("content"), str):
                messages.append({"role": msg["role"], "content": msg["content"]})
        use_tools = True

    return StreamingResponse(
        (_ndjson(event) async for event in _agent_events(messages, use_tools)),
        media_type="application/x-ndjson",
    )


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

    notebook_dir = (NOTES_DIR / notebook).resolve()
    if not str(notebook_dir).startswith(str(NOTES_DIR.resolve())) or not notebook_dir.is_dir():
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
