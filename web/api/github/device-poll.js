// Vercel serverless function — proxies GitHub Device Flow token-poll endpoint.
// The browser polls this every few seconds until the user finishes authorizing.

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "Ov23liunA4WFlhQQO9KG";

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const deviceCode = req.body && req.body.device_code;
    if (!deviceCode) {
        res.status(400).json({ error: "device_code is required" });
        return;
    }

    try {
        const r = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                client_id: GITHUB_CLIENT_ID,
                device_code: deviceCode,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
        });

        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
};
