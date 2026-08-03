"use strict";

// End-to-end GitHub sign-in for the two browser clients.
//
// The one step this cannot perform is the one a person has to perform: typing
// the code into github.com/login/device and pressing Authorize. GitHub has no
// API for that, by design — that page is the consent. So the split here is:
//
//   * `live/device-flow.js` proves the real endpoints issue a real code and
//     answer a real poll, using no fixtures at all. It is the one that goes
//     to production; this file never leaves the machine.
//   * this file proves the clients do the right thing with every answer that
//     poll can give — pending, slow_down, denied, and a token — including
//     everything that happens after a token arrives.
//
// Between the two, the only untested link is GitHub's own consent page.
//
//   node tests/e2e/device-flow.js            # both clients
//   node tests/e2e/device-flow.js --headed   # watch it
//
// Requires playwright + chromium (`npx playwright install chromium`).

const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");
const { buildFixture, createMockGitHub } = require("../perf/mock-github");

const WEB_DIR = path.resolve(__dirname, "../../web");
const OWNER = "testuser";
const REPO = "everfree-notes";
const USER_CODE = "WDJB-MJHT";
const DEVICE_CODE = "3584d83530557fdd1f46af8289938c8ef79f9dc5";
const ACCESS_TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const HEADED = process.argv.includes("--headed");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
};

// ── Reporting ─────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── Static server, mirroring web/vercel.json ──────────────
function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/mobile") {
        res.writeHead(307, { Location: "/mobile/" });
        res.end();
        return;
      }
      let file = path.join(WEB_DIR, urlPath === "/" ? "index.html" : urlPath);
      if (urlPath === "/mobile/") file = path.join(WEB_DIR, "mobile", "index.html");
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // The deployed rewrite sends unmatched non-/mobile paths to the SPA.
        file = path.join(WEB_DIR, urlPath.startsWith("/mobile") ? "mobile/index.html" : "index.html");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Scripted stand-in for web/api/github/*.js.
 *
 * `pollAnswers` is consumed one entry per poll, so a scenario states exactly
 * what GitHub says and when: two pendings, a slow_down, then a token.
 */
function makeDeviceEndpoints({ startStatus = 200, startBody, pollAnswers }) {
  const state = { starts: 0, polls: 0, deviceCodesSeen: new Set() };
  const answers = [...pollAnswers];

  async function route(route_) {
    const url = new URL(route_.request().url());
    const json = (status, body) =>
      route_.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.endsWith("/device-start")) {
      state.starts++;
      if (route_.request().method() !== "POST") return json(405, { error: "Method not allowed" });
      return json(
        startStatus,
        startBody || {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1, // 5s in production; the client honours whatever it is told
        }
      );
    }

    state.polls++;
    const body = JSON.parse(route_.request().postData() || "{}");
    if (body.device_code) state.deviceCodesSeen.add(body.device_code);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return json(200, answer);
  }

  return { route, state };
}

