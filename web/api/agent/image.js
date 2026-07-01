// Vercel serverless function — generates one image and returns it as an inline
// data URL. Keys arrive per-request from the browser; nothing is stored.

const { generateImage } = require("../../lib/agent-core.js");

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const body = req.body || {};
    try {
        const info = await generateImage(body.prompt || "", body.keys || {});
        res.status(200).json(info); // { dataUrl, provider, model }
    } catch (err) {
        res.status(400).json({ detail: err && err.message ? err.message : String(err) });
    }
};
