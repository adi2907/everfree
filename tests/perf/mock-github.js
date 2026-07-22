"use strict";

// Mock of the GitHub REST endpoints web/app.js touches during cold start.
//
// This is a MODEL, not the real API. Two things are modelled deliberately
// because they are what actually make EverFree's cold start slow:
//
//   1. Per-endpoint latency, taken from measurements against api.github.com
//      (see LATENCY_MS). `commits?path=` is the expensive one: GitHub has to
//      walk git history for that path, so it cannot be served from a cheap
//      cache the way a contents listing can.
//   2. A server-side concurrency ceiling. GitHub applies a secondary rate
//      limit at roughly 100 concurrent requests per token; past that,
//      requests queue (and in reality start returning 403). Firing 250
//      requests in parallel does NOT cost one round trip.
//
// Latency is deterministic per request path (seeded hash jitter) so repeated
// runs are comparable.

const LATENCY_MS = {
  repoMeta: 150,
  contentsDir: 160,
  contentsFile: 130,
  commitsPath: 260, // GET /commits?path=... — git log walk, the expensive one
  commitsBulk: 250, // GET /commits?per_page=100 — no path filter
  commitDetail: 180, // GET /commits/{sha} — the only endpoint carrying `files`
};

const JITTER_MS = 60;
const MAX_CONCURRENCY = 100;

// Deterministic per-key jitter so run N and run N+1 are comparable.
function hashJitter(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % (JITTER_MS * 2)) - JITTER_MS;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a fixture repo: notebooks each holding some notes, with commit dates.
 * Dates descend from `now` so recency sorting has something real to sort.
 */
// `shuffle` scrambles which note gets which commit date, so filename order and
// recency order deliberately disagree. Without it a fixture can pass an
// ordering check by accident, because "Note 001" is both alphabetically first
// and most recent.
function buildFixture({ notebooks: nbCount, notesPerNotebook, now = Date.now(), shuffle = false }) {
  const notebooks = [];
  const files = new Map(); // "Notebook/Note.md" -> {sha, content, committedAt}
  const commits = []; // newest first; one commit per note, mirroring real edits
  let seq = 0;

  for (let n = 0; n < nbCount; n++) {
    const nb = `Notebook ${String(n + 1).padStart(2, "0")}`;
    const notes = [];
    for (let m = 0; m < notesPerNotebook; m++) {
      const name = `Note ${String(m + 1).padStart(3, "0")}.md`;
      const path = `${nb}/${name}`;
      // Newest first overall; spread one hour apart.
      const committedAt = new Date(now - seq * 3600 * 1000).toISOString();
      files.set(path, {
        sha: `sha${String(seq).padStart(8, "0")}`,
        content: `# Title of ${name.replace(/\.md$/, "")}\n\nBody text for ${path}.\n`,
        committedAt,
      });
      commits.push({
        sha: `commit${String(seq).padStart(8, "0")}`,
        committedAt,
        filenames: [path],
      });
      notes.push(name);
      seq++;
    }
    notebooks.push({ name: nb, notes });
  }
  if (shuffle) {
    // Deterministic reassignment of dates across all notes (seeded LCG).
    const paths = [...files.keys()];
    const dates = paths.map((pp) => files.get(pp).committedAt);
    let seed = 987654321;
    for (let i = dates.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [dates[i], dates[j]] = [dates[j], dates[i]];
    }
    commits.length = 0;
    paths.forEach((pp, i) => {
      files.get(pp).committedAt = dates[i];
      commits.push({ sha: `commit${String(i).padStart(8, "0")}`, committedAt: dates[i], filenames: [pp] });
    });
  }
  commits.sort((a, b) => new Date(b.committedAt) - new Date(a.committedAt));
  const commitsBySha = new Map(commits.map((c) => [c.sha, c]));
  return { notebooks, files, commits, commitsBySha, totalNotes: seq };
}

/**
 * Creates a request handler + counters. `handle(url)` returns
 * {status, json} after simulating latency and queueing.
 */