/** GitHub API mock plus the writes the mock in perf/ has no reason to model. */
function makeGitHubRoute(mock, { repoExists = true } = {}) {
  const created = { repo: null };
  // Files the client has committed this session, so a note it wrote can be
  // read back the way the real API would serve it.
  const written = new Map();
  const contentsPrefix = `/repos/${OWNER}/${REPO}/contents/`;

  const route = async (route_) => {
    const request = route_.request();
    const url = new URL(request.url());
    const json = (status, body) =>
      route_.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (!(request.headers()["authorization"] || "").startsWith("Bearer ")) {
      return json(401, { message: "Requires authentication" });
    }

    if (request.method() === "POST" && url.pathname === "/user/repos") {
      const body = JSON.parse(request.postData() || "{}");
      created.repo = body;
      return json(201, {
        full_name: `${OWNER}/${body.name}`,
        name: body.name,
        private: body.private,
        default_branch: "main",
        id: 42,
      });
    }

    if (request.method() === "PUT" && url.pathname.startsWith(contentsPrefix)) {
      const filePath = decodeURIComponent(url.pathname.slice(contentsPrefix.length));
      const body = JSON.parse(request.postData() || "{}");
      const sha = `sha-written-${written.size + 1}`;
      written.set(filePath, { ...body, sha });
      return json(201, {
        content: { path: filePath, sha, name: filePath.split("/").pop() },
        commit: { message: body.message },
      });
    }

    // Before the repo is created, it must 404 — that 404 is what sends the
    // client down the create path.
    if (!repoExists && !created.repo && url.pathname === `/repos/${OWNER}/${REPO}`) {
      return json(404, { message: "Not Found" });
    }

    if (url.pathname.startsWith(contentsPrefix)) {
      const filePath = decodeURIComponent(url.pathname.slice(contentsPrefix.length));
      const file = written.get(filePath);
      if (file) {
        return json(200, {
          type: "file", name: filePath.split("/").pop(), path: filePath,
          sha: file.sha, content: file.content, encoding: "base64",
        });
      }
      if (!repoExists) {
        // A freshly created repository: directory listings are empty and a
        // note that was never written is genuinely absent.
        const isDirectory = !filePath.includes(".");
        const children = [...written.keys()]
          .filter((p) => p.startsWith(`${filePath}/`))
          .map((p) => ({
            type: "file", name: p.split("/").pop(), path: p, sha: written.get(p).sha,
          }));
        return isDirectory ? json(200, children) : json(404, { message: "Not Found" });
      }
    }
    if (!repoExists && url.pathname === `/repos/${OWNER}/${REPO}/contents`) {
      const directories = new Set(
        [...written.keys()].filter((p) => p.includes("/")).map((p) => p.split("/")[0])
      );
      return json(200, [...directories].map((name) => ({ type: "dir", name, path: name })));
    }
    if (!repoExists && url.pathname.startsWith(`/repos/${OWNER}/${REPO}/commits`)) {
      return json(200, []);
    }

    const { status, json: payload } = await mock.handle(request.url());
    return json(status, payload);
  };

  route.written = written;
  return route;
}

const decodeContent = (base64) => Buffer.from(base64, "base64").toString("utf8");

// Third-party assets the clients load; stubbed so a CDN outage is not a test
// failure, and so no test traffic leaves the machine.
async function stubThirdParty(context) {
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
  for (const pattern of ["https://fonts.googleapis.com/**", "https://fonts.gstatic.com/**"]) {
    await context.route(pattern, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  }
}

async function newContext(browser, { mobile, devices, gitHubRoute }) {
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
                     "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" }
      : {}
  );
  await stubThirdParty(context);
  await context.route("**/api/github/device-*", devices.route);
  await context.route("https://api.github.com/**", gitHubRoute);
  return context;
}

const storageOf = (page) =>
  page.evaluate(() => ({
    token: localStorage.getItem("everfree-token"),
    user: localStorage.getItem("everfree-user"),
    repo: localStorage.getItem("everfree-repo"),
    sessionToken: sessionStorage.getItem("everfree-token"),
  }));

// ══════════════════════════════════════════════════════════
//  Scenarios
// ══════════════════════════════════════════════════════════

