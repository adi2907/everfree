// EverFree — shared agent core for the web/mobile assistant.
//
// Plain CommonJS, zero dependencies (matches the rest of web/api). Runs the
// chat agent against Google's Gemini API. There are no tools here: the user's
// notes live in their GitHub repo rather than on this box, and image
// generation needs a billing-enabled Gemini key. Callers stream the yielded
// events as ndjson.
//
// The API key is never stored here — it arrives per request from the browser
// (kept in the user's localStorage) and is used only for that call.

const NOTE_CONTEXT_LIMIT = 8000;
const DEFAULT_CHAT_MODEL = "gemini-2.5-flash";

// ── Prompts ─────────────────────────────────────────────────
// The prompt text is shared with the desktop assistant (server/agent.py) and
// lives in exactly one place: prompts.json, next to this file. Static require
// so Vercel traces it into the function bundle.
const PROMPTS = require("./prompts.json");

// Web and mobile run on Vercel with no filesystem, so the notes tools and
// create_note are absent — which leaves no tools at all, and the whole Tools
// section is dropped. Desktop assembles the same pieces with that section —
// see _build_chat_prompt in server/agent.py.
function buildChatPrompt() {
    const chat = PROMPTS.chat;
    return [
        chat.intro,
        chat.think.web,
        chat.no_images,
        chat.language_rule,
        chat.style,
    ].join("\n\n");
}

const CHAT_SYSTEM_PROMPT = buildChatPrompt();
const CONTINUE_SYSTEM_PROMPT = PROMPTS["continue"];   // reserved word — bracket access
const COMPLETE_SYSTEM_PROMPT = PROMPTS.complete;

// ── Small utilities ──────────────────────────────────────────
// Read a fetch Response's SSE body line by line, yielding the JSON after "data:".
async function* sseData(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.startsWith("data:")) yield line.slice(5).trim();
        }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

// ── Gemini streaming ─────────────────────────────────────────
function toGeminiContents(messages) {
    let systemInstruction = null;
    const contents = [];
    for (const m of messages) {
        if (m.role === "system") {
            systemInstruction = { parts: [{ text: m.content }] };
        } else if (m.role === "user") {
            contents.push({ role: "user", parts: [{ text: m.content }] });
        } else if (m.role === "assistant") {
            contents.push({ role: "model", parts: [{ text: m.content || "" }] });
        }
    }
    return { systemInstruction, contents };
}

async function* runGemini(messages, keys, model, noThinking = false) {
    const { systemInstruction, contents } = toGeminiContents(messages);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(keys.gemini_api_key)}`;
    const body = { contents, generationConfig: { maxOutputTokens: 2048 } };
    // Writing straight into the note: hidden thinking would eat the whole
    // token budget on a short continuation, so switch it off.
    if (noThinking) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    let resp;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch (err) {
        yield { type: "error", detail: `Could not reach Gemini: ${err.message || err}` };
        return;
    }
    if (!resp.ok) {
        yield { type: "error", detail: `Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
        return;
    }

    let answered = false;
    for await (const chunk of sseData(resp.body)) {
        let data;
        try { data = JSON.parse(chunk); } catch { continue; }
        const parts = ((data.candidates || [])[0] || {}).content?.parts || [];
        for (const part of parts) {
            if (typeof part.text === "string" && part.text) {
                answered = true;
                yield { type: "delta", text: part.text };
            }
        }
    }
    // A reasoning model can burn the whole token budget on hidden thinking and
    // return nothing; say so rather than closing the stream in silence.
    if (!answered) {
        yield { type: "error", detail: "The model returned no text. Try again or pick a different model." };
    }
}

// ── Public entry point ───────────────────────────────────────
// Yields UI events: {type:"delta"|"error", ...}.
// mode "chat" (default) answers in the panel; "complete" continues the
// selected passage and "continue" the whole note — both write straight into
// the note, so hidden thinking is disabled for them.
async function* runAgent({ messages, note, keys, mode, selection }) {
    let full;
    let noThinking = false;
    const content = (note && note.content ? note.content : "").trim();
    if (mode === "complete") {
        const sel = (selection || "").trim();
        if (!sel) { yield { type: "error", detail: "Select a passage in your note first." }; return; }
        const userParts = [];
        if (content && content !== sel) {
            userParts.push(`The full note, for context only:\n\n${content.slice(-NOTE_CONTEXT_LIMIT)}`);
        }
        userParts.push(`Complete this selected passage:\n\n${sel.slice(-NOTE_CONTEXT_LIMIT)}`);
        full = [
            { role: "system", content: COMPLETE_SYSTEM_PROMPT },
            { role: "user", content: userParts.join("\n\n") },
        ];
        noThinking = true;
    } else if (mode === "continue") {
        if (!content) { yield { type: "error", detail: "The note is empty — write a few words first." }; return; }
        full = [
            { role: "system", content: CONTINUE_SYSTEM_PROMPT },
            { role: "user", content: `Continue this note:\n\n${content.slice(-NOTE_CONTEXT_LIMIT)}` },
        ];
        noThinking = true;
    } else {
        full = [{ role: "system", content: buildSystemPrompt(note) }, ...messages];
    }
    try {
        if (!keys.gemini_api_key) {
            yield { type: "error", detail: "Add a Google Gemini API key in assistant settings." };
            return;
        }
        yield* runGemini(full, keys, keys.gemini_model || DEFAULT_CHAT_MODEL, noThinking);
    } catch (err) {
        yield { type: "error", detail: err.message || String(err) };
    }
}

function buildSystemPrompt(note) {
    let system = CHAT_SYSTEM_PROMPT;
    const content = (note && note.content ? note.content : "").trim();
    if (content) {
        const where = note.notebook ? `${note.notebook} / ${note.note || "untitled"}` : (note.note || "untitled");
        system += `\n\n--- Current note: ${where} ---\n${content.slice(-NOTE_CONTEXT_LIMIT)}`;
    }
    return system;
}

module.exports = { runAgent };