function createMockGitHub(fixture, opts = {}) {
  const maxConcurrency = opts.maxConcurrency ?? MAX_CONCURRENCY;
  const owner = opts.owner || "testuser";
  const repo = opts.repo || "everfree-notes";
  const repoFull = `${owner}/${repo}`;

  const counts = {
    total: 0,
    repoMeta: 0,
    contentsDir: 0,
    contentsFile: 0,
    commitsPath: 0,
    commitsBulk: 0,
    commitDetail: 0,
    user: 0,
    other: 0,
  };
  const log = [];

  let inFlight = 0;
  const waiters = [];

  async function acquire() {
    if (inFlight < maxConcurrency) {
      inFlight++;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    inFlight++;
  }
  function release() {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  }

  function classify(u) {
    const path = u.pathname;
    if (path === "/user") return "user";
    if (path === `/repos/${repoFull}` || path === `/repos/${owner}/${repo}`) return "repoMeta";
    if (path.startsWith(`/repos/${repoFull}/commits`)) {
      const rest = path.slice(`/repos/${repoFull}/commits`.length).replace(/^\//, "");
      // A trailing SHA means the single-commit endpoint, which is the only one
      // that carries a `files` array. The list endpoint does not.
      if (rest) return "commitDetail";
      return u.searchParams.has("path") ? "commitsPath" : "commitsBulk";
    }
    if (path.startsWith(`/repos/${repoFull}/contents`)) {
      const rest = decodeURIComponent(path.slice(`/repos/${repoFull}/contents`.length).replace(/^\//, ""));
      return rest && rest.endsWith(".md") ? "contentsFile" : "contentsDir";
    }
    return "other";
  }

  function body(kind, u) {
    const path = u.pathname;
    if (kind === "user") return { status: 200, json: { login: owner } };
    if (kind === "repoMeta") {
      return {
        status: 200,
        json: { full_name: repoFull, private: true, default_branch: "main", id: 1 },
      };
    }
    if (kind === "commitsPath") {
      const p = u.searchParams.get("path");
      const f = fixture.files.get(p);
      if (!f) return { status: 200, json: [] };
      return {
        status: 200,
        json: [{ sha: f.sha, commit: { committer: { date: f.committedAt } } }],
      };
    }
    if (kind === "commitDetail") {
      const sha = path.slice(`/repos/${repoFull}/commits`.length).replace(/^\//, "");
      const c = fixture.commitsBySha.get(sha);
      if (!c) return { status: 404, json: { message: "Not Found" } };
      return {
        status: 200,
        json: {
          sha: c.sha,
          commit: { committer: { date: c.committedAt } },
          files: c.filenames.map((f) => ({ filename: f, status: "modified" })),
        },
      };
    }
    if (kind === "commitsBulk") {
      const perPage = Number(u.searchParams.get("per_page") || 30);
      const page = Number(u.searchParams.get("page") || 1);
      const slice = fixture.commits.slice((page - 1) * perPage, page * perPage);
      // Deliberately no `files` key: that matches the real list endpoint.
      return {
        status: 200,
        json: slice.map((c) => ({
          sha: c.sha,
          commit: { committer: { date: c.committedAt } },
        })),
      };
    }
    // contents
    const rest = decodeURIComponent(
      path.slice(`/repos/${repoFull}/contents`.length).replace(/^\//, "")
    );
    if (!rest) {
      return {
        status: 200,
        json: fixture.notebooks.map((nb) => ({ type: "dir", name: nb.name, path: nb.name })),
      };
    }
    const nb = fixture.notebooks.find((x) => x.name === rest);
    if (nb) {
      return {
        status: 200,
        json: nb.notes.map((name) => ({
          type: "file",
          name,
          path: `${rest}/${name}`,
          sha: fixture.files.get(`${rest}/${name}`).sha,
        })),
      };
    }
    const f = fixture.files.get(rest);
    if (f) {
      return {
        status: 200,
        json: {
          type: "file",
          name: rest.split("/").pop(),
          path: rest,
          sha: f.sha,
          content: Buffer.from(f.content, "utf8").toString("base64"),
          encoding: "base64",
        },
      };
    }
    return { status: 404, json: { message: "Not Found" } };
  }

  async function handle(urlString) {
    const u = new URL(urlString);
    const kind = classify(u);
    counts.total++;
    counts[kind]++;
    const started = Date.now();
    log.push({ kind, url: urlString, t: started });

    await acquire();
    try {
      const base = LATENCY_MS[kind] ?? 120;
      await sleep(Math.max(20, base + hashJitter(u.pathname + u.search)));
      return body(kind, u);
    } finally {
      release();
    }
  }

  return { handle, counts, log, repoFull, owner, repo };
}

module.exports = { buildFixture, createMockGitHub, LATENCY_MS, MAX_CONCURRENCY };