/** The ordinary case: a returning user whose notes repository exists. */
async function signInAndLoadNotes(browser, base, mock, { mobile }) {
  const label = mobile ? "mobile" : "web";
  const devices = makeDeviceEndpoints({
    pollAnswers: [
      { error: "authorization_pending", error_description: "The authorization request is still pending." },
      { error: "slow_down", error_description: "Too many requests", interval: 10 },
      { access_token: ACCESS_TOKEN, token_type: "bearer", scope: "repo" },
    ],
  });
  const context = await newContext(browser, { mobile, devices, gitHubRoute: makeGitHubRoute(mock) });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(mobile ? `${base}/mobile/` : base);
  await page.click(mobile ? "#btn-signin" : "#btn-github-signin-hero");

  const codeSelector = mobile ? "#user-code" : "#signin-user-code";
  await page.waitForFunction(
    (sel) => document.querySelector(sel) && document.querySelector(sel).textContent.includes("-"),
    codeSelector,
    { timeout: 10000 }
  );
  const shownCode = (await page.textContent(codeSelector)).trim();
  check(`${label}: the device code GitHub issued is the one shown`, shownCode === USER_CODE, shownCode);

  const linkSelector = mobile ? "#verify-url" : "#signin-verification-uri";
  const href = await page.getAttribute(linkSelector, "href");
  check(
    `${label}: the page links to github.com/login/device`,
    href === "https://github.com/login/device",
    href
  );

  // A denied code must not be reusable, and a pending one must not be
  // abandoned: every poll carries the device_code the start call returned.
  const appSelector = mobile ? "#view-app.active" : "#view-app:not(.hidden)";
  await page.waitForSelector(appSelector, { timeout: 20000 });
  check(
    `${label}: polling survives authorization_pending and slow_down`,
    devices.state.polls >= 3,
    `${devices.state.polls} polls`
  );
  check(
    `${label}: every poll used the issued device_code`,
    devices.state.deviceCodesSeen.size === 1 && devices.state.deviceCodesSeen.has(DEVICE_CODE),
    [...devices.state.deviceCodesSeen].join(",")
  );

  const listSelector = mobile ? "#note-list .note-row" : ".note-browser-list *";
  if (mobile) await page.click('.nav-btn[data-tab="browse"]');
  await page.waitForSelector(listSelector, { timeout: 20000 });
  const noteCount = await page.locator(listSelector).count();
  check(`${label}: notes from the repository render after sign-in`, noteCount > 0, `${noteCount} elements`);

  const stored = await storageOf(page);
  check(
    `${label}: the token is stored for the signed-in user and repository`,
    stored.token === ACCESS_TOKEN && stored.user === OWNER && stored.repo === `${OWNER}/${REPO}`,
    JSON.stringify({ user: stored.user, repo: stored.repo })
  );

  // ADR 0001 / CLAUDE.md: the session outlives a restart on purpose.
  await page.reload();
  await page.waitForSelector(appSelector, { timeout: 20000 });
  check(
    `${label}: a reload keeps the session without a second device code`,
    devices.state.starts === 1,
    `${devices.state.starts} device-start call(s)`
  );

  // Sign out is the only thing that ends it.
  if (mobile) {
    await page.click('.nav-btn[data-tab="account"]');
    await page.click("#btn-signout");
  } else {
    await page.click("#btn-account");
    await page.click("#btn-signout");
  }
  await page.waitForSelector(mobile ? "#view-signin.active" : "#view-signin:not(.hidden)", { timeout: 10000 });
  const cleared = await storageOf(page);
  check(
    `${label}: signing out clears the token from both stores`,
    !cleared.token && !cleared.user && !cleared.repo && !cleared.sessionToken,
    JSON.stringify(cleared)
  );

  check(`${label}: no uncaught page errors during sign-in`, pageErrors.length === 0, pageErrors[0]);
  await context.close();
}

/** A person with no notes repository yet — the "web alone is enough" case. */
async function firstRunCreatesRepository(browser, base, mock, { mobile }) {
  const label = mobile ? "mobile" : "web";
  const devices = makeDeviceEndpoints({
    pollAnswers: [{ access_token: ACCESS_TOKEN, token_type: "bearer", scope: "repo" }],
  });
  const gitHubRoute = makeGitHubRoute(mock, { repoExists: false });
  const createdRepos = [];
  const context = await newContext(browser, { mobile, devices, gitHubRoute });
  await context.route("https://api.github.com/user/repos", async (route_) => {
    if (route_.request().method() === "POST") {
      createdRepos.push(JSON.parse(route_.request().postData() || "{}"));
    }
    await gitHubRoute(route_);
  });

  const page = await context.newPage();
  await page.goto(mobile ? `${base}/mobile/` : base);
  await page.click(mobile ? "#btn-signin" : "#btn-github-signin-hero");
  await page.waitForSelector(mobile ? "#view-app.active" : "#view-app:not(.hidden)", { timeout: 20000 });

  const created = createdRepos[0] || {};
  check(
    `${label}: a first run creates exactly one repository, named everfree-notes`,
    createdRepos.length === 1 && created.name === REPO,
    JSON.stringify(createdRepos)
  );
  check(`${label}: the repository it creates is private`, created.private === true, String(created.private));
  check(
    `${label}: the new repository is initialised so it has a branch to commit to`,
    created.auto_init === true,
    String(created.auto_init)
  );

  const stored = await storageOf(page);
  check(
    `${label}: the browser client connects to the repository unaided`,
    stored.repo === `${OWNER}/${REPO}`,
    stored.repo
  );

  // The claim being tested is that someone who never wants the Evernote
  // import needs nothing but a browser. Connecting is not enough for that —
  // writing is.
  if (mobile) {
    await page.click('.nav-btn[data-tab="capture"]');
    await page.fill("#capture-area", "Bought milk on the way home.");
    await page.click("#btn-save");
  } else {
    await page.click("#btn-new-notebook");
    await page.fill("#modal-input", "Inbox");
    await page.click("#modal-confirm");
  }

  let committed = false;
  for (let attempt = 0; attempt < 40 && !committed; attempt++) {
    committed = gitHubRoute.written.size > 0;
    if (!committed) await page.waitForTimeout(250);
  }
  check(`${label}: a note written in the browser is committed to the repository`, committed,
    [...gitHubRoute.written.keys()].join(", "));

  if (committed) {
    const [path, file] = [...gitHubRoute.written.entries()][0];
    check(
      `${label}: the commit carries a message and lands on the default branch`,
      Boolean(file.message) && file.branch === "main",
      `${path} → "${file.message}" on ${file.branch}`
    );
    if (mobile) {
      check(
        `${label}: the captured text is what was committed`,
        decodeContent(file.content).includes("Bought milk on the way home."),
        decodeContent(file.content).split("\n")[0]
      );
    }
  }

  await context.close();
}

