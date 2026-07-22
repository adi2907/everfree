"use strict";

// Dumps the note order the sidebar actually renders, so the optimised loader
// can be diffed against the original per-note `commits?path=` implementation.
//
//   node tests/perf/dump-order.js --notebooks 4 --notes 12 > order.json

const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");
const { buildFixture, createMockGitHub } = require("./mock-github");

const WEB_DIR = path.resolve(__dirname, "../../web");
const OWNER = "testuser";
const REPO = "everfree-notes";
const FIXTURE_EPOCH = 1750000000000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let file = path.join(WEB_DIR, urlPath === "/" ? "index.html" : urlPath);
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(WEB_DIR, "index.html");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const notebooks = Number(args.notebooks || 4);
  const notesPerNotebook = Number(args.notes || 12);
  const settleMs = Number(args.settle || 12000);

  const fixture = buildFixture({ notebooks, notesPerNotebook, now: FIXTURE_EPOCH, shuffle: !!args.shuffle });
  const mock = createMockGitHub(fixture, { owner: OWNER, repo: REPO });
  const { server, port } = await startStaticServer();
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addInitScript(
    ({ owner, repo }) => {
      sessionStorage.setItem("everfree-token", "gho_faketoken");
      sessionStorage.setItem("everfree-user", owner);
      sessionStorage.setItem("everfree-repo", `${owner}/${repo}`);
      sessionStorage.setItem("everfree-token-expires-at", String(Date.now() + 3600 * 1000));
    },
    { owner: OWNER, repo: REPO }
  );
  await context.route("https://uicdn.toast.com/**", (route) =>
    route.request().url().endsWith(".css")
      ? route.fulfill({ status: 200, contentType: "text/css", body: "" })
      : route.fulfill({ status: 200, contentType: "text/javascript", body: "window.toastui={Editor:function(){}};" })
  );
  await context.route("https://fonts.googleapis.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/css", body: "" })
  );
  await context.route("https://fonts.gstatic.com/**", (r) => r.fulfill({ status: 200, body: "" }));
  await context.route("https://api.github.com/**", async (route) => {
    const { status, json } = await mock.handle(route.request().url());
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(json),
    });
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
  await page.waitForSelector("#note-browser-list .note-card", { timeout: 60000 });
  // Let the async recency hydration land and re-sort.
  await page.waitForTimeout(settleMs);

  const order = await page.evaluate(() =>
    [...document.querySelectorAll("#note-browser-list .note-card")].map((c) => c.dataset.notePath)
  );
  const notebookOrder = await page.evaluate(() =>
    [...document.querySelectorAll("#notebook-list .notebook-name")].map((n) => n.textContent)
  );

  console.log(JSON.stringify({ notebookOrder, order, requests: mock.counts }, null, 2));

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
