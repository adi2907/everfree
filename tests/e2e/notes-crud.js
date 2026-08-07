"use strict";

// Create and delete, end to end, through the real UI of both browser clients.
//
// Hermetic: a local static server plus the write-aware GitHub model from
// tests/perf/mock-github.js. Assertions are made against the repo the model
// actually holds afterwards, not against what the page claims — a client that
// renders an optimistic row it never committed has to fail here.
//
// Deleting a notebook is the case worth the harness. It goes through the Git
// Data API rather than the Contents API, so the mock stages trees and commits
// and only applies them when the ref moves, which is the property the real API
// has and the one a client can most easily get wrong.

const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");
const { buildFixture, createMockGitHub } = require("../perf/mock-github");

const WEB_DIR = path.resolve(__dirname, "../../web");
const OWNER = "testuser";
const REPO = "everfree-notes";
const HEADED = process.argv.includes("--headed");
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
      // /mobile/ has to reach web/mobile/index.html, not the desktop shell.
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, "index.html");
      }
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file)) {
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

const TOAST_STUB = `window.toastui = { Editor: function (o) {
  var md = (o && o.initialValue) || "";
  window.__editorValue = md;
  if (o && o.el) o.el.innerHTML = '<div class="toastui-editor-defaultUI"><div class="toastui-editor-toolbar"><button class="toastui-editor-toolbar-icons">Bold</button></div></div>';
  this.getMarkdown = function () { return window.__editorValue; };
  this.setMarkdown = function (v) { window.__editorValue = v; };
  this.getSelection = function () { return [0, 0]; };
  this.setSelection = function () {};
  this.insertText = function (t) { window.__lastEditorInsertion = t; window.__editorValue += t; };
  this.moveCursorToEnd = function () {};
  this.focus = function () {};
  this.on = function () {};
  this.isMarkdownMode = function () { return true; };
  this.destroy = function () {};
} };
window.toastui.Editor.factory = function (o) { return new window.toastui.Editor(o); };`;

async function newSession(browser, mock) {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ owner, repo }) => {
      localStorage.setItem("everfree-token", "gho_faketoken");
      localStorage.setItem("everfree-user", owner);
      localStorage.setItem("everfree-repo", `${owner}/${repo}`);
      localStorage.setItem("everfree-token-expires-at", "0");
    },
    { owner: OWNER, repo: REPO }
  );
  await context.route("https://uicdn.toast.com/**", (route) =>
    route.request().url().endsWith(".css")
      ? route.fulfill({ status: 200, contentType: "text/css", body: "" })
      : route.fulfill({ status: 200, contentType: "text/javascript", body: TOAST_STUB })
  );
  await context.route("https://fonts.googleapis.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/css", body: "" })
  );
  await context.route("https://fonts.gstatic.com/**", (r) => r.fulfill({ status: 200, body: "" }));

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "*",
  };
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    // A cross-origin PUT/DELETE/PATCH carrying JSON is preflighted; answering it
    // is what lets the write itself through.
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors, body: "" });
      return;
    }
    const { status, json } = await mock.handle(request.url(), request.method(), request.postData());
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify(json),
    });
  });
  return context;
}

// window.confirm blocks the page until it is answered.
function autoAcceptDialogs(page) {
  page.on("dialog", (d) => d.accept());
}