/** What the user sees when GitHub says no. */
async function failuresSurface(browser, base, mock, { mobile }) {
  const label = mobile ? "mobile" : "web";

  const denied = makeDeviceEndpoints({
    pollAnswers: [{ error: "access_denied", error_description: "The user denied the request." }],
  });
  let context = await newContext(browser, { mobile, devices: denied, gitHubRoute: makeGitHubRoute(mock) });
  let page = await context.newPage();
  await page.goto(mobile ? `${base}/mobile/` : base);
  await page.click(mobile ? "#btn-signin" : "#btn-github-signin-hero");
  const errorSelector = mobile ? "#si-error:not(.hidden)" : "#signin-error:not(.hidden)";
  let shown = await page
    .waitForSelector(errorSelector, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const message = shown
    ? (await page.textContent(mobile ? "#error-msg" : "#signin-error-detail")).trim()
    : "";
  check(
    `${label}: a denied authorization is reported, not left spinning`,
    shown && /denied/i.test(message),
    message
  );
  const afterDenial = await storageOf(page);
  check(`${label}: a denied authorization stores no token`, !afterDenial.token, afterDenial.token);
  await context.close();

  // The proxy failing (misconfigured GITHUB_CLIENT_ID) must not look like a
  // hung button either.
  const unconfigured = makeDeviceEndpoints({
    startStatus: 503,
    startBody: { error: "EverFree's GitHub OAuth App is not configured." },
    pollAnswers: [{ error: "authorization_pending" }],
  });
  context = await newContext(browser, { mobile, devices: unconfigured, gitHubRoute: makeGitHubRoute(mock) });
  page = await context.newPage();
  await page.goto(mobile ? `${base}/mobile/` : base);
  await page.click(mobile ? "#btn-signin" : "#btn-github-signin-hero");
  shown = await page
    .waitForSelector(errorSelector, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(`${label}: an unavailable device endpoint shows an error`, shown);
  await context.close();
}

// ══════════════════════════════════════════════════════════
(async () => {
  const { server, port } = await startStaticServer();
  const base = `http://127.0.0.1:${port}`;
  const fixture = buildFixture({ notebooks: 3, notesPerNotebook: 4 });
  const mock = createMockGitHub(fixture, { owner: OWNER, repo: REPO });
  const browser = await chromium.launch({ headless: !HEADED });

  try {
    for (const mobile of [false, true]) {
      console.log(`\n── ${mobile ? "mobile" : "web"} ──`);
      await signInAndLoadNotes(browser, base, mock, { mobile });
      await firstRunCreatesRepository(browser, base, mock, { mobile });
      await failuresSurface(browser, base, mock, { mobile });
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
