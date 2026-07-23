"use strict";

// Cold-start measurement harness for web/app.js.
//
// Loads the real web/index.html + app.js in headless Chromium against a
// modelled GitHub API (see mock-github.js), with a pre-seeded session, and
// records:
//
//   requests_to_paint   — GitHub API calls issued before the sidebar painted
//   time_to_paint_ms    — navigation start -> first note card in the DOM
//   time_to_settle_ms   — navigation start -> every note card title resolved
//   requests_total      — GitHub API calls issued over the whole run
//
// Third-party assets (Toast UI CDN, Google Fonts) are stubbed out so the
// numbers isolate the GitHub API cost. Their separate cost is reported by
// tests/perf/measure-assets.sh.
//
// Usage:
//   node tests/perf/measure.js --notebooks 12 --notes 21 --label before
//   node tests/perf/measure.js --scales           (runs the standard matrix)

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
  ".json": "application/json",
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

// Installed before any app code runs. Records paint marks against a page-side
// clock, and exposes them for the driver to read back.
const INSTRUMENT = `
window.__perf = { marks: {} };
function mark(name) {
  if (window.__perf.marks[name] === undefined) {
    window.__perf.marks[name] = performance.now();
  }
}
window.__perfMark = mark;
document.addEventListener('DOMContentLoaded', function () { mark('domcontentloaded'); });
new MutationObserver(function () {
  if (document.querySelector('#notebook-list .notebook-header')) mark('notebooks_painted');
  var cards = document.querySelectorAll('#note-browser-list .note-card');
  if (cards.length) mark('sidebar_painted');
  if (cards.length) {
    // A card is "resolved" once it shows its H1 title instead of the filename
    // placeholder it was created with.
    var resolved = function (c) {
      var t = c.querySelector('.note-card-title');
      return t && /^Title of /.test(t.textContent);
    };
    var onscreen = function (c) {
      var r = c.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    };
    // The number that matches what the user actually looks at: every card in
    // the viewport showing its real title.
    var vis = [].filter.call(cards, onscreen);
    if (vis.length && vis.every(resolved)) mark('visible_settled');
    if ([].every.call(cards, resolved)) mark('settled');
  }
// Observe document, not document.documentElement: this runs at document start,
// before <html> is parsed, so documentElement is still null there.
}).observe(document, { childList: true, subtree: true, characterData: true });
`;

const FIXTURE_EPOCH = 1750000000000; // pinned so cold/warm runs share blob SHAs

