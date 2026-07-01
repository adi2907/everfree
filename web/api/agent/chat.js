// Vercel serverless function — streams the EverFree assistant's agent loop as
// ndjson. Keys arrive per-request from the browser (localStorage); nothing is
// stored server-side. The browser can't call the LLM/Serper providers directly
// (CORS, key exposure), so this thin proxy runs the loop.

const { runAgent } = require("../../lib/agent-core.js");

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const body = req.body || {};
    const provider = body.provider === "gemini" ? "gemini" : "openrouter";
    const note = body.note || {};
    const keys = body.keys || {};
    const messages = (Array.isArray(body.messages) ? body.messages : [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-12);

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const write = (event) => {
        try { res.write(JSON.stringify(event) + "\n"); } catch { /* client gone */ }
    };

    try {
        for await (const event of runAgent({ provider, messages, note, keys })) {
            write(event);
        }
    } catch (err) {
        write({ type: "error", detail: err && err.message ? err.message : String(err) });
    }
    res.end();
};
