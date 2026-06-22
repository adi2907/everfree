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
    "active_provider": "lmstudio",
    "lmstudio_url": "http://localhost:1234/v1",
    "lmstudio_model": "",
    "openrouter_api_key": "",
    "openrouter_model": "",
    "gemini_api_key": "",
    "gemini_model": "gemini-2.5-flash",
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
        "active_provider": settings["active_provider"],
        "lmstudio_url": settings["lmstudio_url"],
        "lmstudio_model": settings["lmstudio_model"],
        "openrouter_model": settings["openrouter_model"],
        "gemini_model": settings["gemini_model"],
        "image_model": settings["image_model"],
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
    if settings["active_provider"] not in {"lmstudio", "openrouter", "gemini"}:
        raise HTTPException(status_code=400, detail="Invalid AI provider")
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


async def _openai_compatible_events(
    messages: list[dict], use_tools: bool, settings: dict, max_tokens: int,
    no_thinking: bool = False,
):
    """Run a non-streaming OpenAI-compatible tool loop.

    The endpoint response is buffered so the UI receives complete passages
    instead of visually filling them in word by word. (`no_thinking` has no
    portable equivalent here, so continuations rely on a generous token budget
    to leave room for any reasoning the model does.)
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

        for _ in range(MAX_TOOL_ROUNDS):
            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.7,
                "max_tokens": max_tokens,
            }
            if use_tools:
                payload["tools"] = TOOLS

            resp = await client.post(f"{base_url}/chat/completions", json=payload)
            if resp.status_code != 200:
                label = "LM Studio" if provider == "lmstudio" else "OpenRouter"
                raise RuntimeError(f"{label} error HTTP {resp.status_code}: {resp.text[:300]}")

            choices = resp.json().get("choices") or []
            if not choices:
                raise RuntimeError("The model returned no response.")
            message = choices[0].get("message") or {}
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                text = message.get("content") or ""
                if text:
                    yield {"type": "delta", "text": text}
                    yield {"type": "done"}
                else:
                    yield _empty_completion_event(choices[0].get("finish_reason"))
                return

            messages.append(message)
            for i, call in enumerate(tool_calls):
                fn = call.get("function") or {}
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                detail, result = await _run_tool(name, args, settings)
                yield {"type": "tool", "name": name, "detail": detail}
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id") or f"call_{i}",
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


def _gemini_tools() -> list[dict]:
    return [{
        "functionDeclarations": [
            {
                "name": tool["function"]["name"],
                "description": tool["function"]["description"],
                "parameters": tool["function"]["parameters"],
            }
            for tool in TOOLS
        ]
    }]


async def _gemini_events(
    messages: list[dict], use_tools: bool, settings: dict, max_tokens: int,
    no_thinking: bool = False,
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
        f"{model}:generateContent"
    )

    async with httpx.AsyncClient(
        timeout=LLM_TIMEOUT,
        headers={"x-goog-api-key": settings["gemini_api_key"]},
    ) as client:
        for _ in range(MAX_TOOL_ROUNDS):
            generation_config = {
                "temperature": 0.7,
                "maxOutputTokens": max_tokens,
            }
            # Gemini 2.5 models "think" by default, and thinking tokens count
            # against maxOutputTokens — for a short continuation that can consume
            # the whole budget and return empty text. Disable thinking there.
            if no_thinking:
                generation_config["thinkingConfig"] = {"thinkingBudget": 0}
            payload = {
                "contents": contents,
                "generationConfig": generation_config,
            }
            if system_instruction:
                payload["systemInstruction"] = system_instruction
            if use_tools:
                payload["tools"] = _gemini_tools()

            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"Gemini error HTTP {resp.status_code}: {resp.text[:300]}")
            candidates = resp.json().get("candidates") or []
            if not candidates:
                raise RuntimeError("Gemini returned no response.")
            content = candidates[0].get("content") or {}
            parts = content.get("parts") or []
            function_calls = [part["functionCall"] for part in parts if part.get("functionCall")]
            if not function_calls:
                text = "".join(part.get("text", "") for part in parts)
                if text:
                    yield {"type": "delta", "text": text}
                    yield {"type": "done"}
                else:
                    yield _empty_completion_event(candidates[0].get("finishReason"))
                return

            contents.append({"role": "model", "parts": parts})
            response_parts = []
            for call in function_calls:
                name = call.get("name", "")
                args = call.get("args") or {}
                detail, result = await _run_tool(name, args, settings)
                yield {"type": "tool", "name": name, "detail": detail}
                response_parts.append({
                    "functionResponse": {
                        "name": name,
                        "response": {"result": result},
                    }
                })
            contents.append({"role": "user", "parts": response_parts})

        yield {"type": "error", "detail": "The agent hit the tool-call limit without finishing."}


async def _agent_events(messages: list[dict], use_tools: bool, max_tokens: int, no_thinking: bool = False):
    """Run the selected provider and yield UI events."""
    settings = _load_settings()
    try:
        if settings["active_provider"] == "gemini":
            async for event in _gemini_events(messages, use_tools, settings, max_tokens, no_thinking):
                yield event
        else:
            async for event in _openai_compatible_events(messages, use_tools, settings, max_tokens, no_thinking):
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

    note_content = (note.get("content") or "").strip()

    if mode == "continue":
        if not note_content:
            raise HTTPException(status_code=400, detail="The note is empty — write a few words first.")
        messages = [
            {"role": "system", "content": CONTINUE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Continue this note:\n\n{note_content[-NOTE_CONTEXT_LIMIT:]}"},
        ]
        use_tools = False
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
        use_tools = True
        max_tokens = 1200
        no_thinking = False

    return StreamingResponse(
        (_ndjson(event) async for event in _agent_events(messages, use_tools, max_tokens, no_thinking)),
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