async function runOnce({ notebooks, notesPerNotebook, port, browser, quiet, storageState }) {
  const fixture = buildFixture({ notebooks, notesPerNotebook, now: FIXTURE_EPOCH });
  const mock = createMockGitHub(fixture, { owner: OWNER, repo: REPO });

  const context = await browser.newContext(storageState ? { storageState } : {});

  await context.addInitScript(INSTRUMENT);
  await context.addInitScript(
    ({ owner, repo }) => {
      localStorage.setItem("everfree-token", "gho_faketoken");
      localStorage.setItem("everfree-user", owner);
      localStorage.setItem("everfree-repo", `${owner}/${repo}`);
      localStorage.setItem("everfree-token-expires-at", String(Date.now() + 3600 * 1000));
    },
    { owner: OWNER, repo: REPO }
  );

  // Stub third-party assets: this run measures GitHub API cost only.
  await context.route("https://uicdn.toast.com/**", (route) => {
    const u = route.request().url();
    if (u.endsWith(".css")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "window.toastui={Editor:function(){this.getMarkdown=function(){return ''};this.setMarkdown=function(){};this.focus=function(){};this.on=function(){};}};",
    });
  });
  await context.route("https://fonts.googleapis.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/css", body: "" })
  );
  await context.route("https://fonts.gstatic.com/**", (r) => r.fulfill({ status: 200, body: "" }));

  // The modelled GitHub API.
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
  const navStart = Date.now();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });

  // Wait for the visible cards to settle, then for the network to go quiet.
  // Offscreen cards are loaded lazily and may never resolve by design, so
  // waiting on every card would hang rather than measure anything.
  const deadline = Date.now() + 120000;
  let marks = {};
  let lastCount = -1;
  let quietSince = null;
  while (Date.now() < deadline) {
    marks = await page.evaluate(() => window.__perf.marks);
    if (mock.counts.total !== lastCount) {
      lastCount = mock.counts.total;
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = Date.now();
    }
    const settledEnough = marks.visible_settled !== undefined || marks.settled !== undefined;
    if (settledEnough && quietSince !== null && Date.now() - quietSince > 1500) break;
    await page.waitForTimeout(100);
  }
  marks = await page.evaluate(() => window.__perf.marks);

  // Requests issued before the sidebar painted.
  const paintWall = marks.sidebar_painted !== undefined ? navStart + marks.sidebar_painted : Infinity;
  const toPaint = mock.log.filter((e) => e.t <= paintWall);
  const byKind = {};
  for (const e of toPaint) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

  const result = {
    notebooks,
    notesPerNotebook,
    totalNotes: fixture.totalNotes,
    time_to_paint_ms: marks.sidebar_painted !== undefined ? Math.round(marks.sidebar_painted) : null,
    time_to_visible_settle_ms: marks.visible_settled !== undefined ? Math.round(marks.visible_settled) : null,
    time_to_settle_ms: marks.settled !== undefined ? Math.round(marks.settled) : null,
    requests_to_paint: toPaint.length,
    requests_to_paint_by_kind: byKind,
    requests_total: mock.counts.total,
    requests_total_by_kind: { ...mock.counts },
  };

  result.storageState = await context.storageState();
  await context.close();
  if (!quiet) console.log(JSON.stringify(result, null, 2));
  return result;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}

const SCALES = [
  { notebooks: 6, notesPerNotebook: 9 }, // ~54 notes
  { notebooks: 12, notesPerNotebook: 21 }, // ~252 notes
  { notebooks: 20, notesPerNotebook: 30 }, // 600 notes
];

async function main() {
  const args = parseArgs(process.argv);
  const { server, port } = await startStaticServer();
  const browser = await chromium.launch();

  try {
    if (args.scales) {
      const repeat = Number(args.repeat || 3);
      const rows = [];
      const median = (xs) => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      for (const s of SCALES) {
        const runs = [];
        // --warm: prime one cold run first, then measure with its localStorage
        // restored, which is what a returning visitor actually experiences.
        let seed;
        if (args.warm) {
          seed = (await runOnce({ ...s, port, browser, quiet: true })).storageState;
        }
        for (let i = 0; i < repeat; i++) {
          runs.push(await runOnce({ ...s, port, browser, quiet: true, storageState: seed }));
        }
        // Request counts are deterministic; timings are medianed over `repeat`.
        const r = {
          ...runs[0],
          repeat,
          time_to_paint_ms: median(runs.map((x) => x.time_to_paint_ms)),
          time_to_visible_settle_ms: median(runs.map((x) => x.time_to_visible_settle_ms)),
          time_to_settle_ms: median(runs.map((x) => x.time_to_settle_ms)),
          paint_samples: runs.map((x) => x.time_to_paint_ms),
        };
        delete r.storageState;
        rows.push(r);
        console.log(
          `notes=${String(r.totalNotes).padStart(4)}  ` +
            `paint=${String(r.time_to_paint_ms).padStart(6)}ms  ` +
            `vis_settle=${String(r.time_to_visible_settle_ms).padStart(6)}ms  ` +
            `req_to_paint=${String(r.requests_to_paint).padStart(4)}  ` +
            `req_total=${String(r.requests_total).padStart(4)}`
        );
      }
      const label = typeof args.label === "string" ? args.label : "run";
      const outFile = path.join(__dirname, `results-${label}.json`);
      fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
      console.log(`\nwrote ${outFile}`);
    } else {
      await runOnce({
        notebooks: Number(args.notebooks || 12),
        notesPerNotebook: Number(args.notes || 21),
        port,
        browser,
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
