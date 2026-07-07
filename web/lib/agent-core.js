// EverFree — shared agent core for the web/mobile assistant.
//
// Plain CommonJS, zero dependencies (matches the rest of web/api). Runs the
// chat agent against Gemini or OpenRouter, exposing three tools: web_search,
// read_page, and generate_image. Callers stream the yielded events as ndjson.
//
// API keys are never stored here — they arrive per request from the browser
// (kept in the user's localStorage) and are used only for that call.

const SEARCH_RESULT_COUNT = 6;
const PAGE_TEXT_LIMIT = 6000;
const NOTE_CONTEXT_LIMIT = 8000;
const MAX_TOOL_ROUNDS = 8;
const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";

const CHAT_SYSTEM_PROMPT = `You are the writing assistant built into EverFree, a Markdown note-taking app.
The user's current note may be provided below as context — use it to understand what they are working on, but do EXACTLY what the user asks and nothing more. Never continue, extend, rewrite, or add new sections/paragraphs/list items to the note unless the user explicitly asks you to write or continue it. If they ask a question, answer it; if they ask for an image, give them the image.

Think before you act. Decide whether a request is best served from the note in front of you or from the web, then use tools to gather what you need before replying.

Tools:
- web_search (Google) then read_page — for external facts. Read the 2-3 most promising results before answering, and end such a passage with a "Sources:" line of Markdown links.
- generate_image — whenever the user asks for an image, illustration, diagram, or picture. Write a specific, detailed prompt grounded in the actual subject of the note: name the real people, companies, products, places, and setting involved instead of a generic abstraction. NEVER write a Markdown image link from your own imagination — that produces a broken link. Call generate_image, then reply with a one-line caption only.

When the user's message includes a selected excerpt from their note, respond in the language of that excerpt unless they ask otherwise — a Hindi excerpt gets a Hindi rewrite.

Reply with clean Markdown and no preamble ("Here is...", "Sure,") or commentary about what you did.`;

const CONTINUE_SYSTEM_PROMPT = `You are the writing assistant built into EverFree, a Markdown note-taking app.
Continue the user's note from exactly where it stops. If the last sentence is unfinished, finish it, then add at most one or two short sentences in the same voice, tone, and formatting. Do not keep expanding the note.
Write in the same language as the note. If the note is in Hindi, continue in Hindi; if it mixes languages, keep the same mix. Never switch language.
Reply with the continuation text only — no preamble, no quotes, and do not repeat any of the existing text.`;

const COMPLETE_SYSTEM_PROMPT = `You are the writing assistant built into EverFree, a Markdown note-taking app.
The user selected a passage from their note and asked you to complete it. Pick up exactly where the selection stops and bring the thought to a natural close.
Rules:
- Write in the SAME LANGUAGE as the selection. If the selection is in Hindi, continue in Hindi; if it mixes languages, keep the same mix. Never switch to English unless the selection is in English.
- Match the selection's voice, tone, tense, and formatting: continue prose as prose. Continue a list as list items — each new item on its own line, starting with the same marker followed by a space (e.g. "- ").
- If the last sentence is unfinished, finish it first.
- Stay inside the selected block: complete the paragraph or list, never start new sections or headings.
- Keep it short — usually one to three sentences (or two or three list items), just enough to complete the thought.
Reply with the continuation text only — no preamble, no quotes, no code fences, and do not repeat any of the selected text.`;

// ── Tool schemas (OpenAI function-calling shape) ─────────────
const TOOLS = [
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search Google for up-to-date information. Returns titles, URLs, and snippets.",
            parameters: {
                type: "object",
                properties: { query: { type: "string", description: "The search query" } },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_page",
            description: "Fetch a web page and return its readable text. Use after web_search to read the most promising results.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "The URL to read" } },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "generate_image",
            description:
                "Generate an image from a text prompt. Use whenever the user asks for an image, illustration, " +
                "diagram, or picture. Never write a Markdown image link yourself — call this tool.",
            parameters: {
                type: "object",
                properties: { prompt: { type: "string", description: "Detailed description of the image to generate" } },
                required: ["prompt"],
            },
        },
    },
];

