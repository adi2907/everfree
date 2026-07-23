"use strict";

// Functional smoke test for the optimised loader: the sidebar populates, a note
// opens, titles resolve, and a reload serves them from the persisted cache
// without refetching content. Fails loudly on any uncaught page error.

const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");
const { buildFixture, createMockGitHub } = require("./mock-github");

const WEB_DIR = path.resolve(__dirname, "../../web");
const OWNER = "testuser";
const REPO = "everfree-notes";
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

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function newSession(browser, mock, storageState) {
  const context = await browser.newContext(storageState ? { storageState } : {});
  await context.addInitScript(
    ({ owner, repo }) => {
      localStorage.setItem("everfree-token", "gho_faketoken");
      localStorage.setItem("everfree-user", owner);
      localStorage.setItem("everfree-repo", `${owner}/${repo}`);
      localStorage.setItem("everfree-token-expires-at", String(Date.now() + 3600 * 1000));
    },
    { owner: OWNER, repo: REPO }
  );
  // Minimal Toast UI stand-in: enough surface for initEditor / openNote.
  await context.route("https://uicdn.toast.com/**", (route) =>
    route.request().url().endsWith(".css")
      ? route.fulfill({ status: 200, contentType: "text/css", body: "" })
      : route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: `window.toastui = { Editor: function (o) {
            var md = (o && o.initialValue) || "";
            window.__editorValue = md;
            this.getMarkdown = function () { return window.__editorValue; };
            this.setMarkdown = function (v) { window.__editorValue = v; };
            this.getSelection = function () { return [0, 0]; };
            this.setSelection = function () {};
            this.insertText = function (t) { window.__editorValue += t; };
            this.moveCursorToEnd = function () {};
            this.focus = function () {};
            this.on = function () {};
            this.isMarkdownMode = function () { return true; };
            this.destroy = function () {};
          } };
          window.toastui.Editor.factory = function (o) { return new window.toastui.Editor(o); };`,
        })
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
  return context;
}

async function main() {
  const fixture = buildFixture({ notebooks: 3, notesPerNotebook: 8, now: 1750000000000 });
  const mock = createMockGitHub(fixture, { owner: OWNER, repo: REPO });
  const { server, port } = await startStaticServer();
  const browser = await chromium.launch();
  const pageErrors = [];

  // ── Cold session ──────────────────────────────────────────
  let context = await newSession(browser, mock);
  let page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });

  await page.waitForSelector("#note-browser-list .note-card", { timeout: 30000 });
  const cardCount = await page.evaluate(() => document.querySelectorAll(".note-card").length);
  check("sidebar renders every note", cardCount === 24, `${cardCount} cards`);

  const nbCount = await page.evaluate(() => document.querySelectorAll(".notebook-header").length);
  check("notebook rail renders", nbCount === 3, `${nbCount} notebooks`);

  await page.waitForFunction(
    () => {
      const t = document.querySelector(".note-card .note-card-title");
      return t && /^Title of /.test(t.textContent);
    },
    { timeout: 30000 }
  );
  check("visible card titles resolve to their H1", true);

  // Open a note.
  await page.click("#note-browser-list .note-card");
  await page.waitForFunction(() => (window.__editorValue || "").includes("Body text for"), { timeout: 30000 });
  const opened = await page.evaluate(() => ({
    md: window.__editorValue,
    crumb: (document.getElementById("note-breadcrumb") || {}).textContent,
  }));
  check("clicking a card loads its content", /Body text for/.test(opened.md), opened.crumb);

  // Let recency hydration finish, then snapshot the cache.
  await page.waitForTimeout(12000);
  const meta = await page.evaluate(() => JSON.parse(localStorage.getItem("everfree-note-meta-v1") || "{}"));
  const metaEntries = Object.keys(meta).length;
  check("metadata cache persisted", metaEntries > 0, `${metaEntries} blob-SHA entries`);
  const withTimes = Object.values(meta).filter((m) => m && m.t).length;
  check("hydration recorded modified times", withTimes > 0, `${withTimes} entries with a time`);

  const storageState = await context.storageState();
  await context.close();

  // ── Warm session ──────────────────────────────────────────
  const before = { ...mock.counts };
  context = await newSession(browser, mock, storageState);
  page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
  await page.waitForSelector("#note-browser-list .note-card", { timeout: 30000 });

  // Only cards that were on screen during the cold session have a cached title
  // — offscreen ones are never fetched, by design. So the guarantee is about
  // what the user can actually see: every visible card is titled at first paint.
  const paint = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#note-browser-list .note-card")];
    const visible = cards.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    const titled = visible.filter((c) =>
      /^Title of /.test(c.querySelector(".note-card-title").textContent)
    );
    return { visible: visible.length, titled: titled.length };
  });
  check(
    "warm load paints every visible title immediately",
    paint.visible > 0 && paint.titled === paint.visible,
    `${paint.titled}/${paint.visible} visible cards titled at first paint`
  );

  await page.waitForTimeout(1500);
  const contentFetches = mock.counts.contentsFile - before.contentsFile;
  check("warm load refetches no note content", contentFetches === 0, `${contentFetches} content requests`);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ") || "none");

  await browser.close();
  server.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
