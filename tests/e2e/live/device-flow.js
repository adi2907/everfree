"use strict";

// ┌──────────────────────────────────────────────────────────┐
// │  THIS TALKS TO THE REAL INTERNET AND TO PRODUCTION.      │
// │  Real github.com, the live everfree.vercel.app, the real │
// │  EverFree OAuth App. No fixtures, no mocks. Everything   │
// │  under tests/e2e/live/ is like this; everything one      │
// │  directory up is hermetic.                               │
// └──────────────────────────────────────────────────────────┘
//
// It answers "is sign-in working right now, in production" for everything
// that does not require a person: GitHub issues a code for EverFree's OAuth
// App, the deployed proxy relays it, both browser clients display it, and the
// poll comes back `authorization_pending`. The step it stops at is the one
// GitHub deliberately reserves for a human — entering the code and pressing
// Authorize. Pair it with `../device-flow.js`, which covers everything after
// that point without touching the network.
//
//   node tests/e2e/live/device-flow.js
//   node tests/e2e/live/device-flow.js --desktop http://127.0.0.1:52321
//
// Nothing here writes: no repository is created, no note is committed, no
// token is ever obtained. What it does leave behind is a few unused device
// codes pending on the OAuth App; they expire in 15 minutes and authorize
// nothing. Point it somewhere else with EVERFREE_SITE.

const { chromium, devices } = require("playwright");

const SITE = process.env.EVERFREE_SITE || "https://everfree.vercel.app";
const CLIENT_ID = process.env.EVERFREE_GITHUB_CLIENT_ID || "Ov23liunA4WFlhQQO9KG";
const DESKTOP = (() => {
  const i = process.argv.indexOf("--desktop");
  return i === -1 ? null : process.argv[i + 1];
})();
const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: await response.json() };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// ── 1. GitHub itself ──────────────────────────────────────
async function checkGitHubDirectly() {
  const { status, body } = await postForm("https://github.com/login/device/code", {
    client_id: CLIENT_ID,
    scope: "repo",
  });

  // Device Flow is opt-in per OAuth App. Switched off, GitHub answers
  // `device_flow_disabled` and every client breaks at once.
  check(
    "GitHub issues a device code for EverFree's OAuth App",
    status === 200 && USER_CODE_PATTERN.test(body.user_code || ""),
    body.error || body.user_code
  );
  check(
    "the code is for github.com/login/device",
    body.verification_uri === "https://github.com/login/device",
    body.verification_uri
  );
  check(
    "GitHub asks clients to poll no faster than it allows",
    Number.isFinite(body.interval) && body.interval > 0,
    `interval ${body.interval}s`
  );
  return body.device_code;
}

