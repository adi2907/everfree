// Minimal EverFree chat and search proxy. Each key is used only for the request
// it arrives on. Mirrors server/assistant.py: an ordinary turn has no tools and
// walks the configured Gemini models, falling through on a daily-quota 429; a
// /search turn goes to OpenRouter instead, on its own key. Keep the two in step.

const CONFIG = require("../../lib/assistant-config.json");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// These stand in when a config omits them, so they have to carry the whole
// instruction rather than gesture at it: a search turn that is not told to cite
// stops citing, and the sources the client renders no longer match the prose.
const DEFAULT_CHAT_NOTE = "You have no web access in this turn: you cannot search the web or open links, "
    + "so never claim to have done either.";
const DEFAULT_SEARCH_NOTE = "You have web search in this turn, and search results are supplied to you. "
    + "Ground every factual claim in those results and cite its source as a Markdown link. Where the "
    + "results do not cover something, say so plainly instead of filling the gap from memory.";

const NOTE_LIMIT = 60000;
const SELECTION_LIMIT = 20000;
const MESSAGE_LIMIT = 20000;
const HISTORY_LIMIT = 20;
const SEARCH_MAX_RESULTS = CONFIG.search_max_results || 8;

function clean(value, limit) {
    return typeof value === "string" ? value.slice(0, limit) : "";
}

class DailyQuotaError extends Error {}
class ChainExhaustedError extends Error {}
class SearchUnavailableError extends Error {}

// The system text both providers share, in the same order. Whether this turn
// can search changes what the model may claim about the web, so that claim
// belongs to the turn rather than to the standing prompt.
function contextBlocks(note, selection, search) {
    const notebook = clean(note.notebook, 500).trim();
    const name = clean(note.note, 500).trim() || "Untitled note";
    const location = notebook ? `${notebook} / ${name}` : name;
    const content = clean(note.content, NOTE_LIMIT) || "(empty note)";
    const selected = clean(selection.text, SELECTION_LIMIT);
    return [
        CONFIG.system_prompt,
        `<current_note name=${JSON.stringify(location)}>\n${content}\n</current_note>`,
        selected.trim() ? `<selected_text>\n${selected}\n</selected_text>` : "<selected_text>(none)</selected_text>",
        search
            ? (CONFIG.search_note || DEFAULT_SEARCH_NOTE)
            : (CONFIG.chat_note || DEFAULT_CHAT_NOTE),
    ];
}

function systemParts(note, selection) {
    return contextBlocks(note, selection, false).map((text) => ({ text }));
}

function contents(history, prompt) {
    const result = [];
    for (const message of history.slice(-HISTORY_LIMIT)) {
        if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
        let text = clean(message.content, MESSAGE_LIMIT);
        if (!text) continue;
        const priorSelection = clean(message.selection, SELECTION_LIMIT);
        if (message.role === "user" && priorSelection) {
            text = `Selected text for this earlier request:\n${priorSelection}\n\nRequest:\n${text}`;
        }
        result.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text }] });
    }
    result.push({ role: "user", parts: [{ text: prompt }] });
    return result;
}

async function* sse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.startsWith("data:")) yield line.slice(5).trim();
        }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

function quotaKind(status, detail) {
    if (status !== 429) return null;
    const compact = detail.toLowerCase().replace(/\s/g, "");
    if ([
        "generaterequestsperday",
        "requestsperday",
        "requestperday",
        "per-dayrequest",
        "dailylimit",
        "dailyquota",
        "quota_exceeded",
        "rpd",
    ].some((marker) => compact.includes(marker))) return "daily";
    if ([
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
    ].some((marker) => compact.includes(marker))) return "temporary";
    return "unknown";
}

function googleErrorDetail(status, detail) {
    let message = "";
    try { message = JSON.parse(detail).error.message || ""; } catch { /* use status below */ }
    if (status === 429) {
        return quotaKind(status, detail) === "temporary"
            ? "Gemini is temporarily rate-limited. Wait a moment and try again."
            : "Gemini's quota has been reached. Try again later.";
    }
    return message.trim()
        ? `Gemini request failed (${status}): ${message.trim()}`
        : `Gemini request failed (${status}).`;
}