// ── Web client ────────────────────────────────────────────────
async function testWeb(browser, mock, port, pageErrors) {
  console.log("\n── web client ──────────────────────────────");
  const context = await newSession(browser, mock);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push("web: " + e.message));
  autoAcceptDialogs(page);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
  await page.waitForSelector("#note-browser-list .note-card", { timeout: 30000 });

  // ── Create a notebook ──
  await page.click("#btn-new-notebook");
  await page.fill("#modal-input", "Field Notes");
  await page.click("#modal-confirm");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".notebook-name")].some((n) => n.textContent === "Field Notes"),
    { timeout: 15000 }
  );
  check("web: new notebook is committed", Boolean(mock.state()["Field Notes"]),
    JSON.stringify(mock.state()["Field Notes"] || null));

  // ── Create a note in it ──
  await page.click("#btn-new-note");
  await page.fill("#modal-input", "First entry");
  await page.click("#modal-confirm");
  await page.waitForFunction(
    () => (window.__editorValue || "").includes("First entry"), { timeout: 15000 });
  check("web: new note is committed",
    (mock.state()["Field Notes"] || []).includes("First entry.md"),
    JSON.stringify(mock.state()["Field Notes"] || null));
  const editorStart = await page.evaluate(() => {
    const toolbar = document.querySelector(".toastui-editor-toolbar");
    return {
      bodyInsertion: window.__lastEditorInsertion,
      toolbarVisible: Boolean(toolbar) && getComputedStyle(toolbar).display !== "none",
    };
  });
  check("web: a new note starts in a body paragraph",
    editorStart.bodyInsertion === "\n", JSON.stringify(editorStart));
  check("web: formatting toolbar is visible",
    editorStart.toolbarVisible, JSON.stringify(editorStart));

  // Committing it is not enough: the note has to be reachable afterwards. A
  // client that re-lists the repo here gets a listing that can still predate
  // the write, and rebuilding from it drops both the note and the notebook that
  // was created moments earlier — the note saves and then vanishes.
  const visible = await page.evaluate(() => ({
    note: [...document.querySelectorAll("#note-browser-list .note-card-title")]
      .some((t) => t.textContent === "First entry"),
    notebook: [...document.querySelectorAll(".notebook-name")]
      .some((n) => n.textContent === "Field Notes"),
  }));
  check("web: new note is listed in the sidebar", visible.note && visible.notebook,
    JSON.stringify(visible));

  // ── Delete a note from the browser's context menu ──
  await page.waitForSelector("#note-browser-list .note-card");
  await page.click("#note-browser-list .note-card", { button: "right" });
  await page.waitForSelector("#context-menu .context-menu-item.danger");
  await page.click("#context-menu .context-menu-item.danger");
  await page.waitForFunction(
    () => !document.getElementById("context-menu"), { timeout: 15000 });
  await page.waitForTimeout(1500);
  check("web: deleted note is gone from the repo",
    !(mock.state()["Field Notes"] || []).includes("First entry.md"),
    JSON.stringify(mock.state()["Field Notes"] || null));

  // ── Delete a whole notebook, notes and all ──
  const before = mock.state();
  const victim = "Notebook 01";
  check("web: target notebook starts populated",
    (before[victim] || []).length > 1, `${(before[victim] || []).length} files`);

  await page.click(`.notebook-header:has(.notebook-name:text-is("${victim}"))`, { button: "right" });
  await page.waitForSelector("#context-menu .context-menu-item.danger");
  await page.click("#context-menu .context-menu-item.danger");
  await page.waitForFunction(
    (name) => ![...document.querySelectorAll(".notebook-name")].some((n) => n.textContent === name),
    victim,
    { timeout: 20000 }
  );
  await page.waitForTimeout(1000);
  check("web: whole notebook is gone from the repo", !mock.state()[victim],
    JSON.stringify(mock.state()[victim] || null));

  // The other notebooks must survive a recursive delete — a prefix match on the
  // wrong boundary would take "Notebook 010" out with "Notebook 01".
  check("web: sibling notebooks survive", Boolean(mock.state()["Notebook 02"]),
    JSON.stringify(mock.state()["Notebook 02"] || null));

  await context.close();
}

