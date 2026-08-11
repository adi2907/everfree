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
const LISTING_LAG_MS = 2500;
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
  // How far a directory listing lags a write. 0 disables it, for the perf
  // harness, which never writes and wants the cheapest possible model.
  const listingLagMs = opts.listingLagMs ?? LISTING_LAG_MS;

  const counts = {
    total: 0,
    repoMeta: 0,
    contentsDir: 0,
    contentsFile: 0,
    commitsPath: 0,
    commitsBulk: 0,
    commitDetail: 0,
    user: 0,
    contentsWrite: 0,
    gitData: 0,
    other: 0,
  };
  const log = [];

  // ── Mutable repo state ──────────────────────────────────────
  // Writes are modelled because create/delete are user-visible operations that
  // a read-only mock cannot check at all. Deletion of a whole notebook goes
  // through the Git Data API, whose defining property is that nothing changes
  // until the ref moves — so trees and commits are staged here, not applied,
  // and only PATCH /git/refs makes them real.
  let writeSeq = 0;
  const stagedTrees = new Map(); // tree sha -> [{path, sha, content}] edits vs base; sha null deletes
  const stagedBlobs = new Map(); // blob sha -> content, uploaded ahead of the tree that names it
  const stagedCommits = new Map(); // commit sha -> tree sha
  let headSha = "commithead0000";
  let headTreeSha = "tree00000000";

  function dirOf(p) {
    const i = p.indexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }

  // A directory listing is the one endpoint GitHub serves from a cheap cache,
  // and an authenticated response carries `cache-control: private, max-age=60`
  // on top of that — so a listing fetched just after a write can answer without
  // it, from the CDN or from the browser's own cache. A client that rebuilds its
  // state from that listing loses whatever it just created. The mutation log
  // below lets a listing be reconstructed as of `listingLagMs` ago; file reads
  // are not lagged, matching which endpoint the caching actually applies to.
  const mutations = []; // {t, add: bool, path, content}

  // `sha` is supplied when a tree write moves an existing blob. Git identifies a
  // blob by its content, so a move keeps the sha it had — and the client carries
  // its cached sha across to the new path, so minting a fresh one here would
  // fail the very next write to the renamed note for a reason GitHub would not.
  function addFile(p, content, sha) {
    mutations.push({ t: Date.now(), add: true, path: p, content });
    const nbName = dirOf(p);
    const name = p.slice(nbName.length + 1);
    fixture.files.set(p, {
      sha: sha || `shaw${String(writeSeq++).padStart(7, "0")}`,
      content,
      committedAt: new Date().toISOString(),
    });
    let nb = fixture.notebooks.find((x) => x.name === nbName);
    if (!nb) {
      nb = { name: nbName, notes: [] };
      fixture.notebooks.push(nb);
    }
    if (!nb.notes.includes(name)) nb.notes.push(name);
    return fixture.files.get(p);
  }

  function removeFile(p) {
    mutations.push({ t: Date.now(), add: false, path: p });
    fixture.files.delete(p);
    const nbName = dirOf(p);
    const name = p.slice(nbName.length + 1);
    const nb = fixture.notebooks.find((x) => x.name === nbName);
    if (!nb) return;
    nb.notes = nb.notes.filter((n) => n !== name);
    // Git has no empty directories: a folder disappears with its last blob.
    if (nb.notes.length === 0) {
      fixture.notebooks = fixture.notebooks.filter((x) => x.name !== nbName);
    }
  }

  // The set of paths a listing should show right now: current state with every
  // mutation newer than the lag window undone, newest first.
  function laggedPaths() {
    const paths = new Set(fixture.files.keys());
    if (!listingLagMs) return paths;
    const cutoff = Date.now() - listingLagMs;
    for (let i = mutations.length - 1; i >= 0; i--) {
      const m = mutations[i];
      if (m.t <= cutoff) break;
      if (m.add) paths.delete(m.path);
      else paths.add(m.path);
    }
    return paths;
  }

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

  function classify(u, method) {
    const path = u.pathname;
    if (path === "/user") return "user";
    if (path === `/repos/${repoFull}` || path === `/repos/${owner}/${repo}`) return "repoMeta";
    if (path.startsWith(`/repos/${repoFull}/git/`)) return "gitData";
    if (path.startsWith(`/repos/${repoFull}/contents`) && method !== "GET") return "contentsWrite";
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

  function body(kind, u, method, req) {
    const path = u.pathname;
    if (kind === "user") return { status: 200, json: { login: owner } };

    if (kind === "contentsWrite") {
      const target = decodeURIComponent(
        path.slice(`/repos/${repoFull}/contents`.length).replace(/^\//, "")
      );
      if (method === "PUT") {
        const existing = fixture.files.get(target);
        // GitHub rejects a write to an existing path that omits the current sha,
        // and one that names a stale sha. Both are how a client finds out it is
        // clobbering someone else's edit, so the mock enforces them.
        if (existing && req.sha !== existing.sha) {
          return { status: 409, json: { message: "sha does not match" } };
        }
        if (!existing && req.sha) {
          return { status: 422, json: { message: "sha given for a new file" } };
        }
        const content = Buffer.from(req.content || "", "base64").toString("utf8");
        const file = addFile(target, content);
        return {
          status: existing ? 200 : 201,
          json: { content: { path: target, sha: file.sha }, commit: { sha: `commitw${writeSeq}` } },
        };
      }
      if (method === "DELETE") {
        const existing = fixture.files.get(target);
        if (!existing) return { status: 404, json: { message: "Not Found" } };
        if (req.sha !== existing.sha) return { status: 409, json: { message: "sha does not match" } };
        removeFile(target);
        return { status: 200, json: { commit: { sha: `commitw${writeSeq++}` } } };
      }
      return { status: 405, json: { message: "Method not allowed" } };
    }

    if (kind === "gitData") {
      const rest = decodeURIComponent(path.slice(`/repos/${repoFull}/git/`.length));
      if (method === "GET" && rest.startsWith("ref/heads/")) {
        return { status: 200, json: { ref: `refs/${rest}`, object: { sha: headSha } } };
      }
      if (method === "GET" && rest.startsWith("commits/")) {
        return { status: 200, json: { sha: headSha, tree: { sha: headTreeSha } } };
      }
      if (method === "GET" && rest.startsWith("trees/")) {
        return {
          status: 200,
          json: {
            sha: headTreeSha,
            // Real trees list directories too; the client has to filter to
            // blobs, so the mock gives it directories to filter out.
            tree: [
              ...fixture.notebooks.map((nb) => ({
                path: nb.name, mode: "040000", type: "tree", sha: `tree${nb.name}`,
              })),
              ...[...fixture.files.entries()].map(([p, f]) => ({
                path: p, mode: "100644", type: "blob", sha: f.sha,
              })),
            ],
          },
        };
      }
      // A rename that also rewrites the note's heading needs a blob that no
      // path holds yet, so it is uploaded on its own and the tree names the sha
      // that came back. Like a tree, it changes nothing until the ref moves.
      if (method === "POST" && rest === "blobs") {
        const sha = `blobw${writeSeq++}`;
        const raw = req.encoding === "base64"
          ? Buffer.from(req.content || "", "base64").toString("utf8")
          : String(req.content || "");
        stagedBlobs.set(sha, raw);
        return { status: 201, json: { sha } };
      }
      if (method === "POST" && rest === "trees") {
        const bad = (req.tree || []).find((e) => e.sha === null && e.type !== "blob");
        // GitHub rejects a null sha on a tree entry. Getting this wrong is the
        // most likely way a recursive delete breaks, so the mock refuses it too.
        if (bad) return { status: 422, json: { message: "cannot null a tree entry" } };
        // Entries apply in order against the base tree, which is what lets a
        // rename drop a path and add another in one request. An add names a blob
        // by sha and carries no content of its own — the point of a move — so
        // the mock resolves it against a blob the repo holds or one just
        // uploaded, and refuses any other sha rather than inventing a file.
        const edits = [];
        for (const entry of req.tree || []) {
          if (entry.sha === null) { edits.push({ path: entry.path, sha: null }); continue; }
          const content = stagedBlobs.has(entry.sha)
            ? stagedBlobs.get(entry.sha)
            : ([...fixture.files.values()].find((f) => f.sha === entry.sha) || {}).content;
          if (content === undefined) {
            return { status: 422, json: { message: `unknown blob sha ${entry.sha}` } };
          }
          edits.push({ path: entry.path, sha: entry.sha, content });
        }
        const sha = `treew${writeSeq++}`;
        stagedTrees.set(sha, edits);
        return { status: 201, json: { sha } };
      }
      if (method === "POST" && rest === "commits") {
        const sha = `commitw${writeSeq++}`;
        stagedCommits.set(sha, req.tree);
        return { status: 201, json: { sha } };
      }
      if (method === "PATCH" && rest.startsWith("refs/heads/")) {
        const treeSha = stagedCommits.get(req.sha);
        if (treeSha === undefined) return { status: 422, json: { message: "unknown commit" } };
        for (const edit of stagedTrees.get(treeSha) || []) {
          if (edit.sha === null) removeFile(edit.path);
          else addFile(edit.path, edit.content, edit.sha);
        }
        headSha = req.sha;
        headTreeSha = treeSha;
        return { status: 200, json: { object: { sha: headSha } } };
      }
      return { status: 404, json: { message: "Not Found" } };
    }

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
    const visible = laggedPaths();
    if (!rest) {
      const dirs = [];
      for (const p of visible) {
        const d = dirOf(p);
        if (d && !dirs.includes(d)) dirs.push(d);
      }
      return {
        status: 200,
        json: dirs.map((name) => ({ type: "dir", name, path: name })),
      };
    }
    const nbNotes = [...visible]
      .filter((p) => dirOf(p) === rest)
      .map((p) => p.slice(rest.length + 1));
    if (nbNotes.length) {
      return {
        status: 200,
        json: nbNotes.map((name) => ({
          type: "file",
          name,
          path: `${rest}/${name}`,
          // A path can be visible in the lagged listing after its blob is gone.
          sha: (fixture.files.get(`${rest}/${name}`) || { sha: "shastale000" }).sha,
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

  async function handle(urlString, method = "GET", requestBody = null) {
    const u = new URL(urlString);
    const kind = classify(u, method);
    counts.total++;
    counts[kind]++;
    const started = Date.now();
    log.push({ kind, method, url: urlString, t: started });

    let req = null;
    if (requestBody) {
      try { req = JSON.parse(requestBody); } catch { req = null; }
    }

    await acquire();
    try {
      const base = LATENCY_MS[kind] ?? 120;
      await sleep(Math.max(20, base + hashJitter(u.pathname + u.search)));
      return body(kind, u, method, req || {});
    } finally {
      release();
    }
  }

  // Snapshot of what the repo actually holds, for assertions after a write.
  function state() {
    const byNotebook = {};
    for (const p of fixture.files.keys()) {
      const nb = dirOf(p);
      (byNotebook[nb] ||= []).push(p.slice(nb.length + 1));
    }
    for (const nb of Object.keys(byNotebook)) byNotebook[nb].sort();
    return byNotebook;
  }

  // What a path actually holds, for assertions about content a write rewrote.
  function contentAt(p) {
    const f = fixture.files.get(p);
    return f ? f.content : undefined;
  }

  return { handle, counts, log, repoFull, owner, repo, state, contentAt };
}

module.exports = { buildFixture, createMockGitHub, LATENCY_MS, MAX_CONCURRENCY };
