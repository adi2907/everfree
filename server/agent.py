"""
EverFree — Writing Assist Agent

One provider: Google's Gemini API, reached with the user's own API key. The
agent's tools are the user's own notes — searching, reading, and creating them.
There is no web access and no image generation (Gemini's image models require a
billing-enabled key, so the free key this app assumes cannot use them).

Settings (the model name and the API key) live in ~/.everfree_agent.json,
managed through /api/agent/settings.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path

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
    "gemini_api_key": "",
    "gemini_model": "gemini-2.5-flash",
}

# Chat allows a handful of tool rounds so the agent can read a few of your other
# notes before it answers.
MAX_TOOL_ROUNDS = 8
NOTE_CONTEXT_LIMIT = 8000
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
        "gemini_model": settings["gemini_model"],
        "gemini_api_key_set": bool(settings["gemini_api_key"]),
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
    ready = bool(settings["gemini_api_key"] and settings["gemini_model"])
    return {
        "model": settings["gemini_model"],
        "ready": ready,
        "detail": "" if ready else "Add a Google Gemini API key and select a model.",
    }


@router.post("/models")
async def gemini_models(request: Request):
    """Return the Gemini models that can generate content, for the model picker."""
    settings = _load_settings()
    body = await request.json()
    api_key = (body.get("api_key") or settings["gemini_api_key"]).strip()
    if not api_key:
        return {"models": []}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key, "pageSize": 1000},
            )
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not load Gemini models: {exc}") from exc
    models = [
        m.get("baseModelId") or m.get("name", "").removeprefix("models/")
        for m in resp.json().get("models", [])
        if "generateContent" in (m.get("supportedGenerationMethods") or [])
    ]
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


# ── Agent tools ──────────────────────────────────────────────
TOOLS = [
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
    Raises on invalid input. Backs the create_note tool."""
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


# ── Prompts ──────────────────────────────────────────────────
# The prompt text is shared with the web/mobile assistant and lives in exactly
# one place: web/lib/prompts.json. It sits under web/ because Vercel deploys
# from that directory only, so nothing above it reaches production; the desktop
# build copies it into the .app bundle (see packaging/setup_py2app.py), which is
# why the frozen path differs. Mirrors the FRONTEND_DIR pattern in server/app.py.
if os.environ.get("RESOURCEPATH"):
    PROMPTS_FILE = Path(os.environ["RESOURCEPATH"]) / "prompts" / "prompts.json"
else:
    PROMPTS_FILE = Path(__file__).resolve().parent.parent / "web" / "lib" / "prompts.json"

try:
    _PROMPTS = json.loads(PROMPTS_FILE.read_text(encoding="utf-8"))
    _PROMPTS_ERROR = None
except (OSError, ValueError) as exc:
    # This module is imported by server.app at startup, so raising here would
    # stop EverFree from launching at all — notes, sync and every other feature
    # taken down by one missing data file. A bundle that shipped without
    # prompts.json should cost the user the assistant, nothing more.
    _PROMPTS = None
    _PROMPTS_ERROR = f"{PROMPTS_FILE}: {exc}"
    logging.getLogger("everfree.agent").error(
        "Assistant prompts could not be loaded (%s); the assistant is disabled.",
        _PROMPTS_ERROR,
    )


def _build_chat_prompt(prompts: dict) -> str:
    """Assemble the desktop chat prompt from the shared parts. Desktop reaches
    the user's notes on disk, so it takes the note bullets; web/mobile has no
    tools at all and drops that whole section — see buildChatPrompt in
    web/lib/agent-core.js."""
    chat = prompts["chat"]
    tools = chat["tools"]
    bullets = [tools["notes"], tools["create_note"]]
    return "\n\n".join([
        chat["intro"],
        chat["think"]["desktop"],
        chat["tools_header"] + "\n" + "\n".join(bullets),
        chat["no_images"],
        chat["language_rule"],
        chat["style"],
    ])


if _PROMPTS is None:
    CHAT_SYSTEM_PROMPT = CONTINUE_SYSTEM_PROMPT = COMPLETE_SYSTEM_PROMPT = None
