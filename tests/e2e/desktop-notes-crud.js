"use strict";

// Create and delete, end to end, in the desktop app.
//
// The browser clients commit to GitHub; the desktop app writes to a notes
// directory on disk and lets the sync worker push it later. So this is the
// third implementation of the same feature, and the only one whose result can
// be checked by looking at the filesystem — which is what the assertions do.
//
// Hermetic: every run starts its own server against a temporary notes
// directory and a temporary HOME, so it never sees the developer's notes or
// credentials, and never reaches the network.
//
//   node tests/e2e/desktop-notes-crud.js
//   EVERFREE_PYTHON=.venv/bin/python node tests/e2e/desktop-notes-crud.js
//
// The UI is loaded from /static/index.html rather than /, because / serves the
// setup wizard until a GitHub token is in the OS keyring and this test must not
// put one there. /static is the same file the app itself loads, and every API
// call under test still goes to the real server.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "../..");
const PYTHON = process.env.EVERFREE_PYTHON || "python3";
const PORT = Number(process.env.EVERFREE_TEST_PORT || 52399);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes("--headed");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everfree-crud-"));
  const home = path.join(root, "home");
  const notes = path.join(root, "notes");
  fs.mkdirSync(home);
  // Seed two notebooks so a delete has both a victim and a neighbour.
  for (const nb of ["Archive", "Journal"]) {
    fs.mkdirSync(path.join(notes, nb), { recursive: true });
    for (const note of ["One", "Two"]) {
      fs.writeFileSync(path.join(notes, nb, `${note}.md`), `# ${note}\n\nBody of ${nb}/${note}.\n`);
    }
  }
  return { root, home, notes };
}

async function startServer(sandbox) {
  const server = spawn(PYTHON, ["run.py"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: sandbox.home, // keeps the real ~/.everfree_auth.json out of reach
      EVERFREE_DIR: sandbox.notes,
      EVERFREE_PORT: String(PORT),
      EVERFREE_NO_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  server.stdout.on("data", (d) => log.push(String(d)));
  server.stderr.on("data", (d) => log.push(String(d)));

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/setup/status`);
      if (response.ok) return { server, log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start on ${PORT}:\n${log.join("")}`);
}

const listNotes = (sandbox, nb) => {
  const dir = path.join(sandbox.notes, nb);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null;
};

// ══════════════════════════════════════════════════════════
(async () => {
  const deps = spawnSync(PYTHON, ["-c", "import fastapi, uvicorn"], { cwd: REPO_ROOT });
  if (deps.status !== 0) {
    console.error(
      `${PYTHON} cannot import the app's requirements. ` +
        `Set EVERFREE_PYTHON to the interpreter that can (e.g. .venv/bin/python).`
    );
    process.exit(2);
  }

  const sandbox = makeSandbox();
  const { server } = await startServer(sandbox);
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  const pageErrors = [];

  // The editor is a third-party CDN bundle; stub it so the test measures
  // EverFree and not uicdn.toast.com, and so the run stays offline.
  await context.route("https://uicdn.toast.com/**", (route) =>
    route.request().url().endsWith(".css")
      ? route.fulfill({ status: 200, contentType: "text/css", body: "" })
      : route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: `window.toastui = { Editor: function (o) {
            window.__editorValue = (o && o.initialValue) || "";
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

  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => d.accept());

  try {
    await page.goto(`${BASE}/static/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#note-browser-list .note-card", { timeout: 30000 });

    // ── Create a notebook ──
    await page.click("#btn-new-notebook");
    await page.fill("#modal-input", "Recipes");
    await page.click("#modal-confirm");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".notebook-name")].some((n) => n.textContent === "Recipes"),
      { timeout: 15000 }
    );
    check("desktop: new notebook exists on disk",
      fs.existsSync(path.join(sandbox.notes, "Recipes")));

    // ── Create a note in it ──
    await page.click("#btn-new-note");
    await page.fill("#modal-input", "Bread");
    await page.click("#modal-confirm");
    await page.waitForTimeout(2000);
    check("desktop: new note exists on disk",
      (listNotes(sandbox, "Recipes") || []).includes("Bread.md"),
      JSON.stringify(listNotes(sandbox, "Recipes")));

    // ── Delete a note from its context menu ──
    await page.click('.note-card:has(.note-card-title:text-is("Bread"))', { button: "right" });
    await page.waitForSelector("#context-menu .context-menu-item.danger");
    await page.click("#context-menu .context-menu-item.danger");
    await page.waitForTimeout(2000);
    check("desktop: deleted note is gone from disk",
      !(listNotes(sandbox, "Recipes") || []).includes("Bread.md"),
      JSON.stringify(listNotes(sandbox, "Recipes")));

    // ── Delete a whole notebook, notes and all ──
    check("desktop: target notebook starts populated",
      (listNotes(sandbox, "Archive") || []).length === 2,
      JSON.stringify(listNotes(sandbox, "Archive")));

    await page.click('.notebook-header:has(.notebook-name:text-is("Archive"))', { button: "right" });
    await page.waitForSelector("#context-menu");
    await page.click('#context-menu .context-menu-item:text-is("Delete notebook")');
    await page.waitForFunction(
      () => ![...document.querySelectorAll(".notebook-name")].some((n) => n.textContent === "Archive"),
      { timeout: 20000 }
    );
    await page.waitForTimeout(1000);
    check("desktop: whole notebook is gone from disk",
      !fs.existsSync(path.join(sandbox.notes, "Archive")));

    // A neighbour must survive: the delete removes one directory, not a prefix
    // match across the notes tree.
    check("desktop: sibling notebook survives",
      (listNotes(sandbox, "Journal") || []).length === 2,
      JSON.stringify(listNotes(sandbox, "Journal")));

    check("desktop: no uncaught page errors", pageErrors.length === 0,
      pageErrors.join(" | ") || "none");
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