async function checkScopeIsRepo(deviceCode) {
  // The token cannot be inspected before authorization, so the closest live
  // check is that GitHub accepted `scope=repo` at issue time: a rejected
  // scope fails the start call outright, which the check above would catch.
  const { body } = await postForm("https://github.com/login/oauth/access_token", {
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  check(
    "an unauthorized code is pending, not accepted",
    body.error === "authorization_pending",
    body.error
  );
}

// ── 2. The deployed proxy ─────────────────────────────────
async function checkDeployedProxy(base) {
  const start = await postJson(`${base}/api/github/device-start`);
  check(
    `${base}: device-start returns a usable code`,
    start.status === 200 && USER_CODE_PATTERN.test(start.body.user_code || ""),
    start.body.error || start.body.user_code
  );
  if (!start.body.device_code) return;

  const poll = await postJson(`${base}/api/github/device-poll`, {
    device_code: start.body.device_code,
  });
  check(
    `${base}: device-poll relays GitHub's pending answer`,
    poll.body.error === "authorization_pending",
    poll.body.error || JSON.stringify(poll.body).slice(0, 80)
  );

  const missing = await postJson(`${base}/api/github/device-poll`, {});
  check(`${base}: device-poll rejects a request with no device code`, missing.status === 400);

  const wrongMethod = await fetch(`${base}/api/github/device-start`);
  check(`${base}: device-start refuses GET`, wrongMethod.status === 405, String(wrongMethod.status));

  // A cached device code would hand the same one-shot code to two people.
  const cacheControl = (await fetch(`${base}/api/github/device-start`, { method: "POST" }))
    .headers.get("cache-control");
  check(
    `${base}: device codes are not cacheable`,
    /no-store/.test(cacheControl || ""),
    cacheControl
  );
}

// ── 3. The deployed clients, in a real browser ────────────
async function checkClientPage(browser, url, { mobile }) {
  const label = mobile ? "mobile" : "web";
  const context = await browser.newContext(mobile ? devices["iPhone 14"] : {});
  const page = await context.newPage();
  const polls = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/github/device-poll")) polls.push(response);
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  check(`${label}: ${url} serves the sign-in screen`, await page.isVisible(
    mobile ? "#btn-signin" : "#btn-github-signin-hero"
  ));

  await page.click(mobile ? "#btn-signin" : "#btn-github-signin-hero");
  const codeSelector = mobile ? "#user-code" : "#signin-user-code";
  const gotCode = await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(el.textContent.trim());
      },
      codeSelector,
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);
  const code = (await page.textContent(codeSelector).catch(() => "")).trim();
  check(`${label}: the live page shows a real device code`, gotCode, code);

  // The screen has to say where to type it, or the code is useless.
  const bodyText = await page.textContent("body");
  check(
    `${label}: the page tells the user where to enter it`,
    /github\.com\/login\/device/.test(bodyText),
    ""
  );

  // Poll interval comes from GitHub (5s); wait past one to see it happen.
  await page.waitForTimeout(7000);
  check(
    `${label}: the page polls for authorization`,
    polls.length >= 1,
    `${polls.length} poll(s)`
  );
  if (polls.length) {
    const body = await polls[0].json().catch(() => ({}));
    check(
      `${label}: the poll is answered (pending until a human authorizes)`,
      body.error === "authorization_pending",
      body.error || JSON.stringify(body).slice(0, 60)
    );
  }

  check(
    `${label}: nothing is stored before authorization`,
    (await page.evaluate(() => localStorage.getItem("everfree-token"))) === null
  );

  await context.close();
}

// ── 4. The desktop app, if one is running ─────────────────
async function checkDesktop(base) {
  const start = await fetch(`${base}/api/auth/github/start`, { method: "POST" });
  const body = await start.json().catch(() => ({}));
  check(
    `desktop ${base}: /api/auth/github/start returns a real code`,
    start.status === 200 && USER_CODE_PATTERN.test(body.user_code || ""),
    body.detail || body.user_code
  );

  const status = await (await fetch(`${base}/api/auth/github/status`)).json();
  check(
    `desktop ${base}: status reports the flow as pending`,
    status.status === "pending",
    status.status
  );
  check(
    "desktop: the access token is never exposed over HTTP",
    !("access_token" in status),
    Object.keys(status).join(",")
  );
}

// ══════════════════════════════════════════════════════════
(async () => {
  console.log("LIVE — real github.com and real production. Read-only.");
  console.log(`site ${SITE}   client_id ${CLIENT_ID}\n`);

  const deviceCode = await checkGitHubDirectly();
  if (deviceCode) await checkScopeIsRepo(deviceCode);
  console.log("");
  await checkDeployedProxy(SITE);
  console.log("");

  const browser = await chromium.launch({ headless: true });
  try {
    await checkClientPage(browser, SITE, { mobile: false });
    console.log("");
    await checkClientPage(browser, `${SITE}/mobile/`, { mobile: true });
  } finally {
    await browser.close();
  }

  if (DESKTOP) {
    console.log("");
    await checkDesktop(DESKTOP);
  } else {
    console.log("\n(skipped: desktop app — pass --desktop http://127.0.0.1:52321)");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
  console.log(
    "Not covered, and not coverable: entering the code at github.com/login/device.\n" +
      "Everything after that point is covered by tests/e2e/device-flow.js, offline."
  );
  process.exit(failed.length ? 1 : 0);
})();
