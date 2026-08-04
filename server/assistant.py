"""Minimal chat and web search for EverFree.

The assistant cannot read any note except the current note supplied by the
client. An ordinary turn has no tools at all: it answers from the note, the
selection, and the conversation alone, and walks the configured Gemini models,
falling through to the next on a daily-quota 429.

An explicit /search turn goes somewhere else entirely — OpenRouter, which runs
the web search and hands the results to a model that reads them. That path
needs its own key, so /search stays unavailable until one is stored; the two
providers never share a key. Both keys are supplied per request and neither is
ever stored by the server.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/assistant")

if os.environ.get("RESOURCEPATH"):
    CONFIG_FILE = Path(os.environ["RESOURCEPATH"]) / "frontend" / "assistant-config.json"
else:
    CONFIG_FILE = Path(__file__).resolve().parent.parent / "web" / "lib" / "assistant-config.json"

# The standing prompt keeps its own "no web access" line, and a search turn
# appends this to lift it. That direction matters: a build that predates /search
# reads only `system_prompt`, so leaving the restriction there keeps such a build
# correct when it fetches a config written for this one. The default has to carry
# the whole instruction — a search turn not told to cite stops citing, and the
# sources the client renders no longer match the prose.
DEFAULT_SEARCH_NOTE = (
    "This turn is the exception to the no-web-access rule stated above: you have web "
    "search, and search results are supplied to you. Disregard only that restriction — "
    "every other instruction above still applies. Ground every factual claim in the "
    "search results and cite its source as a Markdown link. Where the results do not "
    "cover something, say so plainly instead of filling the gap from memory."
)

BUNDLED_CONFIG_TEXT = CONFIG_FILE.read_text(encoding="utf-8")
CONFIG = json.loads(BUNDLED_CONFIG_TEXT)
CHAT_MODELS = CONFIG["chat_models"]
SEARCH_MODELS = CONFIG["search_models"]
SYSTEM_PROMPT = CONFIG["system_prompt"]
SEARCH_NOTE = CONFIG.get("search_note") or DEFAULT_SEARCH_NOTE
SEARCH_MAX_RESULTS = CONFIG.get("search_max_results") or 8

# The desktop app ships a copy of this file inside the .app, so a model or
# prompt change used to need a new DMG. The web deployment serves the current
# config publicly, so refresh from there in the background after startup. The
# URL is a constant on purpose: the system prompt is fetched code, and there
# must be no runtime way to point the app at a different one.
CONFIG_URL = "https://everfree.vercel.app/lib/assistant-config.json"
CONFIG_CACHE_FILE = Path.home() / ".everfree_assistant_config.json"
CONFIG_FETCH_TIMEOUT = 5.0
CONFIG_MAX_BYTES = 256 * 1024

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

NOTE_LIMIT = 60_000
SELECTION_LIMIT = 20_000
MESSAGE_LIMIT = 20_000
HISTORY_LIMIT = 20
TIMEOUT = httpx.Timeout(180.0, connect=10.0)
# A search turn runs a web search and then reads the results, so it is slow by
# construction: the free model measured near 90 seconds. Give it room rather
# than cutting off an answer that is still coming.
SEARCH_TIMEOUT = httpx.Timeout(300.0, connect=10.0)


class DailyQuotaExceeded(Exception):
    """The selected model's request-per-day quota has been exhausted."""


class ChainExhausted(Exception):
    """Every configured model is out of daily quota."""


class SearchUnavailable(Exception):
    """An OpenRouter search model was rate-limited or refused the request."""


# ── Assistant config refresh ─────────────────────────────────

def _is_desktop_build() -> bool:
    """Only the packaged .app has a config frozen at build time."""
    return bool(os.environ.get("RESOURCEPATH"))