// OpenRouter speaks the OpenAI shape, so the same context is re-laid-out. The
// `web` plugin runs the search before the model sees the turn and pastes the
// results into it, so there is no tool call to orchestrate here.
function searchPayload(note, selection, history, prompt, model) {
    const messages = [{ role: "system", content: contextBlocks(note, selection, true).join("\n\n") }];
    for (const message of history.slice(-HISTORY_LIMIT)) {
        if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
        let text = clean(message.content, MESSAGE_LIMIT);
        if (!text) continue;
        const priorSelection = clean(message.selection, SELECTION_LIMIT);
        if (message.role === "user" && priorSelection) {
            text = `Selected text for this earlier request:\n${priorSelection}\n\nRequest:\n${text}`;
        }
        messages.push({ role: message.role, content: text });
    }
    messages.push({ role: "user", content: prompt });
    return {
        model: model.id,
        messages,
        plugins: [{ id: "web", max_results: SEARCH_MAX_RESULTS }],
        stream: true,
    };
}

function openRouterErrorDetail(status, detail) {
    let message = "";
    try { message = JSON.parse(detail).error.message || ""; } catch { /* use status below */ }
    if (status === 401 || status === 403) {
        return "OpenRouter rejected the key. Check it in the assistant's key settings.";
    }
    // Inference on the free model costs nothing, but the web plugin bills the
    // key's owner per search, so an empty balance stops /search alone.
    if (status === 402) {
        return "OpenRouter is out of credit. Web search bills about half a cent per search.";
    }
    return message.trim()
        ? `Search request failed (${status}): ${message.trim()}`
        : `Search request failed (${status}).`;
}

// Citations arrive in the first chunk, ahead of any prose, so they are written
// as their own event and the client can show sources while the answer is still
// being written. The model's reasoning streams in separate delta fields; only
// the answer is forwarded.
async function streamSearchModel(apiKey, payload, model, write) {
    let response;
    try {
        response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "X-Title": "EverFree",
                "HTTP-Referer": "https://everfree.vercel.app",
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        throw new Error(`Could not reach OpenRouter: ${error.message || error}`);
    }
    if (!response.ok) {
        const detail = await response.text();
        if (response.status === 429) {
            console.error(`${model.id} rate-limited, falling back:`, detail.slice(0, 1000));
            throw new SearchUnavailableError();
        }
        throw new Error(openRouterErrorDetail(response.status, detail));
    }

    write({ type: "model", id: model.id, name: model.name, search: true });
    let answered = false;
    const seen = new Set();
    for await (const raw of sse(response.body)) {
        if (!raw || raw === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const delta = ((chunk.choices || [])[0] || {}).delta || {};
        const sources = [];
        for (const annotation of delta.annotations || []) {
            const citation = (annotation || {}).url_citation || {};
            if (typeof citation.url !== "string" || seen.has(citation.url)) continue;
            seen.add(citation.url);
            sources.push({ url: citation.url, title: citation.title || citation.url });
        }
        if (sources.length) write({ type: "sources", sources });
        if (typeof delta.content === "string" && delta.content) {
            answered = true;
            write({ type: "delta", text: delta.content });
        }
    }
    write(answered ? { type: "done" } : { type: "error", detail: "The search returned no answer. Please try again." });
}

// Fall through to the next search model while one is rate-limited. Each model
// needs its own payload because the model id is part of the body.
async function searchChain(apiKey, payloadFor, models, write) {
    for (const model of models) {
        let started = false;
        const once = (event) => { started = true; write(event); };
        try {
            await streamSearchModel(apiKey, payloadFor(model), model, once);
            return;
        } catch (error) {
            if (started || !(error instanceof SearchUnavailableError)) throw error;
        }
    }
    throw new ChainExhaustedError();
}

function requestPayload(note, selection, history, prompt) {
    return {
        systemInstruction: { parts: systemParts(note, selection) },
        contents: contents(history, prompt),
        generationConfig: { maxOutputTokens: 2048 },
    };
}

async function streamModel(apiKey, payload, model, write) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        throw new Error(`Could not reach Gemini: ${error.message || error}`);
    }
    if (!response.ok) {
        const detail = await response.text();
        if (["daily", "unknown"].includes(quotaKind(response.status, detail))) {
            // The fallback hides the upstream body from the user, so log it: an
            // opaque 429 can mean something other than an exhausted daily quota.
            console.error(`${model.id} ${response.status}, falling back:`, detail.slice(0, 1000));
            throw new DailyQuotaError();
        }
        throw new Error(googleErrorDetail(response.status, detail));
    }

    write({ type: "model", id: model.id, name: model.name });
    let answered = false;
    for await (const raw of sse(response.body)) {
        if (!raw || raw === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const candidate = (chunk.candidates || [])[0] || {};
        for (const part of (candidate.content || {}).parts || []) {
            if (typeof part.text === "string" && part.text && !part.thought) {
                answered = true;
                write({ type: "delta", text: part.text });
            }
        }
    }
    write(answered ? { type: "done" } : { type: "error", detail: "Gemini returned no text. Please try again." });
}

