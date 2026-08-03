// Minimal EverFree chat proxy. The Gemini key is used only for this request.

const CONFIG = require("../../lib/assistant-config.json");

const NOTE_LIMIT = 60000;
const SELECTION_LIMIT = 20000;
const MESSAGE_LIMIT = 20000;
const HISTORY_LIMIT = 20;

function clean(value, limit) {
    return typeof value === "string" ? value.slice(0, limit) : "";
}

class DailyQuotaError extends Error {}

function systemParts(note, selection) {
    const notebook = clean(note.notebook, 500).trim();
    const name = clean(note.note, 500).trim() || "Untitled note";
    const location = notebook ? `${notebook} / ${name}` : name;
    const content = clean(note.content, NOTE_LIMIT) || "(empty note)";
    const selected = clean(selection.text, SELECTION_LIMIT);
    return [
        { text: CONFIG.system_prompt },
        { text: `<current_note name=${JSON.stringify(location)}>\n${content}\n</current_note>` },
        { text: selected.trim() ? `<selected_text>\n${selected}\n</selected_text>` : "<selected_text>(none)</selected_text>" },
    ];
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

function sources(metadata) {
    const found = [];
    const seen = new Set();
    for (const chunk of metadata.groundingChunks || []) {
        const web = chunk.web || {};
        if (typeof web.uri !== "string" || !/^https?:\/\//.test(web.uri) || seen.has(web.uri)) continue;
        seen.add(web.uri);
        found.push({ title: web.title || web.uri, url: web.uri });
    }
    return found.slice(0, 8);
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

    write({
        type: "model",
        id: model.id,
        name: model.name,
        fallback: model.id === CONFIG.fallback_model.id,
    });
    let answered = false;
    let grounding = {};
    for await (const raw of sse(response.body)) {
        if (!raw || raw === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const candidate = (chunk.candidates || [])[0] || {};
        if (candidate.groundingMetadata) grounding = candidate.groundingMetadata;
        for (const part of (candidate.content || {}).parts || []) {
            if (typeof part.text === "string" && part.text && !part.thought) {
                answered = true;
                write({ type: "delta", text: part.text });
            }
        }
    }
    const groundedSources = sources(grounding);
    if (groundedSources.length) write({ type: "sources", sources: groundedSources });
    write(answered ? { type: "done" } : { type: "error", detail: "Gemini returned no text. Please try again." });
}

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ detail: "Method not allowed" });
        return;
    }
    const body = req.body || {};
    const apiKey = clean(body.api_key, 500).trim();
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const note = body.note && typeof body.note === "object" ? body.note : {};
    const selection = body.selection && typeof body.selection === "object" ? body.selection : {};
    const history = Array.isArray(body.history) ? body.history : [];
    if (!apiKey || !prompt.trim()) {
        res.status(400).json({ detail: !apiKey ? "Add your Gemini API key first." : "Write a message first." });
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

    const payload = requestPayload(note, selection, history, prompt);
    try {
        await streamModel(apiKey, payload, CONFIG.primary_model, write);
    } catch (error) {
        if (error instanceof DailyQuotaError) {
            try {
                await streamModel(apiKey, payload, CONFIG.fallback_model, write);
            } catch (fallbackError) {
                write({
                    type: "error",
                    detail: fallbackError instanceof DailyQuotaError
                        ? "Gemma is also unavailable because its quota has been reached. Try again later."
                        : fallbackError.message || String(fallbackError),
                });
            }
        } else {
            write({ type: "error", detail: error.message || String(error) });
        }
    }
    res.end();
};
