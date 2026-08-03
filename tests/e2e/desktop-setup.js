"use strict";

// The desktop setup wizard, driven in a real browser against a real server.
//
// The Evernote import lives only here, and only in step 1, so the questions
// this answers are about where that step is: does a first run offer it, does a
// finished install stop offering it, and — the one that matters after it stops
// being offered — can it still be reached at all?
//
// Every run starts its own server against a temporary notes directory and a
// temporary HOME, so it never sees the developer's notes or credentials.
//
//   node tests/e2e/desktop-setup.js
//   EVERFREE_PYTHON=.venv/bin/python node tests/e2e/desktop-setup.js
//
// Requires playwright + chromium, and a Python with the app's requirements.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "../..");
const PYTHON = process.env.EVERFREE_PYTHON || "python3";
const PORT = Number(process.env.EVERFREE_TEST_PORT || 52398);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everfree-wizard-"));
  const home = path.join(root, "home");
  const notes = path.join(root, "notes");
  fs.mkdirSync(home);
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

/** Load a page and report where it settled, and how hard it worked to get there. */
async function landOn(page, url, { settleMs = 4000 } = {}) {
  const navigations = [];
  const record = (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  };
  page.on("framenavigated", record);
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(settleMs);
  page.off("framenavigated", record);
  return { navigations, url: page.url() };
}

// Returns null when nothing is on screen — including when the page is
// navigating so constantly that it cannot be asked.
const visibleStep = (page) =>
  page
    .evaluate(() => {
      for (const step of [1, 2, 3]) {
        const element = document.getElementById(`step-${step}`);
        if (element && !element.classList.contains("hidden")) return step;
      }
      return null;
    })
    .catch(() => null);

// ══════════════════════════════════════════════════════════
(async () => {
  const versionCheck = spawnSync(PYTHON, ["-c", "import fastapi, uvicorn"], { cwd: REPO_ROOT });
  if (versionCheck.status !== 0) {
    console.error(
      `${PYTHON} cannot import the app's requirements. ` +
        `Set EVERFREE_PYTHON to the interpreter that can (e.g. .venv/bin/python).`
    );
    process.exit(2);
  }

  const sandbox = makeSandbox();
  const { server } = await startServer(sandbox);
  const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  const page = await browser.newPage();

  try {
    // ── A first run offers the import ───────────────────
    await landOn(page, BASE, { settleMs: 2000 });
    check("first run: the wizard opens on the Evernote step", (await visibleStep(page)) === 1);
    check(
      "first run: the import can be started",
      await page.isVisible("#btn-evernote-connect"),
      await page.textContent("#btn-evernote-connect").catch(() => "")
    );
    check(
      "first run: the import can also be skipped",
      await page.isVisible("#btn-skip-evernote")
    );

    // ── Notes already imported: step 1 steps aside ──────
    fs.mkdirSync(path.join(sandbox.notes, "Personal"), { recursive: true });
    fs.writeFileSync(path.join(sandbox.notes, "Personal", "Note.md"), "# Note\n");

    await landOn(page, BASE, { settleMs: 2000 });
    check(
      "after an import: the wizard no longer opens on the Evernote step",
      (await visibleStep(page)) === 2,
      `step ${await visibleStep(page)}`
    );
    await page.click("#btn-back-2");
    check(
      "after an import: the import is still reachable, one step back",
      (await visibleStep(page)) === 1 && (await page.isVisible("#btn-evernote-connect"))
    );

    // ── A finished install, signed out ──────────────────
    // This is what the desktop app's own Sign out button produces: notes
    // directory is a git repo, no GitHub credential. `/` and `/setup` both
    // have to lead somewhere.
    fs.mkdirSync(path.join(sandbox.notes, ".git"), { recursive: true });
    const status = await (await fetch(`${BASE}/api/setup/status`)).json();
    check(
      "signed out: the server agrees this install is configured and unauthenticated",
      status.configured === true && status.github_authenticated === false,
      JSON.stringify({ configured: status.configured, auth: status.github_authenticated })
    );

    const root = await landOn(page, BASE);
    check(
      "signed out: opening the app does not bounce between / and the wizard",
      root.navigations.length <= 3,
      `${root.navigations.length} navigations in 4s`
    );

    const setup = await landOn(page, `${BASE}/setup`);
    check(
      "signed out: /setup reaches the wizard so the user can sign back in",
      setup.navigations.length <= 3 && (await visibleStep(page)) !== null,
      `${setup.navigations.length} navigations, step ${await visibleStep(page)}`
    );
    // Hidden is the requirement; gone is not. "← Back" from the GitHub step
    // is the only route to it, which is thin but real — if this passes and
    // you still want a signposted entry point, that is a UI decision, not a
    // broken one.
    await page.click("#btn-back-2").catch(() => {});
    check(
      "signed out: the Evernote import is still reachable from the wizard",
      (await visibleStep(page)) === 1 &&
        (await page.isVisible("#btn-evernote-connect").catch(() => false))
    );
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