// Try each model in turn, moving on only when its daily quota is spent. A model
// that has already written events cannot be retried without the user seeing the
// answer restart, so the fall-through is refused once anything has been written.
async function streamChain(apiKey, payload, models, write) {
    for (const model of models) {
        let started = false;
        const once = (event) => { started = true; write(event); };
        try {
            await streamModel(apiKey, payload, model, once);
            return;
        } catch (error) {
            if (started || !(error instanceof DailyQuotaError)) throw error;
        }
    }
    throw new ChainExhaustedError();
}

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ detail: "Method not allowed" });
        return;
    }
    const body = req.body || {};
    const apiKey = clean(body.api_key, 500).trim();
    const searchKey = clean(body.search_key, 500).trim();
    const search = Boolean(body.search);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const note = body.note && typeof body.note === "object" ? body.note : {};
    const selection = body.selection && typeof body.selection === "object" ? body.selection : {};
    const history = Array.isArray(body.history) ? body.history : [];
    // A search turn never reaches Gemini, so it asks for the OpenRouter key
    // instead: the two providers are independent and neither key implies the
    // other.
    const missingKey = search
        ? (!searchKey && "Add an OpenRouter key to use /search.")
        : (!apiKey && "Add your Gemini API key first.");
    if (missingKey) {
        res.status(400).json({ detail: missingKey });
        return;
    }
    if (!prompt.trim()) {
        res.status(400).json({ detail: search ? "Add a question after /search." : "Write a message first." });
        return;
    }
    if (prompt.length > MESSAGE_LIMIT) {
        res.status(413).json({ detail: "Message is too long." });
        return;
    }

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    const write = (event) => res.write(JSON.stringify(event) + "\n");

    try {
        if (search) {
            const payloadFor = (model) => searchPayload(note, selection, history, prompt, model);
            await searchChain(searchKey, payloadFor, CONFIG.search_models, write);
        } else {
            await streamChain(apiKey, requestPayload(note, selection, history, prompt), CONFIG.chat_models, write);
        }
    } catch (error) {
        if (search && error instanceof ChainExhaustedError) {
            write({
                type: "error",
                detail: "Every search model is rate-limited right now. Try again shortly.",
            });
        } else if (error instanceof ChainExhaustedError) {
            // The client remembers a spent quota for the rest of the day, so say
            // so explicitly rather than in prose it would have to parse.
            write({
                type: "error",
                quota_spent: true,
                detail: "Today's Gemini quota is used up. Try again after it resets.",
            });
        } else {
            write({ type: "error", detail: error.message || String(error) });
        }
    }
    res.end();
};
