// Vercel serverless function — proxies GitHub OAuth Device Flow `device/code` endpoint.
// The browser can't call GitHub OAuth endpoints directly because they don't send CORS headers.

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "Ov23liunA4WFlhQQO9KG";

module.exports = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    if (!GITHUB_CLIENT_ID) {
        res.status(503).json({ error: "EverFree's GitHub OAuth App is not configured." });
        return;
    }

    try {
        const r = await fetch("https://github.com/login/device/code", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "repo" }),
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
};
