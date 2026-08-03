"""Minimal Gemini chat for EverFree.

The assistant has no tools at all: no web search, and it cannot read any note
except the current note supplied by the client. Google Search grounding was
dropped because it is rejected with an opaque 429 on a key without billing
enabled, which made every request fall back to Gemma. The API key is supplied
per request and is never stored by the server.
"""

from __future__ import annotations

import json
import logging
import os
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

CONFIG = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
PRIMARY_MODEL = CONFIG["primary_model"]
FALLBACK_MODEL = CONFIG["fallback_model"]
SYSTEM_PROMPT = CONFIG["system_prompt"]

NOTE_LIMIT = 60_000
SELECTION_LIMIT = 20_000
MESSAGE_LIMIT = 20_000
HISTORY_LIMIT = 20
TIMEOUT = httpx.Timeout(180.0, connect=10.0)


class DailyQuotaExceeded(Exception):
    """The selected model's request-per-day quota has been exhausted."""


def _text(value: object, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _system_parts(note: dict, selection: dict) -> list[dict]:
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
    return [
        {"text": SYSTEM_PROMPT},
        {"text": note_context},
        {"text": selection_context},
    ]


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


def _sources(metadata: dict) -> list[dict]:
    found = []
    seen = set()
    for chunk in metadata.get("groundingChunks") or []:
        web = chunk.get("web") or {}
        uri = web.get("uri")
        if not isinstance(uri, str) or not uri.startswith(("https://", "http://")) or uri in seen:
            continue
        seen.add(uri)
        found.append({"title": web.get("title") or uri, "url": uri})
    return found[:8]


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
    grounding = {}
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
            yield {
                "type": "model",
                "id": model["id"],
                "name": model["name"],
                "fallback": model["id"] == FALLBACK_MODEL["id"],
            }
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
                if candidate.get("groundingMetadata"):
                    grounding = candidate["groundingMetadata"]
                for part in (candidate.get("content") or {}).get("parts") or []:
                    text = part.get("text")
                    if isinstance(text, str) and text and not part.get("thought"):
                        answered = True
                        yield {"type": "delta", "text": text}
    sources = _sources(grounding)
    if sources:
        yield {"type": "sources", "sources": sources}
    if answered:
        yield {"type": "done"}
    else:
        yield {"type": "error", "detail": "Gemini returned no text. Please try again."}


@router.post("/chat")
async def chat(request: Request):
    body = await request.json()
    api_key = _text(body.get("api_key"), 500).strip()
    prompt_value = body.get("prompt")
    prompt = prompt_value if isinstance(prompt_value, str) else ""
    note = body.get("note") if isinstance(body.get("note"), dict) else {}
    selection = body.get("selection") if isinstance(body.get("selection"), dict) else {}
    history = body.get("history") if isinstance(body.get("history"), list) else []
    if not api_key:
        raise HTTPException(status_code=400, detail="Add your Gemini API key first.")
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="Write a message first.")
    if len(prompt) > MESSAGE_LIMIT:
        raise HTTPException(status_code=413, detail="Message is too long.")

    async def stream():
        payload = _payload(note, selection, history, prompt)
        try:
            try:
                async for event in _events(api_key, payload, PRIMARY_MODEL):
                    yield _ndjson(event)
            except DailyQuotaExceeded:
                try:
                    async for event in _events(api_key, payload, FALLBACK_MODEL):
                        yield _ndjson(event)
                except DailyQuotaExceeded:
                    yield _ndjson({
                        "type": "error",
                        "detail": "Gemma is also unavailable because its quota has been reached. Try again later.",
                    })
        except httpx.ConnectError:
            yield _ndjson({"type": "error", "detail": "Could not reach Gemini. Check your connection."})
        except Exception as exc:
            yield _ndjson({"type": "error", "detail": str(exc)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")