// ── Small utilities ──────────────────────────────────────────
function stripHtml(html) {
    const noScript = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    const text = noScript.replace(/<[^>]+>/g, " ");
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

function extFromMime(mime) {
    const sub = (mime || "image/png").split("/").pop().toLowerCase();
    return sub === "jpeg" ? "jpg" : sub;
}

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

// ── Tool implementations ─────────────────────────────────────
async function toolWebSearch(query, keys) {
    if (!keys.serper_api_key) {
        return "Error: no Serper API key is configured. Ask the user to add one in assistant settings.";
    }
    if (!query) return "Error: empty search query.";
    let resp;
    try {
        resp = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": keys.serper_api_key, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: SEARCH_RESULT_COUNT }),
        });
    } catch (err) {
        return `Error reaching Serper: ${err}`;
    }
    if (!resp.ok) return `Error: Serper returned HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
    const data = await resp.json();
    const lines = [];
    const answer = data.answerBox && (data.answerBox.answer || data.answerBox.snippet);
    if (answer) lines.push(`Answer box: ${answer}`);
    for (const item of (data.organic || []).slice(0, SEARCH_RESULT_COUNT)) {
        lines.push(`- ${item.title || ""}\n  ${item.link || ""}\n  ${item.snippet || ""}`);
    }
    return lines.join("\n") || "No results.";
}

async function toolReadPage(url) {
    if (!/^https?:\/\//.test(url || "")) return "Error: invalid URL.";
    let resp;
    try {
        resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 EverFreeBot" }, redirect: "follow" });
    } catch (err) {
        return `Error fetching page: ${err}`;
    }
    if (!resp.ok) return `Error: page returned HTTP ${resp.status}`;
    const ctype = resp.headers.get("content-type") || "";
    if (!ctype.includes("html") && !ctype.includes("text")) return `Error: unsupported content type ${ctype}`;
    const html = await resp.text();
    const text = stripHtml(html);
    return text.slice(0, PAGE_TEXT_LIMIT) || "No readable text found.";
}

// ── Image generation (Gemini free tier → OpenRouter fallback) ─
async function geminiImage(prompt, model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
    });
    if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const parts = ((data.candidates || [])[0] || {}).content?.parts || [];
    for (const part of parts) {
        const inline = part.inlineData || part.inline_data;
        if (inline && inline.data) {
            const mime = inline.mimeType || inline.mime_type || "image/png";
            return { mime, base64: inline.data };
        }
    }
    throw new Error("Gemini returned no image");
}

async function openrouterImage(prompt, model, apiKey) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], modalities: ["image", "text"] }),
    });
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const message = ((data.choices || [])[0] || {}).message || {};
    const images = message.images || [];
    if (!images.length) throw new Error(`no image returned: ${(message.content || "").slice(0, 160)}`);
    const urlStr = (images[0].image_url && images[0].image_url.url) || "";
    const m = urlStr.match(/^data:image\/(\w+);base64,(.+)$/s);
    if (!m) throw new Error("unexpected image format");
    return { mime: `image/${m[1]}`, base64: m[2] };
}

// Returns { dataUrl, provider, model }. Prefers the free-tier Gemini key.
async function generateImage(prompt, keys) {
    prompt = (prompt || "").trim();
    if (!prompt) throw new Error("An image prompt is required");
    if (!keys.gemini_api_key && !keys.openrouter_api_key) {
        throw new Error("No image provider configured — add a Gemini or OpenRouter API key in assistant settings");
    }
    const orModel = keys.image_model || DEFAULT_IMAGE_MODEL;
    const geminiModel = orModel.includes("/") ? orModel.split("/").slice(1).join("/") : orModel;

    let out = null, provider = "", model = "";
    const errors = [];
    if (keys.gemini_api_key) {
        try {
            out = await geminiImage(prompt, geminiModel, keys.gemini_api_key);
            provider = "gemini";
            model = geminiModel;
        } catch (err) {
            errors.push(`Gemini: ${err.message || err}`);
        }
    }
    if (!out && keys.openrouter_api_key) {
        try {
            out = await openrouterImage(prompt, orModel, keys.openrouter_api_key);
            provider = "openrouter";
            model = orModel;
        } catch (err) {
            errors.push(`OpenRouter: ${err.message || err}`);
        }
    }
    if (!out) throw new Error("Image generation failed — " + errors.join("; "));
    return { dataUrl: `data:${out.mime};base64,${out.base64}`, provider, model };
}

// Dispatch a tool call. Returns { detail, result, extra }. `extra.image` carries
// a data URL so the UI can render the generated image inline.
async function runTool(name, args, keys) {
    if (name === "web_search") {
        const q = args.query || "";
        return { detail: q, result: await toolWebSearch(q, keys), extra: {} };
    }
    if (name === "read_page") {
        const u = args.url || "";
        return { detail: u, result: await toolReadPage(u), extra: {} };
    }
    if (name === "generate_image") {
        const prompt = args.prompt || "";
        try {
            const info = await generateImage(prompt, keys);
            return {
                detail: prompt.slice(0, 60),
                result: `Image generated and saved (via ${info.provider}). Show it to the user; reply with only a short caption.`,
                extra: { image: info.dataUrl, alt: prompt.slice(0, 120), provider: info.provider, model: info.model },
            };
        } catch (err) {
            return { detail: prompt.slice(0, 60), result: `Image generation failed: ${err.message || err}`, extra: {} };
        }
    }
    return { detail: "", result: `Error: unknown tool ${name}`, extra: {} };
}

// ── OpenRouter (OpenAI-compatible) streaming loop ────────────
async function* runOpenRouter(messages, keys, model, useTools = true) {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const payload = { model, messages, stream: true, max_tokens: 2048 };
        if (useTools) payload.tools = TOOLS;
        else payload.reasoning = { effort: "minimal", exclude: true };
        let resp;
        try {
            resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${keys.openrouter_api_key}`, "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
        } catch (err) {
            yield { type: "error", detail: `Could not reach OpenRouter: ${err.message || err}` };
            return;
        }
        if (!resp.ok) {
            yield { type: "error", detail: `OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
            return;
        }

        let answer = "";
        const toolCalls = {};
        for await (const chunk of sseData(resp.body)) {
            if (chunk === "[DONE]") break;
            let data;
            try { data = JSON.parse(chunk); } catch { continue; }
            const delta = ((data.choices || [])[0] || {}).delta || {};
            if (delta.reasoning) yield { type: "reason", text: delta.reasoning };
            if (delta.content) { answer += delta.content; yield { type: "delta", text: delta.content }; }
            for (const tc of delta.tool_calls || []) {
                const i = tc.index || 0;
                const cur = toolCalls[i] || (toolCalls[i] = { id: "", name: "", arguments: "" });
                if (tc.id) cur.id = tc.id;
                if (tc.function && tc.function.name) cur.name += tc.function.name;
                if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments;
            }
        }

        const calls = Object.values(toolCalls);
        if (!calls.length) return; // final answer already streamed

        messages.push({
            role: "assistant",
            content: answer || null,
            tool_calls: calls.map((c, i) => ({
                id: c.id || `call_${i}`,
                type: "function",
                function: { name: c.name, arguments: c.arguments || "{}" },
            })),
        });
        for (let i = 0; i < calls.length; i++) {
            const c = calls[i];
            let args = {};
            try { args = JSON.parse(c.arguments || "{}"); } catch { /* keep {} */ }
            const { detail, result, extra } = await runTool(c.name, args, keys);
            yield { type: "tool", name: c.name, detail };
            if (extra.image) yield { type: "image", url: extra.image, alt: extra.alt, provider: extra.provider, model: extra.model };
            messages.push({ role: "tool", tool_call_id: c.id || `call_${i}`, content: result });
        }
    }
    yield { type: "error", detail: "The assistant hit the tool-call limit without finishing." };
}

// ── Gemini streaming loop ────────────────────────────────────
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

function geminiTools() {
    return [{
        functionDeclarations: TOOLS.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        })),
    }];
}

async function* runGemini(messages, keys, model, useTools = true) {
    const { systemInstruction, contents } = toGeminiContents(messages);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(keys.gemini_api_key)}`;
        const body = {
            contents,
            generationConfig: { maxOutputTokens: 2048 },
        };
        if (useTools) body.tools = geminiTools();
        // Writing straight into the note: hidden thinking would eat the whole
        // token budget on a short continuation, so switch it off.
        else body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        if (systemInstruction) body.systemInstruction = systemInstruction;

        let resp;
        try {
            resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        } catch (err) {
            yield { type: "error", detail: `Could not reach Gemini: ${err.message || err}` };
            return;
        }
        if (!resp.ok) {
            yield { type: "error", detail: `Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
            return;
        }

        let answer = "";
        // Keep each functionCall together with its thoughtSignature — Gemini 3
        // rejects the next request if the signature isn't echoed back.
        const callParts = [];
        for await (const chunk of sseData(resp.body)) {
            let data;
            try { data = JSON.parse(chunk); } catch { continue; }
            const parts = ((data.candidates || [])[0] || {}).content?.parts || [];
            for (const part of parts) {
                if (part.functionCall) {
                    callParts.push({ functionCall: part.functionCall, thoughtSignature: part.thoughtSignature });
                } else if (typeof part.text === "string" && part.text) {
                    answer += part.text;
                    yield { type: "delta", text: part.text };
                }
            }
        }

        if (!callParts.length) return; // final answer streamed

        const modelParts = [];
        if (answer) modelParts.push({ text: answer });
        for (const cp of callParts) {
            const part = { functionCall: cp.functionCall };
            if (cp.thoughtSignature) part.thoughtSignature = cp.thoughtSignature;
            modelParts.push(part);
        }
        contents.push({ role: "model", parts: modelParts });

        const responseParts = [];
        for (const cp of callParts) {
            const fc = cp.functionCall;
            const { detail, result, extra } = await runTool(fc.name, fc.args || {}, keys);
            yield { type: "tool", name: fc.name, detail };
            if (extra.image) yield { type: "image", url: extra.image, alt: extra.alt, provider: extra.provider, model: extra.model };
            responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
        }
        contents.push({ role: "user", parts: responseParts });
    }
    yield { type: "error", detail: "The assistant hit the tool-call limit without finishing." };
}

// ── Public entry point ───────────────────────────────────────
// Yields UI events: {type:"reason"|"delta"|"tool"|"image"|"error", ...}.
// mode "chat" (default) runs the tool-using agent; "complete" continues the
// selected passage and "continue" the whole note — both tool-less, writing
// straight into the note.
async function* runAgent({ provider, messages, note, keys, mode, selection }) {
    let full;
    let useTools = true;
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
        useTools = false;
    } else if (mode === "continue") {
        if (!content) { yield { type: "error", detail: "The note is empty — write a few words first." }; return; }
        full = [
            { role: "system", content: CONTINUE_SYSTEM_PROMPT },
            { role: "user", content: `Continue this note:\n\n${content.slice(-NOTE_CONTEXT_LIMIT)}` },
        ];
        useTools = false;
    } else {
        full = [{ role: "system", content: buildSystemPrompt(note) }, ...messages];
    }
    try {
        if (provider === "gemini") {
            if (!keys.gemini_api_key) { yield { type: "error", detail: "Add a Gemini API key in assistant settings." }; return; }
            yield* runGemini(full, keys, keys.gemini_model || "gemini-2.5-flash", useTools);
        } else {
            if (!keys.openrouter_api_key) { yield { type: "error", detail: "Add an OpenRouter API key in assistant settings." }; return; }
            if (!keys.openrouter_model) { yield { type: "error", detail: "Pick an OpenRouter model in assistant settings." }; return; }
            yield* runOpenRouter(full, keys, keys.openrouter_model, useTools);
        }
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

module.exports = { runAgent, generateImage, DEFAULT_IMAGE_MODEL };
