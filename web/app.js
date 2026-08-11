/* ════════════════════════════════════════════════════════════
   EverFree — Web Client (GitHub-backed)
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    // ── Storage Keys ────────────────────────────────────────
    const AUTH_TOKEN_KEY = "everfree-token";
    const AUTH_USER_KEY = "everfree-user";
    const AUTH_REPO_KEY = "everfree-repo";
    const AUTH_EXPIRES_KEY = "everfree-token-expires-at";
    const LS_THEME = "everfree-theme";
    const LS_LIGHT_THEME_MIGRATED = "everfree-light-theme-migrated";
    const LS_SIDEBAR_WIDTH = "everfree-sidebar-width";
    const LS_NOTE_BROWSER_WIDTH = "everfree-note-browser-width";
    // Note metadata (modified time + display title) keyed by Git blob SHA.
    const LS_NOTE_META = "everfree-note-meta-v1";
    // Owned by assistant.js, cleared here: sign-out lives in this file.
    const ASSISTANT_KEYS = ["everfree-gemini-key", "everfree-openrouter-key"];
    const DEFAULT_REPO = "everfree-notes";

    // A session lasts until the user signs out, so authentication data is stored
    // durably rather than per tab. See ADR 0001: this trades XSS exposure of a
    // resting token for not re-running the device flow on every browser start.
    // Aliased so the store is one line to change if that trade is revisited.
    const authStore = localStorage;

    // ── State ───────────────────────────────────────────────
    let token = authStore.getItem(AUTH_TOKEN_KEY) || null;
    let user = authStore.getItem(AUTH_USER_KEY) || null;
    let repoFull = authStore.getItem(AUTH_REPO_KEY) || null; // "owner/everfree-notes"
    // 0 means "no expiry advertised", not "expired". EverFree's OAuth App issues
    // non-expiring gho_ tokens, so GitHub omits expires_in from the device-flow
    // response; a stored "NaN" from before that was handled must read as 0.
    let tokenExpiresAt = Number(authStore.getItem(AUTH_EXPIRES_KEY)) || 0;
    let defaultBranch = "main";

    let notebooks = [];
    let notesByNotebook = {}; // notebook -> [{name, sha}]
    let fileShas = {}; // "notebook/note.md" -> sha
    let noteContentCache = {}; // "notebook/note.md" -> markdown
    let noteTitleCache = {}; // "notebook/note.md" -> display title (this session)
    let currentNotebook = null;
    let currentNote = null;
    let selectedNotebook = null; // notebook filter for the note browser (null = All notes)
    let editor = null;
    let assetUrlCache = {}; // note-relative image path -> blob: object URL (open note only)
    let editorDictation = null;
    let isDirty = false;
    let searchSeq = 0;
    let noteBrowserRenderSeq = 0;
    const NOTE_CARD_BATCH_SIZE = 100;

    let devicePollTimer = null;

    // Cold-start tuning. The sidebar used to block on one
    // `GET /commits?path=…` per note, so first paint scaled linearly with the
    // note count. Recency now comes from a fixed number of requests instead:
    // one page of commits, then the newest RECENCY_COMMIT_DETAIL of them
    // expanded to their touched paths. Notes older than that window keep the
    // filename-date/alphabetical fallback, or a cached time from a past visit.
    // 60 is measured rather than guessed: against a fixture whose filename order
    // and edit order deliberately disagree, a 30-commit window placed only 7 of
    // the true 10 most-recent notes in the top 10, while 60 placed all 10.
    // Raising it to 100 only reordered notes further down the list.
    // See tests/perf/dump-order.js --shuffle.
    const RECENCY_COMMIT_PAGE = 100;   // commits listed in one request
    const RECENCY_COMMIT_DETAIL = 60;  // commits expanded for their file lists
    // GitHub's secondary rate limit kicks in near 100 concurrent requests per
    // token, so stay well under it while still keeping the pipe busy.
    const API_POOL_LIMIT = 24;         // concurrent background GitHub requests
    const META_CACHE_MAX = 5000;       // blob-SHA entries kept in localStorage

    // ── Note metadata cache (blob-SHA keyed) ────────────────
    // A Git blob SHA is a hash of content, so an entry can never go stale: if a
    // note changes, its SHA changes and the old entry is simply never looked up
    // again. That makes this cache safe to persist with no invalidation logic.
    let noteMeta = {}; // blobSha -> { t: modifiedMs, ti: title }
    let noteMetaDirty = false;

    function loadNoteMeta() {
        try {
            const raw = localStorage.getItem(LS_NOTE_META);
            noteMeta = raw ? JSON.parse(raw) : {};
            if (!noteMeta || typeof noteMeta !== "object") noteMeta = {};
        } catch {
            noteMeta = {};
        }
    }

    function persistNoteMeta() {
        if (!noteMetaDirty) return;
        noteMetaDirty = false;
        try {
            const keys = Object.keys(noteMeta);
            if (keys.length > META_CACHE_MAX) {
                // Drop the oldest-modified entries first; they are the ones
                // least likely to be near the top of a recency-sorted list.
                keys.sort((a, b) => (noteMeta[b].t || 0) - (noteMeta[a].t || 0));
                const trimmed = {};
                for (const k of keys.slice(0, META_CACHE_MAX)) trimmed[k] = noteMeta[k];
                noteMeta = trimmed;
            }
            localStorage.setItem(LS_NOTE_META, JSON.stringify(noteMeta));
        } catch {
            // Quota or private-mode failure: the cache is an optimisation only.
        }
    }

    function metaFor(path) {
        const sha = fileShas[path];
        return sha ? noteMeta[sha] : undefined;
    }

    function setMeta(path, patch) {
        const sha = fileShas[path];
        if (!sha) return;
        const prev = noteMeta[sha] || {};
        const next = { ...prev, ...patch };
        if (prev.t === next.t && prev.ti === next.ti) return;
        noteMeta[sha] = next;
        noteMetaDirty = true;
    }

    // Runs `fn` over `items` with at most `limit` in flight. Unbounded
    // Promise.all over every note is what tripped GitHub's secondary rate
    // limit (~100 concurrent) and starved the connection pool.
    async function pooled(items, limit, fn) {
        const queue = [...items];
        const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
            while (queue.length) {
                const item = queue.shift();
                try { await fn(item); } catch { /* per-item failure is non-fatal */ }
            }
        });
        await Promise.all(workers);
    }

    // ── DOM ─────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const viewSignin = $("view-signin");
    const viewApp = $("view-app");

    const signinIdle = $("signin-idle");
    const signinPending = $("signin-pending");
    const signinError = $("signin-error");

    // ── View Routing ────────────────────────────────────────
    function showView(name) {
        viewSignin.classList.add("hidden");
        viewApp.classList.add("hidden");
        if (name === "signin") viewSignin.classList.remove("hidden");
        else if (name === "app") viewApp.classList.remove("hidden");
    }

    // ── GitHub Device Flow ──────────────────────────────────
    async function startDeviceFlow() {
        signinIdle.classList.add("hidden");
        signinError.classList.add("hidden");
        signinPending.classList.remove("hidden");

        try {
            const r = await fetch("/api/github/device-start", { method: "POST" });
            const data = await r.json();
            if (!r.ok || data.error) throw new Error(data.error_description || data.error || "Failed to start device flow");

            $("signin-user-code").textContent = data.user_code;
            $("signin-verification-uri").href = data.verification_uri;
            $("signin-verification-uri").textContent = data.verification_uri.replace(/^https?:\/\//, "");

            pollDeviceFlow(data.device_code, data.interval || 5);
        } catch (err) {
            showSigninError(err.message);
        }
    }

    function pollDeviceFlow(deviceCode, intervalSec) {
        let interval = intervalSec * 1000;
        const tick = async () => {
            try {
                const r = await fetch("/api/github/device-poll", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ device_code: deviceCode }),
                });
                const data = await r.json();

                if (data.error === "authorization_pending") {
                    devicePollTimer = setTimeout(tick, interval);
                    return;
                }
                if (data.error === "slow_down") {
                    interval += 5000;
                    devicePollTimer = setTimeout(tick, interval);
                    return;
                }
                if (data.error) {
                    throw new Error(data.error_description || data.error);
                }

                if (data.access_token) {
                    token = data.access_token;
                    tokenExpiresAt = expiryFromResponse(data);
                    authStore.setItem(AUTH_TOKEN_KEY, token);
                    authStore.setItem(AUTH_EXPIRES_KEY, String(tokenExpiresAt));
                    await fetchUserAndProceed();
                }
            } catch (err) {
                showSigninError(err.message);
            }
        };
        devicePollTimer = setTimeout(tick, interval);
    }

    // Returns an absolute expiry, or 0 when GitHub advertises none.
    function expiryFromResponse(data) {
        const seconds = Number(data.expires_in);
        return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : 0;
    }

    function showSigninError(msg) {
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        signinIdle.classList.add("hidden");
        signinPending.classList.add("hidden");
        signinError.classList.remove("hidden");
        $("signin-error-detail").textContent = msg;
    }

    async function fetchUserAndProceed() {
        try {
            const me = await gh("GET", "/user");
            user = me.login;
            authStore.setItem(AUTH_USER_KEY, user);
            await autoConnectRepo();
        } catch (err) {
            showSigninError("Failed to fetch GitHub profile: " + err.message);
        }
    }

    async function autoConnectRepo() {
        try {
            const repo = await gh("GET", `/repos/${user}/${DEFAULT_REPO}`);
            rememberRepo(repo);
            await enterApp(repo);
            return;
        } catch (err) {
            if (!isNotFoundError(err)) throw err;
        }
        await createAndEnterDefaultRepo();
    }

    async function createAndEnterDefaultRepo() {
        try {
            const repo = await gh("POST", "/user/repos", {
                name: DEFAULT_REPO,
                private: true,
                description: "EverFree — Git-backed Markdown notes",
                auto_init: true,
            });
            rememberRepo(repo);
            await enterApp(repo);
        } catch (err) {
            if (err.status === 422) {
                const repo = await gh("GET", `/repos/${user}/${DEFAULT_REPO}`);
                rememberRepo(repo);
                await enterApp(repo);
                return;
            }
            throw err;
        }
    }

    function rememberRepo(repo) {
        const expected = `${user}/${DEFAULT_REPO}`.toLowerCase();
        if (String(repo.full_name || "").toLowerCase() !== expected) {
            throw new Error(`EverFree only supports ${user}/${DEFAULT_REPO}.`);
        }
        if (!repo.private) {
            throw new Error(`${user}/${DEFAULT_REPO} must be private before EverFree can use it.`);
        }
        if (repoFull && repoFull !== repo.full_name) {
            resetRepoData();
        }
        repoFull = repo.full_name;
        defaultBranch = repo.default_branch || "main";
        authStore.setItem(AUTH_REPO_KEY, repoFull);
    }

    function clearRememberedRepo() {
        repoFull = null;
        defaultBranch = "main";
        authStore.removeItem(AUTH_REPO_KEY);
        resetRepoData();
    }

    function resetRepoData() {
        notebooks = [];
        notesByNotebook = {};
        fileShas = {};
        noteContentCache = {};
        noteTitleCache = {};
        currentNotebook = null;
        currentNote = null;
    }

    function isNotFoundError(err) {
        return /404|Not Found/i.test(err && err.message ? err.message : String(err));
    }

    // ── GitHub API Wrapper ──────────────────────────────────
    async function gh(method, path, body) {
        const url = path.startsWith("http") ? path : "https://api.github.com" + path;
        const opts = {
            method,
            // GitHub sends `cache-control: private, max-age=60` on authenticated
            // reads, so the default fetch policy will answer a contents listing
            // from the browser cache for a minute after the previous one — long
            // enough to hide a note the user just wrote. "no-cache" revalidates
            // instead of skipping the network; GitHub answers 304 when nothing
            // changed, and a 304 costs no rate limit.
            cache: "no-cache",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        };
        if (body !== undefined) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        if (r.status === 401) {
            signOut();
            throw new Error("Session expired. Please sign in again.");
        }
        if (r.status === 204) return null;
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            const error = new Error(data.message || `${method} ${path}: ${r.status}`);
            error.status = r.status;
            throw error;
        }
        return data;
    }

    // ── Sign Out ────────────────────────────────────────────
    function signOut() {
        token = null;
        user = null;
        repoFull = null;
        tokenExpiresAt = 0;
        // sessionStorage is cleared too: builds between 5759c38 and this one kept
        // auth there, and a tab open across the upgrade would still hold a token.
        for (const key of [AUTH_TOKEN_KEY, AUTH_USER_KEY, AUTH_REPO_KEY, AUTH_EXPIRES_KEY]) {
            authStore.removeItem(key);
            sessionStorage.removeItem(key);
        }
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        // The assistant's API keys live in localStorage too (ADR 0001), so an
        // explicit sign-out has to take them with it — otherwise they outlive
        // the session that created them on a shared machine. Both stores are
        // swept for the same upgrade reason as the auth keys above.
        for (const key of ASSISTANT_KEYS) {
            localStorage.removeItem(key);
            sessionStorage.removeItem(key);
        }
        // Cached note titles are not credentials, but they are the user's
        // content and should not outlive an explicit sign-out on a shared
        // machine. Signing back in re-derives them.
        noteMeta = {};
        noteMetaDirty = false;
        try { localStorage.removeItem(LS_NOTE_META); } catch { /* nothing to clear */ }
        resetRepoData();
        signinIdle.classList.remove("hidden");
        signinPending.classList.add("hidden");
        signinError.classList.add("hidden");
        showView("signin");
    }

    // ── Enter App ───────────────────────────────────────────
    // `knownRepo` is the repository object the caller already fetched and put
    // through rememberRepo (which enforces the fixed owner/name and the private
    // requirement). Re-fetching it here was a wasted serial round trip on the
    // critical path. When it is absent — a restored session, where nothing has
    // been validated yet — the fetch still happens.
    async function enterApp(knownRepo) {
        if (String(repoFull).toLowerCase() !== `${user}/${DEFAULT_REPO}`.toLowerCase()) {
            clearRememberedRepo();
            throw new Error(`EverFree only supports ${user}/${DEFAULT_REPO}.`);
        }
        showView("app");
        try {
            if (!knownRepo) {
                const repoMeta = await gh("GET", `/repos/${repoFull}`);
                rememberRepo(repoMeta);
            }
            setSyncStatus("ok", `${repoFull}`);
            await loadNotebooks();
        } catch (err) {
            if (isNotFoundError(err) && repoFull) {
                clearRememberedRepo();
                await autoConnectRepo();
                return;
            }
            setSyncStatus("error", "Failed to load repo");
            console.error(err);
        }
    }

    // ── Contents API ────────────────────────────────────────
    async function listContents(path = "") {
        try {
            const data = await gh("GET", `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
            return Array.isArray(data) ? data : [data];
        } catch (err) {
            if (/404/.test(err.message) || /Not Found/i.test(err.message)) return [];
            throw err;
        }
    }

    async function getFile(path) {
        const data = await gh("GET", `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
        const content = b64DecodeUnicode(data.content.replace(/\n/g, ""));
        fileShas[path] = data.sha;
        noteContentCache[path] = content;
        return { content, sha: data.sha };
    }

    async function putFile(path, content, message) {
        const body = {
            message: message || `Update ${path}`,
            content: b64EncodeUnicode(content),
            branch: defaultBranch,
        };
        if (fileShas[path]) body.sha = fileShas[path];
        const data = await gh("PUT", `/repos/${repoFull}/contents/${encodeURI(path)}`, body);
        if (data && data.content) fileShas[path] = data.content.sha;
        noteContentCache[path] = content;
        // fileShas now holds the new blob SHA, so this records the save against
        // the version that was just written.
        setMeta(path, { t: Date.now(), ti: getNoteTitle(content, path.split("/").pop()) });
        persistNoteMeta();
        return data;
    }

    async function deleteFile(path, message) {
        const sha = fileShas[path];
        if (!sha) {
            // Fetch sha first
            const f = await gh("GET", `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
            fileShas[path] = f.sha;
        }
        await gh("DELETE", `/repos/${repoFull}/contents/${encodeURI(path)}`, {
            message: message || `Delete ${path}`,
            sha: fileShas[path],
            branch: defaultBranch,
        });
        if (fileShas[path]) delete noteMeta[fileShas[path]];
        noteMetaDirty = true;
        persistNoteMeta();
        delete fileShas[path];
        delete noteContentCache[path];
    }

    // Delete a whole folder in one commit. The Contents API deletes one file per
    // request and has no recursive form, so a notebook with N notes would be N
    // commits and would leave a half-deleted folder behind if any of them failed.
    // The Git Data API builds a single tree with those paths removed instead, so
    // the notebook disappears atomically and costs the same six requests whether
    // it holds two notes or two hundred.
    async function deleteFolder(prefix, message) {
        const ref = await gh("GET", `/repos/${repoFull}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        const head = ref.object.sha;
        const commit = await gh("GET", `/repos/${repoFull}/git/commits/${head}`);
        const tree = await gh("GET", `/repos/${repoFull}/git/trees/${commit.tree.sha}?recursive=1`);

        // Blobs only. Naming a tree with sha:null makes GitHub reject the write,
        // and removing every blob under the folder removes the folder with them —
        // Git has no empty directories.
        const doomed = (tree.tree || []).filter(
            (entry) => entry.type === "blob" && entry.path.startsWith(prefix + "/"));
        if (!doomed.length) return;

        const newTree = await gh("POST", `/repos/${repoFull}/git/trees`, {
            base_tree: commit.tree.sha,
            tree: doomed.map((entry) => ({
                path: entry.path,
                mode: entry.mode,
                type: "blob",
                sha: null,
            })),
        });
        const newCommit = await gh("POST", `/repos/${repoFull}/git/commits`, {
            message: message || `Delete ${prefix}`,
            tree: newTree.sha,
            parents: [head],
        });
        await gh("PATCH", `/repos/${repoFull}/git/refs/heads/${encodeURIComponent(defaultBranch)}`, {
            sha: newCommit.sha,
        });

        for (const entry of doomed) {
            if (fileShas[entry.path]) delete noteMeta[fileShas[entry.path]];
            delete fileShas[entry.path];
            delete noteContentCache[entry.path];
            delete noteTitleCache[entry.path];
        }
        noteMetaDirty = true;
        persistNoteMeta();
    }

    // Move blobs to new paths in one commit, and return how many moved. The
    // Contents API has no rename: a move would be a create plus a delete, which
    // is two commits and leaves the note in both places — or in neither — if the
    // second one fails. One tree write reuses the existing blob SHAs, so nothing
    // is re-uploaded and renaming a notebook costs the same six requests whether
    // it holds two notes or two hundred. `rewrite` returns a blob's new path, or
    // `{to, content}` to rewrite it on the way, or null to leave it where it is.
    //
    // A rewritten blob is a new object, so it is uploaded first and the tree
    // names the sha that came back. The sha cannot be read off the create-tree
    // response instead: that lists the root tree, and a note lives one level
    // down inside its notebook.
    async function movePaths(rewrite, message) {
        const ref = await gh("GET", `/repos/${repoFull}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        const head = ref.object.sha;
        const commit = await gh("GET", `/repos/${repoFull}/git/commits/${head}`);
        const tree = await gh("GET", `/repos/${repoFull}/git/trees/${commit.tree.sha}?recursive=1`);

        const moves = [];
        for (const entry of tree.tree || []) {
            if (entry.type !== "blob") continue;
            const target = rewrite(entry.path);
            if (!target) continue;
            const { to, content } = typeof target === "string" ? { to: target } : target;
            if (to === entry.path && content === undefined) continue;
            moves.push({ from: entry.path, to, content, mode: entry.mode, sha: entry.sha });
        }
        if (!moves.length) return 0;

        for (const move of moves) {
            if (move.content === undefined) continue;
            const blob = await gh("POST", `/repos/${repoFull}/git/blobs`, {
                content: b64EncodeUnicode(move.content),
                encoding: "base64",
            });
            move.sha = blob.sha;
        }

        // Drops before adds. Both orders work here because a rename never lands
        // on a path it also vacates, but reading it this way keeps it obvious
        // that the old paths are gone rather than copied.
        const newTree = await gh("POST", `/repos/${repoFull}/git/trees`, {
            base_tree: commit.tree.sha,
            tree: [
                ...moves.map((m) => ({ path: m.from, mode: m.mode, type: "blob", sha: null })),
                ...moves.map((m) => ({ path: m.to, mode: m.mode, type: "blob", sha: m.sha })),
            ],
        });
        const newCommit = await gh("POST", `/repos/${repoFull}/git/commits`, {
            message: message || `Move ${moves.length} file(s)`,
            tree: newTree.sha,
            parents: [head],
        });
        await gh("PATCH", `/repos/${repoFull}/git/refs/heads/${encodeURIComponent(defaultBranch)}`, {
            sha: newCommit.sha,
        });

        // The caches are keyed by path, so carry each entry across to its new
        // one rather than dropping it. noteMeta is keyed by blob SHA, which a
        // plain move leaves untouched, so the recorded save times survive on
        // their own; a rewritten blob gets a new SHA, so its entry is dropped
        // and the caller records the save against the version it just wrote.
        for (const m of moves) {
            const oldSha = fileShas[m.from];
            if (m.from in fileShas) { fileShas[m.to] = fileShas[m.from]; delete fileShas[m.from]; }
            if (m.from in noteContentCache) { noteContentCache[m.to] = noteContentCache[m.from]; delete noteContentCache[m.from]; }
            if (m.from in noteTitleCache) { noteTitleCache[m.to] = noteTitleCache[m.from]; delete noteTitleCache[m.from]; }
            if (m.content === undefined) continue;
            fileShas[m.to] = m.sha;
            noteContentCache[m.to] = m.content;
            if (oldSha && oldSha !== m.sha) { delete noteMeta[oldSha]; noteMetaDirty = true; }
        }
        persistNoteMeta();
        return moves.length;
    }

    // ── Base64 (UTF-8 safe) ─────────────────────────────────
    function b64EncodeUnicode(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }
    function b64DecodeUnicode(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    function parseNoteNameDate(name) {
        const clean = name.replace(/\.md$/, '').replace(/_/g, ' ').trim();
        const match = clean.match(/^(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
        if (!match) return null;
        
        const day = parseInt(match[1], 10);
        const monthStr = match[2].toLowerCase();
        const year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();
        
        const months = {
            jan: 0, january: 0,
            feb: 1, february: 1,
            mar: 2, march: 2,
            apr: 3, april: 3,
            may: 4,
            jun: 5, june: 5,
            jul: 6, july: 6,
            aug: 7, august: 7,
            sep: 8, september: 8,
            oct: 9, october: 9,
            nov: 10, november: 10,
            dec: 11, december: 11
        };
        
        const month = months[monthStr.substring(0, 3)];
        if (month === undefined) return null;
        
        return new Date(year, month, day).getTime();
    }

    // Sort key for a note: cached/hydrated modified time, else a date parsed
    // out of the filename, else alphabetical. Extracted so the initial paint
    // and the post-hydration re-sort cannot drift apart.
    function noteSortComparator(nb) {
        return (a, b) => {
            const timeA = (metaFor(`${nb}/${a}`) || {}).t || 0;
            const timeB = (metaFor(`${nb}/${b}`) || {}).t || 0;
            if (timeA !== timeB) return timeB - timeA;

            const dateA = parseNoteNameDate(a);
            const dateB = parseNoteNameDate(b);
            if (dateA !== null && dateB !== null) return dateB - dateA;
            if (dateA !== null) return -1;
            if (dateB !== null) return 1;

            return a.localeCompare(b);
        };
    }

    function sortLoadedNotes() {
        for (const nb of notebooks) {
            (notesByNotebook[nb] || []).sort(noteSortComparator(nb));
        }
        notebooks.sort((a, b) => {
            const newestA = (notesByNotebook[a] || [])[0];
            const newestB = (notesByNotebook[b] || [])[0];

            // An empty notebook has just been created — nothing else produces
            // one — so it belongs at the top, not below every notebook that has
            // a dated note. The desktop server orders them the same way, by the
            // folder's own mtime.
            if (!newestA !== !newestB) return newestA ? 1 : -1;
            if (!newestA && !newestB) return a.localeCompare(b);

            const timeA = (metaFor(`${a}/${newestA}`) || {}).t || 0;
            const timeB = (metaFor(`${b}/${newestB}`) || {}).t || 0;
            if (timeA !== timeB) return timeB - timeA;

            const dateA = parseNoteNameDate(newestA);
            const dateB = parseNoteNameDate(newestB);
            if (dateA !== null && dateB !== null) return dateB - dateA;
            if (dateA !== null) return -1;
            if (dateB !== null) return 1;

            return a.localeCompare(b);
        });
    }

    // ── Load Notebooks ──────────────────────────────────────
    // Two phases. Phase one lists the repo (1 + N requests for N notebooks),
    // paints immediately using cached/fallback ordering, and returns. Phase two
    // hydrates real modified times in the background and re-sorts. First paint
    // no longer waits on anything that scales with the note count.
    async function loadNotebooks() {
        try {
            setSyncStatus("syncing", "Loading…");
            const root = await listContents("");
            notebooks = root
                .filter(item => item.type === "dir" && !item.name.startsWith("."))
                .map(item => item.name);

            notesByNotebook = {};
            await Promise.all(notebooks.map(async (nb) => {
                const items = await listContents(nb);
                notesByNotebook[nb] = items
                    .filter(item => item.type === "file" && item.name.endsWith(".md"))
                    .map(item => {
                        fileShas[`${nb}/${item.name}`] = item.sha;
                        return item.name;
                    });
            }));

            sortLoadedNotes();
            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);

            // Deliberately not awaited: the sidebar is already usable.
            hydrateRecency().catch(err => console.error("Recency hydration failed:", err));
        } catch (err) {
            console.error("Failed to load notebooks:", err);
            setSyncStatus("error", "Load failed");
        }
    }

    // Fill in modified times using a fixed request budget: one page of commits
    // plus the newest RECENCY_COMMIT_DETAIL expanded for their file lists.
    // `GET /commits?per_page=…` does not include a `files` array — only the
    // single-commit endpoint does — so the expansion is required.
    async function hydrateRecency() {
        const known = new Set();
        for (const nb of notebooks) {
            for (const note of notesByNotebook[nb] || []) known.add(`${nb}/${note}`);
        }
        if (!known.size) return;

        let commits;
        try {
            commits = await gh("GET", `/repos/${repoFull}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=${RECENCY_COMMIT_PAGE}`);
        } catch (err) {
            console.error("Failed to list commits for recency:", err);
            return;
        }
        if (!Array.isArray(commits) || !commits.length) return;

        const recent = commits.slice(0, RECENCY_COMMIT_DETAIL);
        const resolved = new Map(); // path -> newest commit time touching it

        // Newest commit wins, so process in order and never overwrite.
        await pooled(recent, API_POOL_LIMIT, async (commit) => {
            const detail = await gh("GET", `/repos/${repoFull}/commits/${commit.sha}`);
            const time = new Date(detail.commit.committer.date).getTime();
            for (const file of detail.files || []) {
                if (!known.has(file.filename)) continue;
                const prev = resolved.get(file.filename);
                if (prev === undefined || time > prev) resolved.set(file.filename, time);
            }
        });

        if (!resolved.size) return;
        for (const [path, time] of resolved) setMeta(path, { t: time });
        persistNoteMeta();

        // Hydration lands a second or two after first paint, by which point the
        // user may already be scrolling. Re-render only if the order actually
        // moved, and keep their scroll position when it does.
        const before = orderSignature();
        sortLoadedNotes();
        if (orderSignature() === before) return;

        const $list = $("note-browser-list");
        const scrollTop = $list ? $list.scrollTop : 0;
        renderSidebar($("search-input").value);
        if ($list) $list.scrollTop = scrollTop;
    }

    function orderSignature() {
        return notebooks.map(nb => `${nb}:${(notesByNotebook[nb] || []).join("|")}`).join("//");
    }

    // ── Render: notebook rail + note browser (three-pane) ───
    async function renderSidebar(filter = "") {
        renderNotebookLibrary();
        const query = (filter || "").trim();
        if (query) { await renderSearchResults(query); return; }
        searchSeq += 1;
        renderNoteBrowser();
    }

    function renderNotebookLibrary() {
        const $list = $("notebook-list");
        $list.innerHTML = "";
        const total = notebooks.reduce((sum, nb) => sum + (notesByNotebook[nb] || []).length, 0);
        $("library-total").textContent = total ? String(total) : "";
        $("btn-all-notes").classList.toggle("active", !selectedNotebook);

        for (const nb of notebooks) {
            const $header = document.createElement("div");
            $header.className = "notebook-header";
            if (selectedNotebook === nb) $header.classList.add("active");
            $header.innerHTML = `
                <span class="notebook-name">${escapeHtml(nb)}</span>
                <span class="notebook-count">${(notesByNotebook[nb] || []).length}</span>
                <button class="notebook-add-note" title="New Note" data-notebook="${escapeAttr(nb)}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                </button>`;
            $header.addEventListener("click", (e) => {
                if (e.target.closest(".notebook-add-note")) return;
                selectedNotebook = nb;
                $("search-input").value = "";
                renderSidebar();
            });
            $header.querySelector(".notebook-add-note").addEventListener("click", (e) => {
                e.stopPropagation();
                createNoteIn(nb);
            });
            bindContextMenu($header, () => [
                { label: "New note…", action: () => createNoteIn(nb) },
                { label: "Rename notebook…", action: () => renameNotebook(nb) },
                { label: "Delete notebook", danger: true, action: () => deleteNotebook(nb) },
            ]);
            $list.appendChild($header);
        }

        if (notebooks.length === 0) {
            $list.innerHTML = '<div class="notebook-loading">No notebooks yet. Click + to create one.</div>';
        }
    }

    function renderNoteBrowser() {
        const renderSeq = ++noteBrowserRenderSeq;
        const visible = selectedNotebook
            ? (notesByNotebook[selectedNotebook] || []).map((note) => ({ notebook: selectedNotebook, note }))
            : notebooks.flatMap((nb) => (notesByNotebook[nb] || []).map((note) => ({ notebook: nb, note })));

        $("note-browser-title").textContent = selectedNotebook || "All notes";
        const $list = $("note-browser-list");
        // Cards from the previous render are about to be discarded; an
        // IntersectionObserver keeps its targets alive, so drop them first.
        if (noteCardObserver) { noteCardObserver.disconnect(); noteCardObserver = null; }
        $list.innerHTML = "";

        if (visible.length === 0) {
            $list.innerHTML = '<div class="notebook-loading">No notes here yet.</div>';
            return;
        }

        function appendBatch(start) {
            if (renderSeq !== noteBrowserRenderSeq) return;
            const frag = document.createDocumentFragment();
            const end = Math.min(start + NOTE_CARD_BATCH_SIZE, visible.length);
            for (let i = start; i < end; i++) frag.appendChild(createNoteCard(visible[i]));
            $list.appendChild(frag);
            if (end < visible.length) requestAnimationFrame(() => appendBatch(end));
        }
        appendBatch(0);
    }

    function createNoteCard(item) {
        const $note = document.createElement("button");
        $note.type = "button";
        $note.className = "note-card";
        $note.dataset.notePath = `${item.notebook}/${item.note}`;
        if (currentNotebook === item.notebook && currentNote === item.note) $note.classList.add("active");
        $note.innerHTML = `
            <span class="note-card-title">${escapeHtml(noteTitleCache[`${item.notebook}/${item.note}`] || (metaFor(`${item.notebook}/${item.note}`) || {}).ti || noteFilenameTitle(item.note))}</span>`;
        $note.addEventListener("click", () => openNote(item.notebook, item.note));
        bindContextMenu($note, () => [
            { label: "Rename…", action: () => renameNoteAt(item.notebook, item.note) },
            { label: "Delete note", danger: true, action: () => deleteNoteAt(item.notebook, item.note) },
        ]);
        observeNoteCardTitle($note, item);
        return $note;
    }

    function createNoteIn(nb) {
        showModal("New Note", `Create note in "${nb}"`, async (raw) => {
            const base = raw.trim().replace(/\.md$/i, "");
            if (!base) throw new Error("Note names cannot be empty.");
            // A slash would write the note into a subfolder, and loadNotebooks()
            // only lists one level down — the note would save and then be
            // unreachable from the sidebar.
            if (/[\/\\]/.test(base)) throw new Error("Note names cannot contain slashes.");
            const noteName = `${base}.md`;
            if ((notesByNotebook[nb] || []).some(n => n.toLowerCase() === noteName.toLowerCase())) {
                throw new Error(`"${base}" already exists in ${nb}.`);
            }

            setSyncStatus("syncing", "Creating…");
            await putFile(`${nb}/${noteName}`, `# ${base}\n\n`, `Create note ${nb}/${noteName}`);

            // Insert locally rather than re-listing the repo, for the reason
            // newNotebook() does. A re-list moments after a write can come back
            // without the new file — GitHub's own listing lags a commit briefly
            // — and it would overwrite good local state with that stale answer,
            // taking a just-created notebook down with it.
            notesByNotebook[nb] = [noteName, ...(notesByNotebook[nb] || [])];
            selectedNotebook = nb;
            $("search-input").value = "";
            // Paint before opening: openNote() renders the sidebar itself, but
            // only if the note loads, and a failure there must not also cost the
            // user the row for a note that is already committed.
            renderSidebar();
            setSyncStatus("ok", repoFull);
            openNote(nb, noteName, { startInBody: true });
        });
    }

    // ── Context menu (delete) ───────────────────────────────
    function closeContextMenu() {
        const existing = $("context-menu");
        if (existing) existing.remove();
    }

    function showContextMenu(x, y, items) {
        closeContextMenu();
        const $menu = document.createElement("div");
        $menu.id = "context-menu";
        $menu.className = "context-menu";
        for (const item of items) {
            const $btn = document.createElement("button");
            $btn.type = "button";
            $btn.className = "context-menu-item" + (item.danger ? " danger" : "");
            $btn.textContent = item.label;
            $btn.addEventListener("click", () => {
                closeContextMenu();
                item.action();
            });
            $menu.appendChild($btn);
        }
        document.body.appendChild($menu);
        const rect = $menu.getBoundingClientRect();
        $menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
        $menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
    }

    document.addEventListener("click", (e) => {
        if (!e.target.closest("#context-menu")) closeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeContextMenu();
    });
    // A menu positioned against the viewport detaches from its row the moment
    // the list moves underneath it.
    window.addEventListener("resize", closeContextMenu);
    document.addEventListener("scroll", closeContextMenu, true);

    // Touch has no right-click, and the web app is served to tablets and to
    // phones in the desktop view. Hold for half a second to get the same menu.
    function bindLongPress($el, handler) {
        let timer = null;
        const cancel = () => { clearTimeout(timer); timer = null; };
        $el.addEventListener("touchstart", (e) => {
            const touch = e.touches[0];
            timer = setTimeout(() => {
                timer = null;
                // touchend still synthesises a click, which would open the note
                // behind the menu that just appeared. Swallow that one click.
                $el.addEventListener("click", (click) => {
                    click.preventDefault();
                    click.stopPropagation();
                }, { capture: true, once: true });
                handler(touch.clientX, touch.clientY);
            }, 500);
        }, { passive: true });
        $el.addEventListener("touchmove", cancel, { passive: true });
        $el.addEventListener("touchend", cancel);
        $el.addEventListener("touchcancel", cancel);
    }

    function bindContextMenu($el, build) {
        $el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, build());
        });
        bindLongPress($el, (x, y) => showContextMenu(x, y, build()));
    }

    // Closing the editor is shared by both delete paths: the open note is either
    // the one being deleted or one of the notes inside the notebook being deleted.
    function closeOpenNote() {
        stopEditorDictation();
        if (editor) { editor.destroy(); editor = null; }
        currentNotebook = null;
        currentNote = null;
        isDirty = false;
        $("editor-container").style.display = "none";
        $("empty-state").style.display = "flex";
        document.body.classList.remove("mobile-edit");
    }

    function deleteNotebook(nb) {
        const count = (notesByNotebook[nb] || []).length;
        const what = count === 1 ? "1 note" : `${count} notes`;
        if (!confirm(`Delete notebook "${nb}" and ${what}? It stays recoverable in your Git history.`)) return;

        (async () => {
            try {
                setSyncStatus("syncing", "Deleting notebook…");
                if (currentNotebook === nb) closeOpenNote();
                await deleteFolder(nb, `Delete notebook ${nb}`);

                notebooks = notebooks.filter((name) => name !== nb);
                delete notesByNotebook[nb];
                if (selectedNotebook === nb) selectedNotebook = null;
                renderSidebar($("search-input").value);
                setSyncStatus("ok", repoFull);
            } catch (err) {
                console.error("Delete notebook failed:", err);
                alert("Failed to delete notebook: " + err.message);
                setSyncStatus("error", "Delete failed");
            }
        })();
    }

    // Delete a note that is not necessarily the open one — the note browser's
    // context menu can target any row.
    async function deleteNoteAt(nb, note) {
        const base = note.replace(/\.md$/, "");
        if (!confirm(`Delete "${base}"? It stays recoverable in your Git history.`)) return;

        try {
            setSyncStatus("syncing", "Deleting…");
            if (currentNotebook === nb && currentNote === note) closeOpenNote();
            const path = `${nb}/${note}`;
            await deleteFile(path, `Delete ${path}`);

            notesByNotebook[nb] = (notesByNotebook[nb] || []).filter((name) => name !== note);
            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
        } catch (err) {
            console.error("Delete failed:", err);
            alert("Failed to delete note: " + err.message);
            setSyncStatus("error", "Delete failed");
        }
    }

    // ── Rename ──────────────────────────────────────────────
    // A rename moves the blob the editor saves into. An unsaved edit would be
    // written back to the old path afterwards and resurrect the note under its
    // old name, so settle the open note first and abort if that save fails —
    // saveNote() clears isDirty only when the push succeeded.
    async function settleOpenNoteBefore(what) {
        if (!isDirty) return;
        await saveNote();
        if (isDirty) throw new Error(`Save the open note before renaming ${what}.`);
    }

    function updateBreadcrumb() {
        if (!currentNotebook || !currentNote) return;
        const path = `${currentNotebook}/${currentNote}`;
        const title = noteTitleCache[path] || (metaFor(path) || {}).ti || noteFilenameTitle(currentNote);
        $("note-breadcrumb").textContent = `${currentNotebook} / ${title}`;
    }

    function renameNoteAt(nb, note) {
        const base = note.replace(/\.md$/i, "");
        showModal("Rename Note", "New name…", async (raw) => {
            const next = raw.trim().replace(/\.md$/i, "");
            if (!next) throw new Error("Note names cannot be empty.");
            if (/[\/\\]/.test(next)) throw new Error("Note names cannot contain slashes.");
            const noteName = `${next}.md`;
            if (noteName === note) return;
            // A case-only rename is a real rename, so the note itself is not a
            // collision — anything else in the notebook is.
            if ((notesByNotebook[nb] || []).some((n) => n !== note && n.toLowerCase() === noteName.toLowerCase())) {
                throw new Error(`"${next}" already exists in ${nb}.`);
            }

            const isOpen = currentNotebook === nb && currentNote === note;
            if (isOpen) await settleOpenNoteBefore("it");

            const from = `${nb}/${note}`;
            const to = `${nb}/${noteName}`;
            setSyncStatus("syncing", "Renaming…");
            try {
                // The heading moves with the file, so the note's own title has
                // to be read first — from the cache when the note has been
                // opened this session, and off GitHub when it has not.
                const before = noteContentCache[from] !== undefined
                    ? noteContentCache[from]
                    : (await getFile(from)).content;
                const after = retitleContent(before, next);
                const moved = await movePaths(
                    (path) => (path === from ? { to, content: after } : null),
                    `Rename ${from} to ${to}`);
                if (!moved) throw new Error("The note is no longer in the repository.");

                notesByNotebook[nb] = (notesByNotebook[nb] || []).map((n) => (n === note ? noteName : n));
                cacheNoteTitle(nb, noteName, after);
                setMeta(to, { t: Date.now() });
                persistNoteMeta();
                if (isOpen) {
                    currentNote = noteName;
                    // The editor still holds the old heading, and it is what the
                    // next save writes — leaving it would undo the rename.
                    setEditorContent(after);
                    updateBreadcrumb();
                }
            } catch (err) {
                setSyncStatus("error", "Rename failed");
                throw err;
            }

            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
        }, { value: base, confirmLabel: "Rename" });
    }

    function renameNotebook(nb) {
        showModal("Rename Notebook", "New name…", async (raw) => {
            const name = raw.trim().replace(/\/+$/, "");
            // A leading dot would create a notebook that loadNotebooks() filters
            // straight back out, so the user would see it vanish.
            if (!name || name.startsWith(".")) throw new Error("Notebook names cannot start with a dot.");
            if (/[\/\\]/.test(name)) throw new Error("Notebook names cannot contain slashes.");
            if (name === nb) return;
            if (notebooks.some((other) => other !== nb && other.toLowerCase() === name.toLowerCase())) {
                throw new Error(`A notebook called "${name}" already exists.`);
            }

            const holdsOpenNote = currentNotebook === nb && currentNote;
            if (holdsOpenNote) await settleOpenNoteBefore("its notebook");

            setSyncStatus("syncing", "Renaming notebook…");
            try {
                // Every blob under the folder, not just the .md files: a
                // notebook also carries .gitkeep and the assets/ images its
                // notes link to by relative path.
                const moved = await movePaths(
                    (path) => (path.startsWith(nb + "/") ? name + path.slice(nb.length) : null),
                    `Rename notebook ${nb} to ${name}`);
                if (!moved) throw new Error("The notebook is no longer in the repository.");
            } catch (err) {
                setSyncStatus("error", "Rename failed");
                throw err;
            }

            notebooks = notebooks.map((other) => (other === nb ? name : other));
            notesByNotebook[name] = notesByNotebook[nb] || [];
            delete notesByNotebook[nb];
            if (selectedNotebook === nb) selectedNotebook = name;
            if (currentNotebook === nb) { currentNotebook = name; updateBreadcrumb(); }
            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
        }, { value: nb, confirmLabel: "Rename" });
    }

    async function renderSearchResults(query) {
        const seq = ++searchSeq;
        $("note-browser-title").textContent = "Search";
        const $list = $("note-browser-list");
        $list.innerHTML = '<div class="notebook-loading">Searching note contents…</div>';

        try {
            const results = await searchNotes(query);
            if (seq !== searchSeq) return;

            $list.innerHTML = "";
            const $header = document.createElement("div");
            $header.className = "search-results-header";
            $header.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
            $list.appendChild($header);

            if (results.length === 0) {
                const $none = document.createElement("div");
                $none.className = "notebook-loading";
                $none.textContent = "No matching notes.";
                $list.appendChild($none);
                return;
            }

            for (const result of results) {
                const $note = document.createElement("button");
                $note.type = "button";
                $note.className = "note-card search-result-item";
                if (currentNotebook === result.notebook && currentNote === result.note) $note.classList.add("active");
                $note.innerHTML = `
                    <span class="note-card-title">${escapeHtml(result.title)}</span>
                    <span class="note-card-preview">${result.snippet ? escapeHtml(result.snippet) : "Markdown note"}</span>
                    <span class="note-card-meta">${escapeHtml(result.notebook)}</span>`;
                $note.addEventListener("click", () => openNote(result.notebook, result.note));
                bindContextMenu($note, () => [
                    { label: "Rename…", action: () => renameNoteAt(result.notebook, result.note) },
                    { label: "Delete note", danger: true, action: () => deleteNoteAt(result.notebook, result.note) },
                ]);
                $list.appendChild($note);
            }
        } catch (err) {
            if (seq !== searchSeq) return;
            console.error("Search failed:", err);
            $list.innerHTML = '<div class="notebook-loading">Search failed.</div>';
        }
    }

    async function searchNotes(query) {
        const results = [];
        const lowerQuery = query.toLowerCase();

        for (const nb of notebooks) {
            for (const note of notesByNotebook[nb] || []) {
                const path = `${nb}/${note}`;
                const content = await getCachedFileContent(path);
                const title = getNoteTitle(content, note);
                const filenameTitle = noteFilenameTitle(note);
                const titleMatch = title.toLowerCase().includes(lowerQuery) || filenameTitle.toLowerCase().includes(lowerQuery);
                const notebookMatch = nb.toLowerCase().includes(lowerQuery);
                const contentMatch = content.toLowerCase().includes(lowerQuery);

                if (!titleMatch && !notebookMatch && !contentMatch) continue;

                results.push({
                    notebook: nb,
                    note,
                    title: cacheNoteTitle(nb, note, content),
                    snippet: makeSnippet(content, query),
                });
                if (results.length >= 100) return results;
            }
        }

        return results;
    }

    async function getCachedFileContent(path) {
        if (Object.prototype.hasOwnProperty.call(noteContentCache, path)) {
            return noteContentCache[path];
        }
        const { content } = await getFile(path);
        return content;
    }

    // Card titles come from each note's first H1, which needs its content. On a
    // cold load that is one request per uncached note, so they go through a
    // bounded queue rather than all at once; cards fill in progressively and
    // the connection pool stays available for whatever the user actually opens.
    let titleQueue = [];
    let titleWorkers = 0;
    let titlePersistTimer = null;

    function queueTitleFetch(path) {
        return new Promise((resolve, reject) => {
            titleQueue.push({ path, resolve, reject });
            if (titleWorkers < API_POOL_LIMIT) {
                titleWorkers++;
                drainTitleQueue();
            }
        });
    }

    async function drainTitleQueue() {
        while (titleQueue.length) {
            const job = titleQueue.shift();
            try {
                job.resolve(await getCachedFileContent(job.path));
            } catch (err) {
                job.reject(err);
            }
        }
        titleWorkers--;
        // Batch the writes: one serialise per quiet period, not per note.
        clearTimeout(titlePersistTimer);
        titlePersistTimer = setTimeout(persistNoteMeta, 250);
    }

    function noteFilenameTitle(note) {
        return note.replace(/\.md$/, "");
    }

    function getNoteTitle(content, note) {
        const fallback = noteFilenameTitle(note);
        const lines = String(content || "").replace(/^\uFEFF/, "").split(/\r?\n/);
        for (const line of lines) {
            const match = line.trim().match(/^#\s+(.+?)\s*#*\s*$/);
            if (match && match[1].trim()) return match[1].trim();
        }
        return fallback;
    }

    // Rewrite the heading a note's title comes from, so renaming the file
    // renames the note everywhere it is shown rather than only in the repo.
    // The scan has to stay identical to getNoteTitle()'s or the rewrite lands on
    // a different line than the one on display. A note with no H1 already falls
    // back to its file name and needs nothing — inserting a heading would put
    // content in the note that the user never wrote.
    function retitleContent(content, title) {
        const lines = String(content || "").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].trim().match(/^#\s+(.+?)\s*#*\s*$/);
            if (!match || !match[1].trim()) continue;
            // Keep whatever the line was indented by, and the BOM if it had one.
            lines[i] = `${lines[i].match(/^\s*/)[0]}# ${title}`;
            return lines.join("\n");
        }
        return content;
    }

    function cacheNoteTitle(notebook, note, content) {
        const path = `${notebook}/${note}`;
        const title = getNoteTitle(content, note);
        noteTitleCache[path] = title;
        setMeta(path, { ti: title });
        return title;
    }

    function updateOpenNoteTitle(content) {
        if (!currentNotebook || !currentNote) return;
        const path = `${currentNotebook}/${currentNote}`;
        const title = cacheNoteTitle(currentNotebook, currentNote, content);

        $("note-breadcrumb").textContent = `${currentNotebook} / ${title}`;
        document.querySelectorAll(".note-card[data-note-path]").forEach(($card) => {
            if ($card.dataset.notePath !== path) return;
            const $title = $card.querySelector(".note-card-title");
            if ($title) $title.textContent = title;
        });
    }

    // A note's display title is its first H1, which means reading its content.
    // Selecting "All notes" on a large repo builds a card per note, but only a
    // screenful is ever visible, so uncached titles are fetched on approach
    // rather than for the whole list up front.
    let noteCardObserver = null;
    const pendingCardItems = new WeakMap();

    function observeNoteCardTitle($card, item) {
        const path = `${item.notebook}/${item.note}`;
        // Anything already known renders synchronously; no observer needed.
        if (Object.prototype.hasOwnProperty.call(noteTitleCache, path)) return;
        const cached = metaFor(path);
        if (cached && cached.ti) {
            noteTitleCache[path] = cached.ti;
            return;
        }
        if (!("IntersectionObserver" in window)) {
            loadNoteCardTitle($card, item);
            return;
        }
        if (!noteCardObserver) {
            noteCardObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const target = entry.target;
                    noteCardObserver.unobserve(target);
                    const pending = pendingCardItems.get(target);
                    if (pending) {
                        pendingCardItems.delete(target);
                        loadNoteCardTitle(target, pending);
                    }
                }
            }, { rootMargin: "200px" });
        }
        pendingCardItems.set($card, item);
        noteCardObserver.observe($card);
    }

    function loadNoteCardTitle($card, item) {
        const path = `${item.notebook}/${item.note}`;
        if (Object.prototype.hasOwnProperty.call(noteTitleCache, path)) {
            $card.querySelector(".note-card-title").textContent = noteTitleCache[path];
            return;
        }
        // A title cached against this note's current blob SHA is still correct,
        // so a repeat visit renders every card without fetching any content.
        const cached = metaFor(path);
        if (cached && cached.ti) {
            noteTitleCache[path] = cached.ti;
            $card.querySelector(".note-card-title").textContent = cached.ti;
            return;
        }

        queueTitleFetch(path).then((content) => {
            const title = cacheNoteTitle(item.notebook, item.note, content);
            if ($card.isConnected) $card.querySelector(".note-card-title").textContent = title;
        }).catch((err) => {
            console.error(`Failed to load title for ${path}:`, err);
        });
    }

    function makeSnippet(content, query, size = 140) {
        const idx = content.toLowerCase().indexOf(query.toLowerCase());
        if (idx < 0) return "";
        const start = Math.max(0, idx - Math.floor(size / 2));
        const end = Math.min(content.length, idx + query.length + Math.floor(size / 2));
        let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
        if (start > 0) snippet = "..." + snippet;
        if (end < content.length) snippet += "...";
        return snippet;
    }

    // ── Note image assets ───────────────────────────────────
    // Notes reference pasted/dropped images by a note-relative path
    // (assets/<file>). The bytes live in the (private) repo, so we can't point
    // an <img> at raw.githubusercontent.com — fetch each one with the auth
    // token and expose it as a blob: URL that customHTMLRenderer.image swaps in.
    async function preloadNoteAssets(notebook, markdown) {
        // Release the previous note's blob URLs before loading the new set.
        for (const url of Object.values(assetUrlCache)) URL.revokeObjectURL(url);
        assetUrlCache = {};

        const rels = new Set();
        const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
        let m;
        while ((m = re.exec(markdown)) !== null) {
            const dest = m[1];
            if (dest && !/^(https?:|data:|blob:|\/|#)/.test(dest)) rels.add(dest);
        }
        if (rels.size === 0) return;

        await Promise.all([...rels].map(async (rel) => {
            try {
                const path = `${notebook}/${rel}`;
                const url = `https://api.github.com/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`;
                const r = await fetch(url, {
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Accept": "application/vnd.github.raw",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                });
                if (!r.ok) return;
                assetUrlCache[rel] = URL.createObjectURL(await r.blob());
            } catch (err) {
                console.warn("Failed to load note image:", rel, err);
            }
        }));
    }

    // Browser paste/drag MIME types → file extensions (mirrors the local server).
    const IMAGE_EXT = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/heic": "heic",
        "image/avif": "avif",
    };

    function arrayBufferToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000; // chunk to stay under argument-count limits
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function assetFilename(ext) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        const rand = new Uint8Array(3);
        crypto.getRandomValues(rand);
        const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
        return `paste-${stamp}-${hex}.${ext}`;
    }

    // ── Image paste / drag-drop upload ──────────────────────
    // Commits the pasted image into the open note's assets/ folder in the repo
    // and returns the note-relative path (assets/<file>) to keep the Markdown
    // portable across the web and local apps.
    async function uploadImageBlob(blob) {
        if (!currentNotebook) {
            alert("Open a note before adding an image.");
            return null;
        }
        const ext = IMAGE_EXT[(blob && blob.type || "").toLowerCase()];
        if (!ext) {
            alert("Only image files can be added.");
            return null;
        }
        try {
            const rel = `assets/${assetFilename(ext)}`;
            const path = `${currentNotebook}/${rel}`;
            const b64 = arrayBufferToBase64(await blob.arrayBuffer());
            const data = await gh("PUT", `/repos/${repoFull}/contents/${encodeURI(path)}`, {
                message: `Add image ${path}`,
                content: b64,
                branch: defaultBranch,
            });
            if (data && data.content) fileShas[path] = data.content.sha;
            // Make it render immediately without a round-trip to fetch the bytes.
            assetUrlCache[rel] = URL.createObjectURL(blob);
            return rel;
        } catch (err) {
            console.error("Image upload failed:", err);
            alert("Couldn't add image: " + (err.message || err));
            return null;
        }
    }

    function imageAltText(filename) {
        return String(filename || "image")
            .replace(/\.[^.]+$/, "")
            .replace(/[\[\]\\]/g, "")
            .trim() || "image";
    }

    function insertImageMarkdown(relPath, filename) {
        if (!editor) return;
        const markdown = editor.getMarkdown().replace(/\s*$/, "");
        const prefix = markdown ? `${markdown}\n\n` : "";
        editor.setMarkdown(`${prefix}![${imageAltText(filename)}](${relPath})\n`);
        editor.moveCursorToEnd();
        editor.focus();
    }

    async function uploadAndInsertImage(blob) {
        const relPath = await uploadImageBlob(blob);
        if (relPath) insertImageMarkdown(relPath, blob.name || "image");
    }

    function imageFileFromDataTransfer(dataTransfer) {
        if (!dataTransfer) return null;
        for (const item of dataTransfer.items || []) {
            if (item.kind === "file" && /^image\//i.test(item.type || "")) {
                return item.getAsFile();
            }
        }
        return [...(dataTransfer.files || [])].find((file) => /^image\//i.test(file.type || "")) || null;
    }

    function setupImageHandling() {
        const $editorRoot = $("editor");
        if (!$editorRoot) return;

        // Toast UI's hook handles its normal image commands. These capture
        // handlers also cover clipboard and drag/drop images when its hidden
        // toolbar is bypassed, while preserving ordinary text paste/drop.
        $editorRoot.addEventListener("paste", (event) => {
            const file = imageFileFromDataTransfer(event.clipboardData);
            if (!file) return;
            event.preventDefault();
            event.stopPropagation();
            uploadAndInsertImage(file);
        }, true);
        $editorRoot.addEventListener("drop", (event) => {
            const file = imageFileFromDataTransfer(event.dataTransfer);
            if (!file) return;
            event.preventDefault();
            event.stopPropagation();
            uploadAndInsertImage(file);
        }, true);
    }

    // ── Open Note ───────────────────────────────────────────
    async function openNote(notebook, note, { startInBody = false } = {}) {
        if (isDirty && !confirm("You have unsaved changes. Discard?")) return;
        stopEditorDictation();

        try {
            setSyncStatus("syncing", "Loading note…");
            const path = `${notebook}/${note}`;
            const { content } = await getFile(path);
            await preloadNoteAssets(notebook, content);

            currentNotebook = notebook;
            currentNote = note;
            isDirty = false;
            const noteTitle = cacheNoteTitle(notebook, note, content);

            $("empty-state").style.display = "none";
            $("editor-container").style.display = "flex";
            document.body.classList.add("mobile-edit"); // phone single-pane → editor full screen
            $("note-breadcrumb").textContent = `${notebook} / ${noteTitle}`;
            $("save-status").textContent = "";

            if (editor) { editor.destroy(); editor = null; }
            initEditor(content, { startInBody });
            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
            window.dispatchEvent(new CustomEvent("everfree:note-changed", { detail: { notebook, note } }));
        } catch (err) {
            console.error("Failed to open note:", err);
            alert("Failed to open note: " + err.message);
            setSyncStatus("error", "Load failed");
        }
    }

    function initEditor(content = "", { startInBody = false } = {}) {
        editor = new toastui.Editor({
            el: $("editor"),
            height: "100%",
            initialEditType: "wysiwyg",
            initialValue: content,
            placeholder: "Start writing…",
            hooks: {
                // Paste or drag-drop an image: upload the blob to the note's
                // assets/ folder in the repo and insert it as a note-relative
                // path. Returning false prevents Toast UI's default base64
                // inlining (which would bloat the synced Markdown).
                addImageBlobHook(blob, callback) {
                    uploadImageBlob(blob).then((relPath) => {
                        if (!relPath) return;
                        callback(relPath, blob.name || "image");
                        // Re-render from Markdown so customHTMLRenderer maps the
                        // relative path to its blob: URL — a freshly inserted
                        // node keeps the raw src and won't load otherwise.
                        requestAnimationFrame(() => {
                            if (editor) editor.setMarkdown(editor.getMarkdown());
                        });
                    });
                    return false;
                },
            },
            customHTMLRenderer: {
                // Resolve note-relative image paths (assets/foo.png) to the
                // blob: URL preloaded from the repo so they render. Display-only:
                // the editor keeps the relative path in its model, so saves stay
                // portable in the synced Markdown.
                image(node, context) {
                    const result = context.origin();
                    const src = node.destination || "";
                    if (result && !/^(https?:|data:|blob:|\/)/.test(src)) {
                        const resolved = assetUrlCache[src];
                        if (resolved) result.attributes.src = resolved;
                    }
                    return result;
                },
            },
        });

        const isDark = (localStorage.getItem(LS_THEME) || "light") === "dark";
        const tuiWrapper = document.querySelector(".toastui-editor-defaultUI");
        if (tuiWrapper) tuiWrapper.classList.toggle("toastui-editor-dark", isDark);

        // Markdown parsers discard trailing blank lines, so the `# title\n\n`
        // used for a new note otherwise becomes a document containing only an
        // H1. Toast UI then puts the first typed text in that heading. Create a
        // real empty paragraph and place the cursor there before change tracking
        // is attached; the first edit now starts as ordinary body text.
        if (startInBody) {
            editor.moveCursorToEnd();
            editor.insertText("\n");
            editor.focus();
        }

        editor.on("change", () => {
            updateOpenNoteTitle(editor.getMarkdown());
            if (!isDirty) {
                isDirty = true;
                const $s = $("save-status");
                $s.textContent = "Unsaved changes";
                $s.className = "save-status";
            }
        });
    }

    // ── Editor voice input ──────────────────────────────────
    function setEditorMicActive(active) {
        const $mic = $("btn-editor-mic");
        if (!$mic) return;
        $mic.classList.toggle("is-listening", active);
        $mic.setAttribute("aria-pressed", active ? "true" : "false");
        $mic.title = active ? "Stop dictation" : "Dictate into note (voice input)";
    }

    function stopEditorDictation() {
        if (editorDictation && editorDictation.active) editorDictation.stop();
    }

    function appendDictationToEditor(text) {
        const spoken = (text || "").trim();
        if (!spoken || !editor) return;
        editor.focus();
        editor.insertText(spoken + " ");
    }

    function setupEditorDictation() {
        const $mic = $("btn-editor-mic");
        if (!$mic) return;
        if (typeof window.createDictation !== "function" || !window.voiceInputSupported) {
            $mic.disabled = true;
            $mic.title = "Voice input is not supported in this browser";
            $mic.setAttribute("aria-disabled", "true");
            return;
        }

        editorDictation = window.createDictation({
            onFinal: appendDictationToEditor,
            onState: setEditorMicActive,
            onError(error) {
                setEditorMicActive(false);
                const $s = $("save-status");
                $s.textContent =
                    error === "not-allowed"
                        ? "Microphone permission denied"
                        : error === "audio-capture"
                            ? "No microphone found"
                            : "Voice input stopped";
                $s.className = "save-status";
            },
        });

        if (!editorDictation) {
            $mic.disabled = true;
            $mic.title = "Voice input is not supported in this browser";
            $mic.setAttribute("aria-disabled", "true");
            return;
        }

        $mic.setAttribute("aria-pressed", "false");
        $mic.addEventListener("click", () => {
            if (!currentNotebook || !currentNote || !editor) return;
            editorDictation.toggle();
        });
    }

    // Replace what the editor holds with content that is already committed.
    // setMarkdown fires the change handler, which would flag the note unsaved
    // over a write the client itself just pushed, so the flag is cleared after.
    function setEditorContent(content) {
        if (!editor) return;
        editor.setMarkdown(content);
        isDirty = false;
        $("save-status").textContent = "";
    }

    // ── Save Note ───────────────────────────────────────────
    async function saveNote() {
        if (!currentNotebook || !currentNote || !editor) return;

        const $s = $("save-status");
        try {
            $s.textContent = "Saving…";
            $s.className = "save-status";
            setSyncStatus("syncing", "Pushing to GitHub…");

            const path = `${currentNotebook}/${currentNote}`;
            await putFile(path, editor.getMarkdown(), `Update ${path}`);

            isDirty = false;
            $s.textContent = "✓ Saved & pushed";
            $s.className = "save-status saved";
            setSyncStatus("ok", repoFull);

            setTimeout(() => { if (!isDirty) $s.textContent = ""; }, 2000);
        } catch (err) {
            console.error("Save failed:", err);
            $s.textContent = "⚠ Save failed";
            $s.className = "save-status";
            setSyncStatus("error", "Push failed");
            alert("Save failed: " + err.message);
        }
    }

    // ── Delete Note ─────────────────────────────────────────
    // The toolbar button acts on the open note; deleteNoteAt() handles the rest
    // so the button and the note-browser context menu cannot drift apart.
    function deleteNote() {
        if (!currentNotebook || !currentNote) return;
        return deleteNoteAt(currentNotebook, currentNote);
    }

    // ── Sync Status UI ──────────────────────────────────────
    function setSyncStatus(state, text) {
        $("sync-indicator").className = "sync-dot sync-" + state;
        $("sync-text").textContent = text;
    }

    function setupPaneResizers() {
        const panes = {
            sidebar: {
                element: $("sidebar"),
                handle: $("sidebar-resizer"),
                cssVariable: "--sidebar-width",
                storageKey: LS_SIDEBAR_WIDTH,
                min: 180,
                max: 420,
            },
            noteBrowser: {
                element: $("note-browser"),
                handle: $("note-browser-resizer"),
                cssVariable: "--note-browser-width",
                storageKey: LS_NOTE_BROWSER_WIDTH,
                min: 240,
                max: 520,
            },
        };
        const active = { pane: null, startX: 0, startWidth: 0 };

        function viewportAllowsResize() {
            return window.matchMedia("(min-width: 769px)").matches;
        }

        function limits(pane) {
            const other = pane === panes.sidebar ? panes.noteBrowser : panes.sidebar;
            const otherWidth = other.current;
            const assistant = $("ef-ai-panel");
            const assistantWidth = assistant && !assistant.hidden
                ? assistant.getBoundingClientRect().width : 0;
            const editorMin = 360;
            const maxAvailable = window.innerWidth - otherWidth - assistantWidth - editorMin - 16;
            return {
                min: pane.min,
                max: Math.max(pane.min, Math.min(pane.max, maxAvailable)),
            };
        }

        function setPaneWidth(pane, width, persist = false) {
            const bounds = limits(pane);
            const next = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
            viewApp.style.setProperty(pane.cssVariable, `${next}px`);
            pane.current = next;
            pane.handle.setAttribute("aria-valuemin", String(bounds.min));
            pane.handle.setAttribute("aria-valuemax", String(bounds.max));
            pane.handle.setAttribute("aria-valuenow", String(next));
            if (persist) {
                pane.preferred = next;
                localStorage.setItem(pane.storageKey, String(next));
            }
        }

        // Seed both widths before applying any, since each pane's limit depends
        // on how much room the other one is taking. Read the stylesheet's value
        // rather than the rendered box: the shell can still be hidden here, and
        // a hidden element measures zero.
        for (const pane of Object.values(panes)) {
            const declared = parseFloat(
                getComputedStyle(pane.element).getPropertyValue(pane.cssVariable));
            pane.current = Number.isFinite(declared) && declared > 0
                ? declared : pane.element.getBoundingClientRect().width;
            const saved = Number(localStorage.getItem(pane.storageKey));
            // With nothing saved, the stylesheet's width is the width to return
            // to after the assistant stops borrowing space.
            pane.preferred = Number.isFinite(saved) && saved > 0 ? saved : pane.current;
        }

        for (const pane of Object.values(panes)) {
            setPaneWidth(pane, pane.preferred);

            pane.handle.addEventListener("pointerdown", (event) => {
                if (!viewportAllowsResize()) return;
                event.preventDefault();
                active.pane = pane;
                active.startX = event.clientX;
                active.startWidth = pane.current;
                pane.handle.classList.add("is-active");
                document.body.classList.add("resizing-panes");
                pane.handle.setPointerCapture?.(event.pointerId);
            });

            pane.handle.addEventListener("keydown", (event) => {
                if (!viewportAllowsResize()) return;
                const current = pane.current;
                let next = current;
                if (event.key === "ArrowLeft") next -= 16;
                if (event.key === "ArrowRight") next += 16;
                if (event.key === "Home") next = pane.min;
                if (event.key === "End") next = pane.max;
                if (next === current) return;
                event.preventDefault();
                setPaneWidth(pane, next, true);
            });
        }

        window.addEventListener("pointermove", (event) => {
            if (!active.pane) return;
            setPaneWidth(active.pane, active.startWidth + event.clientX - active.startX);
        });

        function stopResize() {
            if (!active.pane) return;
            const pane = active.pane;
            setPaneWidth(pane, pane.current, true);
            pane.handle.classList.remove("is-active");
            document.body.classList.remove("resizing-panes");
            active.pane = null;
        }

        window.addEventListener("pointerup", stopResize);
        window.addEventListener("pointercancel", stopResize);
        // Re-clamp when the window (or the assistant panel) changes the space
        // the three panes have to share.
        const reclamp = () => {
            for (const pane of Object.values(panes)) {
                setPaneWidth(pane, pane.preferred);
            }
        };
        window.addEventListener("resize", reclamp);
        window.addEventListener("everfree:layout-change", reclamp);
    }

    // ── Modal ───────────────────────────────────────────────
    let modalCallback = null;
    // `opts.value` prefills the input — a rename starts from the current name,
    // selected, so a small edit is a small edit and replacing it outright is
    // still one keystroke away.
    function showModal(title, placeholder, callback, opts = {}) {
        $("modal-title").textContent = title;
        $("modal-input").placeholder = placeholder;
        $("modal-input").value = opts.value || "";
        $("modal-confirm").textContent = opts.confirmLabel || "Create";
        modalCallback = callback;
        $("modal-overlay").style.display = "flex";
        setTimeout(() => { $("modal-input").focus(); $("modal-input").select(); }, 50);
    }
    function hideModal() {
        $("modal-overlay").style.display = "none";
        modalCallback = null;
    }
    async function confirmModal() {
        const value = $("modal-input").value.trim();
        if (!value || !modalCallback) return;
        try {
            await modalCallback(value);
            hideModal();
        } catch (err) {
            console.error("Modal action failed:", err);
            alert("Operation failed: " + err.message);
        }
    }

    // ── Search ──────────────────────────────────────────────
    let searchTimeout = null;
    function onSearch() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => renderSidebar($("search-input").value), 200);
    }

    // ── Utility ─────────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = String(str);
        return div.innerHTML;
    }
    function escapeAttr(str) {
        return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // ── Theme ────────────────────────────────────────────────
    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        const isDark = theme === "dark";
        const $tuiDarkCss = $("tui-dark-css");
        if ($tuiDarkCss) $tuiDarkCss.disabled = !isDark;
        const tuiWrapper = document.querySelector(".toastui-editor-defaultUI");
        if (tuiWrapper) tuiWrapper.classList.toggle("toastui-editor-dark", isDark);
        const dIcon = $("theme-icon-dark"), lIcon = $("theme-icon-light");
        if (dIcon) dIcon.style.display = isDark ? "block" : "none";
        if (lIcon) lIcon.style.display = isDark ? "none" : "block";
        localStorage.setItem(LS_THEME, theme);
    }

    function getInitialTheme() {
        const stored = localStorage.getItem(LS_THEME);
        if (!localStorage.getItem(LS_LIGHT_THEME_MIGRATED)) {
            localStorage.setItem(LS_LIGHT_THEME_MIGRATED, "1");
            if (stored === "dark") return "light";
        }
        return stored || "light";
    }

    // ── Account Popover ─────────────────────────────────────
    function toggleAccountPopover() {
        const $pop = $("account-popover");
        const isHidden = $pop.classList.contains("hidden");
        if (isHidden) {
            $("popover-username").textContent = user || "—";
            $("popover-repo").textContent = repoFull || "—";
        }
        $pop.classList.toggle("hidden");
    }

    document.addEventListener("click", (e) => {
        const $pop = $("account-popover");
        if ($pop.classList.contains("hidden")) return;
        if (e.target.closest("#account-popover") || e.target.closest("#btn-account")) return;
        $pop.classList.add("hidden");
    });

    // ── Event Bindings ──────────────────────────────────────
    $("btn-github-signin").addEventListener("click", startDeviceFlow);
    $("btn-github-signin-hero").addEventListener("click", startDeviceFlow);
    $("btn-signin-retry").addEventListener("click", () => {
        signinError.classList.add("hidden");
        signinIdle.classList.remove("hidden");
    });
    $("btn-signout").addEventListener("click", signOut);

    $("btn-account").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleAccountPopover();
    });

    $("btn-theme").addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "light";
        applyTheme(current === "dark" ? "light" : "dark");
    });

    $("btn-save").addEventListener("click", saveNote);
    $("btn-delete-note").addEventListener("click", deleteNote);
    $("modal-cancel").addEventListener("click", hideModal);
    $("modal-confirm").addEventListener("click", confirmModal);
    $("search-input").addEventListener("input", onSearch);

    $("modal-overlay").addEventListener("click", (e) => {
        if (e.target === $("modal-overlay")) hideModal();
    });
    $("modal-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmModal();
        if (e.key === "Escape") hideModal();
    });

    function newNotebook() {
        showModal("New Notebook", "Notebook name…", async (raw) => {
            const name = raw.trim().replace(/\/+$/, "");
            // A leading dot would create a notebook that loadNotebooks() filters
            // straight back out, so the user would see nothing at all.
            if (!name || name.startsWith(".")) throw new Error("Notebook names cannot start with a dot.");
            if (/[\/\\]/.test(name)) throw new Error("Notebook names cannot contain slashes.");
            if (notebooks.some(nb => nb.toLowerCase() === name.toLowerCase())) {
                throw new Error(`A notebook called "${name}" already exists.`);
            }

            setSyncStatus("syncing", "Creating notebook…");
            // Create a .gitkeep file in the new folder
            await putFile(`${name}/.gitkeep`, "", `Create notebook ${name}`);

            // Insert locally rather than re-listing the whole repo: a reload
            // costs one request per notebook, and the sidebar would sit
            // unchanged for seconds — which reads as "nothing happened".
            notebooks.unshift(name);
            notesByNotebook[name] = [];
            selectedNotebook = name;
            $("search-input").value = "";
            renderSidebar();
            // The rail may be scrolled away from the top, where the new
            // notebook lands.
            const $row = $("notebook-list").querySelector(".notebook-header.active");
            if ($row) $row.scrollIntoView({ block: "nearest" });
            setSyncStatus("ok", repoFull);
        });
    }
    $("btn-new-notebook").addEventListener("click", newNotebook);
    $("btn-new-notebook-inline").addEventListener("click", newNotebook);

    // Library "All notes" home — clears the notebook filter.
    $("btn-all-notes").addEventListener("click", () => {
        selectedNotebook = null;
        $("search-input").value = "";
        renderSidebar();
    });

    // Note-browser "+" — create a note in the selected (or first) notebook.
    $("btn-new-note").addEventListener("click", () => {
        const nb = selectedNotebook || currentNotebook || notebooks[0];
        if (!nb) { newNotebook(); return; }
        createNoteIn(nb);
    });

    // Collapsed-rail actions (shown on narrow widths).
    $("btn-show-notes").addEventListener("click", () => {
        selectedNotebook = null;
        renderSidebar();
    });
    $("btn-rail-search").addEventListener("click", () => $("search-input").focus());

    // Phone single-pane: return from the editor to the note list.
    $("btn-mobile-back").addEventListener("click", () => {
        document.body.classList.remove("mobile-edit");
    });

    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            saveNote();
        }
    });

    window.addEventListener("beforeunload", (e) => {
        if (isDirty) { e.preventDefault(); e.returnValue = ""; }
    });

    // ── Init ────────────────────────────────────────────────
    window.EverFreeNoteContext = {
        getNote() {
            if (!currentNotebook || !currentNote || !editor) return null;
            return { notebook: currentNotebook, note: currentNote, content: editor.getMarkdown() };
        },
        getSelection() {
            const root = document.getElementById("editor");
            if (!root) return "";
            for (const textarea of root.querySelectorAll("textarea")) {
                if (textarea.selectionStart !== textarea.selectionEnd) {
                    return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
                }
            }
            const selection = window.getSelection();
            return selection && selection.anchorNode && root.contains(selection.anchorNode)
                ? selection.toString() : "";
        },
    };

    setupEditorDictation();
    setupImageHandling();
    setupPaneResizers();
    applyTheme(getInitialTheme());
    loadNoteMeta();

    if (token && tokenExpiresAt && tokenExpiresAt <= Date.now()) {
        signOut();
    } else if (token && user) {
        if (repoFull) {
            enterApp().catch(err => {
                showView("signin");
                showSigninError(err.message);
            });
        } else {
            autoConnectRepo().catch(err => {
                showView("signin");
                showSigninError(err.message);
            });
        }
    } else {
        showView("signin");
    }
})();