// ── Mobile client ─────────────────────────────────────────────
async function testMobile(browser, mock, port, pageErrors) {
  console.log("\n── mobile client ───────────────────────────");
  const context = await newSession(browser, mock);
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  page.on("pageerror", (e) => pageErrors.push("mobile: " + e.message));
  autoAcceptDialogs(page);
  await page.goto(`http://127.0.0.1:${port}/mobile/`, { waitUntil: "commit" });
  await page.waitForSelector("#view-app.active", { timeout: 30000 });

  await page.click('.nav-btn[data-tab="browse"]');
  await page.waitForSelector("#note-list .note-row", { timeout: 30000 });

  // ── Create a notebook ──
  await page.click("#btn-browse-add");
  await page.waitForSelector("#action-sheet:not(.hidden)");
  await page.click('#action-sheet-list .action-row:text-is("New notebook")');
  await page.waitForSelector("#prompt-sheet:not(.hidden)");
  await page.fill("#prompt-input", "Travel");
  await page.click("#btn-prompt-confirm");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".list-section-name")].some((n) => n.textContent === "Travel"),
    { timeout: 20000 }
  );
  check("mobile: new notebook is committed", Boolean(mock.state()["Travel"]),
    JSON.stringify(mock.state()["Travel"] || null));

  // ── Create a note in it ──
  await page.click("#btn-browse-add");
  await page.click('#action-sheet-list .action-row:text-is("New note")');
  await page.waitForSelector("#prompt-sheet:not(.hidden)");
  await page.selectOption("#prompt-select", "Travel");
  await page.fill("#prompt-input", "Packing list");
  await page.click("#btn-prompt-confirm");
  await page.waitForSelector("#view-note-edit.active", { timeout: 20000 });
  check("mobile: new note is committed",
    (mock.state()["Travel"] || []).includes("Packing list.md"),
    JSON.stringify(mock.state()["Travel"] || null));

  // ── Delete that note from the browse list ──
  await page.click("#btn-back-browse");
  await page.waitForSelector("#view-app.active");
  const noteRow = '.note-row:has(.note-row-name:text-is("Packing list")) .row-more';
  await page.waitForSelector(noteRow);
  await page.click(noteRow);
  await page.waitForSelector("#action-sheet:not(.hidden)");
  await page.click('#action-sheet-list .action-row:text-is("Delete note")');
  await page.waitForTimeout(2000);
  check("mobile: deleted note is gone from the repo",
    !(mock.state()["Travel"] || []).includes("Packing list.md"),
    JSON.stringify(mock.state()["Travel"] || null));

  // ── Delete a whole notebook ──
  const victim = "Notebook 02";
  check("mobile: target notebook starts populated",
    (mock.state()[victim] || []).length > 1, `${(mock.state()[victim] || []).length} files`);

  const nbMore = `.list-section-header:has(.list-section-name:text-is("${victim}")) .row-more`;
  await page.waitForSelector(nbMore);
  await page.click(nbMore);
  await page.waitForSelector("#action-sheet:not(.hidden)");
  await page.click('#action-sheet-list .action-row:text-is("Delete notebook")');
  await page.waitForFunction(
    (name) => ![...document.querySelectorAll(".list-section-name")].some((n) => n.textContent === name),
    victim,
    { timeout: 20000 }
  );
  await page.waitForTimeout(1000);
  check("mobile: whole notebook is gone from the repo", !mock.state()[victim],
    JSON.stringify(mock.state()[victim] || null));
  check("mobile: sibling notebooks survive", Boolean(mock.state()["Notebook 03"]),
    JSON.stringify(mock.state()["Notebook 03"] || null));

  await context.close();
}

async function main() {
  const fixture = buildFixture({ notebooks: 3, notesPerNotebook: 4, now: 1750000000000 });
  const mock = createMockGitHub(fixture, { owner: OWNER, repo: REPO });
  const { server, port } = await startStaticServer();
  const browser = await chromium.launch({ headless: !HEADED });
  const pageErrors = [];

  try {
    await testWeb(browser, mock, port, pageErrors);
    await testMobile(browser, mock, port, pageErrors);
  } finally {
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ") || "none");
    await browser.close();
    server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