else:
    CHAT_SYSTEM_PROMPT = _build_chat_prompt(_PROMPTS)
    CONTINUE_SYSTEM_PROMPT = _PROMPTS["continue"]
    COMPLETE_SYSTEM_PROMPT = _PROMPTS["complete"]


def _require_prompts() -> None:
    """Refuse assistant requests when the prompt file is unavailable.

    Sending an empty system prompt would be worse than refusing: the model
    still answers, just without any of the rules the prompts encode.
    """
    if _PROMPTS is None:
        raise HTTPException(
            status_code=503,
            detail="The assistant is unavailable: its prompt file could not be loaded.",
        )


# ── Agent loop ───────────────────────────────────────────────
async def _run_tool(name: str, args: dict) -> tuple[str, str]:
    """Run a tool. Returns (detail, model-facing result), where `detail` is the
    short label the UI shows beside the tool line."""
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
        raise RuntimeError("Add a Google Gemini API key in assistant settings.")
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
                detail, result = await _run_tool(name, args)
                yield {"type": "tool", "name": name, "detail": detail}
                response_parts.append({
                    "functionResponse": {"name": name, "response": {"result": result}}
                })
            contents.append({"role": "user", "parts": response_parts})

        yield {"type": "error", "detail": "The agent hit the tool-call limit without finishing."}


async def _agent_events(
    messages: list[dict], tools: list | None, max_tokens: int,
    no_thinking: bool = False, max_rounds: int = MAX_TOOL_ROUNDS,
):
    """Run the agent against Gemini and yield UI events."""
    settings = _load_settings()
    try:
        async for event in _gemini_events(
            messages, tools, settings, max_tokens, no_thinking, max_rounds
        ):
            yield event
    except httpx.ConnectError:
        yield {
            "type": "error",
            "detail": "Could not reach the Gemini API. Check your connection and API key.",
        }
    except Exception as exc:
        logger.exception("Agent run failed")
        yield {"type": "error", "detail": str(exc)}


def _ndjson(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


@router.post("/chat")
async def agent_chat(request: Request):
    _require_prompts()
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
        tools = None
        # Brevity is enforced by the prompt; the budget just needs to be large
        # enough that a reasoning model's hidden thinking doesn't crowd out the
        # short continuation. Gemini additionally has thinking disabled below.
        max_tokens = 1024
        no_thinking = True
    elif mode == "complete":
        selection = (body.get("selection") or "").strip()
        if not selection:
            raise HTTPException(status_code=400, detail="Select a passage in your note first.")
        # The rest of the note gives the model the subject; the selection tail
        # is repeated last so "pick up where it stops" is unambiguous.
        user_parts = []
        if note_content and note_content != selection:
            user_parts.append(f"The full note, for context only:\n\n{note_content[-NOTE_CONTEXT_LIMIT:]}")
        user_parts.append(f"Complete this selected passage:\n\n{selection[-NOTE_CONTEXT_LIMIT:]}")
        messages = [
            {"role": "system", "content": COMPLETE_SYSTEM_PROMPT},
            {"role": "user", "content": "\n\n".join(user_parts)},
        ]
        tools = None
        max_tokens = 1024
        no_thinking = True
    else:
        system = CHAT_SYSTEM_PROMPT
        notebook = (note.get("notebook") or "").strip()
        if note_content:
            title = (note.get("note") or "untitled").removesuffix(".md")
            where = f"{notebook} / {title}" if notebook else title
            system += f"\n\n--- Current note: {where} ---\n{note_content[-NOTE_CONTEXT_LIMIT:]}"
        messages = [{"role": "system", "content": system}]
        for msg in history[-12:]:
            if msg.get("role") in ("user", "assistant") and isinstance(msg.get("content"), str):
                messages.append({"role": msg["role"], "content": msg["content"]})
        tools = TOOLS
        # Room for live reasoning plus a multi-tool agent run before the answer.
        max_tokens = 2048
        no_thinking = False

    return StreamingResponse(
        (_ndjson(event) async for event in
         _agent_events(messages, tools, max_tokens, no_thinking)),
        media_type="application/x-ndjson",
    )