def _valid_config(data: object) -> dict | None:
    """Return the config only if it is complete enough to serve requests.

    A malformed or truncated download must never take the assistant down, so
    anything short of a full config is discarded and the caller keeps what it
    already has.
    """
    if not isinstance(data, dict):
        return None
    for key in ("chat_models", "search_models"):
        models = data.get(key)
        if not isinstance(models, list) or not models:
            return None
        for model in models:
            if not isinstance(model, dict):
                return None
            if not all(isinstance(model.get(field), str) and model[field].strip()
                       for field in ("id", "name")):
                return None
    prompt = data.get("system_prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    return data


def _apply_config(config: dict) -> None:
    global CONFIG, CHAT_MODELS, SEARCH_MODELS, SYSTEM_PROMPT
    global SEARCH_NOTE, SEARCH_MAX_RESULTS
    CONFIG = config
    CHAT_MODELS = config["chat_models"]
    SEARCH_MODELS = config["search_models"]
    SYSTEM_PROMPT = config["system_prompt"]
    SEARCH_NOTE = config.get("search_note") or DEFAULT_SEARCH_NOTE
    SEARCH_MAX_RESULTS = config.get("search_max_results") or 8


def _bundled_fingerprint() -> str:
    return hashlib.sha256(BUNDLED_CONFIG_TEXT.encode("utf-8")).hexdigest()


def _read_cached_config() -> dict | None:
    """The last config fetched successfully, so an offline restart is current.

    The cache records which bundled config it was fetched against. After an app
    upgrade the fingerprints differ and the cache is dropped, so a newly
    bundled config is never shadowed by an older download.
    """
    try:
        cached = json.loads(CONFIG_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(cached, dict) or cached.get("bundled") != _bundled_fingerprint():
        return None
    return _valid_config(cached.get("config"))


def _write_cached_config(config: dict) -> None:
    try:
        CONFIG_CACHE_FILE.write_text(json.dumps({
            "bundled": _bundled_fingerprint(),
            "fetched_at": time.time(),
            "config": config,
        }), encoding="utf-8")
    except OSError as exc:
        logger.info("Could not cache assistant config: %s", exc)


async def _fetch_config() -> dict | None:
    """Download the deployed config. Offline, slow, or 404 returns None."""
    async with httpx.AsyncClient(
        timeout=CONFIG_FETCH_TIMEOUT, follow_redirects=False,
    ) as client:
        response = await client.get(CONFIG_URL)
    if response.status_code != 200:
        logger.info("Assistant config fetch returned %s", response.status_code)
        return None
    if len(response.content) > CONFIG_MAX_BYTES:
        logger.info("Assistant config fetch was oversized (%d bytes)", len(response.content))
        return None
    try:
        return json.loads(response.content.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.info("Assistant config fetch was not valid JSON")
        return None


async def refresh_config() -> bool:
    """Swap in the newest valid config. Never raises; returns True on a swap."""
    applied = False
    cached = _read_cached_config()
    if cached is not None:
        _apply_config(cached)
        applied = True
    try:
        fetched = _valid_config(await _fetch_config())
    except Exception as exc:  # offline, DNS failure, timeout, TLS error
        logger.info("Assistant config fetch failed: %s", exc)
        return applied
    if fetched is None:
        return applied
    _apply_config(fetched)
    _write_cached_config(fetched)
    logger.info("Assistant config refreshed from %s", CONFIG_URL)
    return True


def start_config_refresh() -> asyncio.Task | None:
    """Refresh in the background so startup never waits on the network."""
    if not _is_desktop_build():
        return None

    async def _run():
        try:
            await refresh_config()
        except Exception as exc:  # a config refresh must never surface an error
            logger.info("Assistant config refresh failed: %s", exc)

    return asyncio.create_task(_run())


def _text(value: object, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _context_blocks(note: dict, selection: dict, search: bool) -> list[str]:
    """The system text both providers share, in the same order.

    A chat turn adds nothing: the standing prompt already forbids claiming web
    access. Only a search turn appends, lifting that one restriction.
    """
    notebook = _text(note.get("notebook"), 500).strip()
    name = _text(note.get("note"), 500).strip() or "Untitled note"
    content = _text(note.get("content"), NOTE_LIMIT)
    selected = _text(selection.get("text"), SELECTION_LIMIT)
    location = f"{notebook} / {name}" if notebook else name
    note_context = "\n".join([
        f"<current_note name={json.dumps(location)}>",
        content or "(empty note)",
        "</current_note>",
    ])
    if selected.strip():
        selection_context = "\n".join(["<selected_text>", selected, "</selected_text>"])
    else:
        selection_context = "<selected_text>(none)</selected_text>"
    blocks = [SYSTEM_PROMPT, note_context, selection_context]
    if search:
        blocks.append(SEARCH_NOTE)
    return blocks


def _system_parts(note: dict, selection: dict) -> list[dict]:
    return [{"text": block} for block in _context_blocks(note, selection, False)]


def _contents(history: list, prompt: str) -> list[dict]:
    contents = []
    for message in history[-HISTORY_LIMIT:]:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        text = _text(message.get("content"), MESSAGE_LIMIT)
        if role not in {"user", "assistant"} or not text:
            continue
        prior_selection = _text(message.get("selection"), SELECTION_LIMIT)
        if role == "user" and prior_selection:
            text = f"Selected text for this earlier request:\n{prior_selection}\n\nRequest:\n{text}"
        contents.append({
            "role": "model" if role == "assistant" else "user",
            "parts": [{"text": text}],
        })
    contents.append({"role": "user", "parts": [{"text": prompt}]})
    return contents


def _payload(note: dict, selection: dict, history: list, prompt: str) -> dict:
    return {
        "systemInstruction": {"parts": _system_parts(note, selection)},
        "contents": _contents(history, prompt),
        "generationConfig": {"maxOutputTokens": 2048},
    }


def _search_payload(note: dict, selection: dict, history: list, prompt: str, model: dict) -> dict:
    """OpenRouter speaks the OpenAI shape, so the same context is re-laid-out.

    The `web` plugin runs the search before the model sees the turn and pastes
    the results into it, so there is no tool call to orchestrate here.
    """
    messages = [{"role": "system", "content": "\n\n".join(_context_blocks(note, selection, True))}]
    for message in history[-HISTORY_LIMIT:]:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        text = _text(message.get("content"), MESSAGE_LIMIT)
        if role not in {"user", "assistant"} or not text:
            continue
        prior_selection = _text(message.get("selection"), SELECTION_LIMIT)
        if role == "user" and prior_selection:
            text = f"Selected text for this earlier request:\n{prior_selection}\n\nRequest:\n{text}"
        messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": prompt})
    return {
        "model": model["id"],
        "messages": messages,
        "plugins": [{"id": "web", "max_results": SEARCH_MAX_RESULTS}],
        "stream": True,
    }


def _openrouter_error_detail(status_code: int, raw: str) -> str:
    try:
        message = json.loads(raw).get("error", {}).get("message")
    except (ValueError, AttributeError):
        message = None
    if status_code in {401, 403}:
        return "OpenRouter rejected the key. Check it in the assistant's key settings."
    if status_code == 402:
        # Inference on the free model costs nothing, but the web plugin bills
        # the key's owner per search, so an empty balance stops /search alone.
        return "OpenRouter is out of credit. Web search bills about half a cent per search."
    if isinstance(message, str) and message.strip():
        return f"Search request failed ({status_code}): {message.strip()}"
    return f"Search request failed ({status_code})."


async def _search_events(api_key: str, payload: dict, model: dict):
    """Stream one OpenRouter search turn.

    Citations arrive in the first chunk, ahead of any prose, so they are emitted
    as their own event and the client can show sources while the answer is still
    being written. The model's reasoning is streamed alongside the answer in
    separate fields; only the answer is forwarded.
    """
    answered = False
    seen_sources = set()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Title": "EverFree",
        "HTTP-Referer": "https://everfree.vercel.app",
    }
    async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT, headers=headers) as client:
        async with client.stream("POST", OPENROUTER_URL, json=payload) as response:
            if response.status_code != 200:
                raw = (await response.aread()).decode("utf-8", "replace")
                if response.status_code == 429:
                    logger.warning(
                        "%s was rate-limited, falling back: %s", model["id"], raw[:1000],
                    )
                    raise SearchUnavailable
                yield {"type": "error", "detail": _openrouter_error_detail(response.status_code, raw)}
                return
            yield {"type": "model", "id": model["id"], "name": model["name"], "search": True}
            async for line in response.aiter_lines():
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
                delta = ((chunk.get("choices") or [{}])[0] or {}).get("delta") or {}
                sources = []
                for annotation in delta.get("annotations") or []:
                    citation = (annotation or {}).get("url_citation") or {}
                    url = citation.get("url")
                    if not isinstance(url, str) or url in seen_sources:
                        continue
                    seen_sources.add(url)
                    sources.append({"url": url, "title": citation.get("title") or url})
                if sources:
                    yield {"type": "sources", "sources": sources}
                text = delta.get("content")
                if isinstance(text, str) and text:
                    answered = True
                    yield {"type": "delta", "text": text}
    if answered:
        yield {"type": "done"}
    else:
        yield {"type": "error", "detail": "The search returned no answer. Please try again."}


async def _search_chain(api_key: str, payload_for, models: list):
    """Fall through to the next search model while one is rate-limited.

    Each model needs its own payload because the model id is part of the body,
    so the caller passes a builder rather than a finished payload.
    """
    for model in models:
        started = False
        try:
            async for event in _search_events(api_key, payload_for(model), model):
                started = True
                yield event
            return
        except SearchUnavailable:
            if started:
                raise
    raise ChainExhausted


def _ndjson(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


def _quota_kind(status_code: int, detail: str) -> str | None:
    if status_code != 429:
        return None
    compact = "".join(detail.lower().split())
    if any(marker in compact for marker in (
        "generaterequestsperday",
        "requestsperday",
        "requestperday",
        "per-dayrequest",
        "dailylimit",
        "dailyquota",
        "quota_exceeded",
        "rpd",
    )):
        return "daily"
    if any(marker in compact for marker in (
        "generaterequestsperminute",
        "requestsperminute",
        "tokensperminute",
        "per-minuterequest",
        "per-minutetoken",
        "rate_limit_exceeded",
        "retryin",
        "retrydelay",
        "rpm",
        "tpm",
    )):
        return "temporary"
    # Some Gemini endpoints return only RESOURCE_EXHAUSTED, without the quota
    # dimension. Falling back is more useful than exposing an opaque 429.
    return "unknown"


def _google_error_detail(status_code: int, raw: str) -> str:
    try:
        parsed = json.loads(raw)
        message = parsed.get("error", {}).get("message")
    except (ValueError, AttributeError):
        message = None
    if status_code == 429:
        if _quota_kind(status_code, raw) == "temporary":
            return "Gemini is temporarily rate-limited. Wait a moment and try again."
        return "Gemini's quota has been reached. Try again later."
    if isinstance(message, str) and message.strip():
        return f"Gemini request failed ({status_code}): {message.strip()}"
    return f"Gemini request failed ({status_code})."


async def _events(api_key: str, payload: dict, model: dict):
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model['id']}:streamGenerateContent?alt=sse"
    )
    answered = False
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"x-goog-api-key": api_key}) as client:
        async with client.stream("POST", url, json=payload) as response:
            if response.status_code != 200:
                raw = (await response.aread()).decode("utf-8", "replace")
                if _quota_kind(response.status_code, raw) in {"daily", "unknown"}:
                    # The fallback hides this body from the user, so log it: an
                    # opaque 429 can mean something other than a spent daily quota.
                    logger.warning(
                        "%s returned %s, falling back: %s",
                        model["id"], response.status_code, raw[:1000],
                    )
                    raise DailyQuotaExceeded
                yield {"type": "error", "detail": _google_error_detail(response.status_code, raw)}
                return
            yield {"type": "model", "id": model["id"], "name": model["name"]}
            async for line in response.aiter_lines():
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
                candidate = (chunk.get("candidates") or [{}])[0]
                for part in (candidate.get("content") or {}).get("parts") or []:
                    text = part.get("text")
                    if isinstance(text, str) and text and not part.get("thought"):
                        answered = True
                        yield {"type": "delta", "text": text}
    if answered:
        yield {"type": "done"}
    else:
        yield {"type": "error", "detail": "Gemini returned no text. Please try again."}


async def _stream_chain(api_key: str, payload: dict, models: list):
    """Try each model in turn, moving on only when its daily quota is spent.

    A model that has already emitted events cannot be retried on the next model
    without the user seeing the answer restart, so the fall-through is refused
    once anything has been written. In practice the daily-quota 429 is raised
    before the first event; the guard keeps that a fact rather than a hope.
    """
    for model in models:
        started = False
        try:
            async for event in _events(api_key, payload, model):
                started = True
                yield event
            return
        except DailyQuotaExceeded:
            if started:
                raise
    raise ChainExhausted


@router.post("/chat")
async def chat(request: Request):
    body = await request.json()
    api_key = _text(body.get("api_key"), 500).strip()
    search_key = _text(body.get("search_key"), 500).strip()
    search = bool(body.get("search"))
    prompt_value = body.get("prompt")
    prompt = prompt_value if isinstance(prompt_value, str) else ""
    note = body.get("note") if isinstance(body.get("note"), dict) else {}
    selection = body.get("selection") if isinstance(body.get("selection"), dict) else {}
    history = body.get("history") if isinstance(body.get("history"), list) else []
    # A search turn never reaches Gemini, so it asks for the OpenRouter key
    # instead: the two providers are independent and neither key implies the
    # other.
    if search and not search_key:
        raise HTTPException(
            status_code=400,
            detail="Add an OpenRouter key to use /search.",
        )
    if not search and not api_key:
        raise HTTPException(status_code=400, detail="Add your Gemini API key first.")
    if not prompt.strip():
        raise HTTPException(
            status_code=400,
            detail="Add a question after /search." if search else "Write a message first.",
        )
    if len(prompt) > MESSAGE_LIMIT:
        raise HTTPException(status_code=413, detail="Message is too long.")

    async def stream():
        try:
            if search:
                def payload_for(model):
                    return _search_payload(note, selection, history, prompt, model)

                try:
                    async for event in _search_chain(search_key, payload_for, SEARCH_MODELS):
                        yield _ndjson(event)
                except ChainExhausted:
                    yield _ndjson({
                        "type": "error",
                        "detail": "Every search model is rate-limited right now. Try again shortly.",
                    })
                return
            payload = _payload(note, selection, history, prompt)
            try:
                async for event in _stream_chain(api_key, payload, CHAT_MODELS):
                    yield _ndjson(event)
            except ChainExhausted:
                # The client remembers a spent quota for the rest of the day, so
                # say so explicitly rather than in prose it would have to parse.
                yield _ndjson({
                    "type": "error",
                    "quota_spent": True,
                    "detail": "Today's Gemini quota is used up. Try again after it resets.",
                })
        except httpx.ConnectError:
            yield _ndjson({
                "type": "error",
                "detail": "Could not reach OpenRouter. Check your connection." if search
                else "Could not reach Gemini. Check your connection.",
            })
        except Exception as exc:
            yield _ndjson({"type": "error", "detail": str(exc)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")
