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
    const DEFAULT_REPO = "everfree-notes";

    // Migrate away from the legacy broad OAuth token. Authentication data is
    // tab-scoped; preferences such as theme remain in localStorage.
    [AUTH_TOKEN_KEY, AUTH_USER_KEY, AUTH_REPO_KEY].forEach(key => localStorage.removeItem(key));

    // ── State ───────────────────────────────────────────────
    let token = sessionStorage.getItem(AUTH_TOKEN_KEY) || null;
    let user = sessionStorage.getItem(AUTH_USER_KEY) || null;
    let repoFull = sessionStorage.getItem(AUTH_REPO_KEY) || null; // "owner/everfree-notes"
    let tokenExpiresAt = Number(sessionStorage.getItem(AUTH_EXPIRES_KEY) || 0);
    let defaultBranch = "main";

    let notebooks = [];
    let notesByNotebook = {}; // notebook -> [{name, sha}]
    let fileShas = {}; // "notebook/note.md" -> sha
    let noteContentCache = {}; // "notebook/note.md" -> markdown
    let noteTitleCache = {}; // "notebook/note.md" -> display title
    let noteModifiedCache = {}; // "notebook/note.md" -> timestamp (ms)
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
                    tokenExpiresAt = Date.now() + (Number(data.expires_in) * 1000);
                    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
                    sessionStorage.setItem(AUTH_EXPIRES_KEY, String(tokenExpiresAt));
                    await fetchUserAndProceed();
                }
            } catch (err) {
                showSigninError(err.message);
            }
        };
        devicePollTimer = setTimeout(tick, interval);
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
            sessionStorage.setItem(AUTH_USER_KEY, user);
            await autoConnectRepo();
        } catch (err) {
            showSigninError("Failed to fetch GitHub profile: " + err.message);
        }
    }

    async function autoConnectRepo() {
        try {
            const repo = await gh("GET", `/repos/${user}/${DEFAULT_REPO}`);
            rememberRepo(repo);
            await enterApp();
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
            await enterApp();
        } catch (err) {
            if (err.status === 422) {
                const repo = await gh("GET", `/repos/${user}/${DEFAULT_REPO}`);
                rememberRepo(repo);
                await enterApp();
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
        sessionStorage.setItem(AUTH_REPO_KEY, repoFull);
    }

    function clearRememberedRepo() {
        repoFull = null;
        defaultBranch = "main";
        sessionStorage.removeItem(AUTH_REPO_KEY);
        resetRepoData();
    }

    function resetRepoData() {
        notebooks = [];
        notesByNotebook = {};
        fileShas = {};
        noteContentCache = {};
        noteTitleCache = {};
        noteModifiedCache = {};
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
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
        sessionStorage.removeItem(AUTH_USER_KEY);
        sessionStorage.removeItem(AUTH_REPO_KEY);
        sessionStorage.removeItem(AUTH_EXPIRES_KEY);
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        resetRepoData();
        signinIdle.classList.remove("hidden");
        signinPending.classList.add("hidden");
        signinError.classList.add("hidden");
        showView("signin");
    }

    // ── Enter App ───────────────────────────────────────────
    async function enterApp() {
        if (String(repoFull).toLowerCase() !== `${user}/${DEFAULT_REPO}`.toLowerCase()) {
            clearRememberedRepo();
            throw new Error(`EverFree only supports ${user}/${DEFAULT_REPO}.`);
        }
        showView("app");
        try {
            const repoMeta = await gh("GET", `/repos/${repoFull}`);
            defaultBranch = repoMeta.default_branch || "main";
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
        noteModifiedCache[path] = Date.now();
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
        delete fileShas[path];
        delete noteContentCache[path];
        delete noteModifiedCache[path];
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

    async function getNoteLastModified(nb, noteName) {
        const path = `${nb}/${noteName}`;
        if (noteModifiedCache[path] !== undefined) {
            return noteModifiedCache[path];
        }
        try {
            const commits = await gh("GET", `/repos/${repoFull}/commits?path=${encodeURIComponent(path)}&per_page=1`);
            if (commits && commits.length > 0) {
                const time = new Date(commits[0].commit.committer.date).getTime();
                noteModifiedCache[path] = time;
                return time;
            }
        } catch (err) {
            console.error(`Failed to get modified date for ${path}:`, err);
        }
        return 0; // fallback
    }

    // ── Load Notebooks ──────────────────────────────────────
    async function loadNotebooks() {
        try {
            setSyncStatus("syncing", "Loading…");
            const root = await listContents("");
            notebooks = root
                .filter(item => item.type === "dir" && !item.name.startsWith("."))
                .map(item => item.name);

            // Fetch notes and their modified dates for each notebook in parallel
            notesByNotebook = {};
            const noteDates = {}; // "nb/note.md" -> timestamp
            const notebookLastModified = {}; // nb -> max timestamp

            await Promise.all(notebooks.map(async (nb) => {
                const items = await listContents(nb);
                const notes = items
                    .filter(item => item.type === "file" && item.name.endsWith(".md"))
                    .map(item => {
                        fileShas[`${nb}/${item.name}`] = item.sha;
                        return item.name;
                    });

                // Fetch commit date for each note in parallel
                await Promise.all(notes.map(async (noteName) => {
                    const mtime = await getNoteLastModified(nb, noteName);
                    noteDates[`${nb}/${noteName}`] = mtime;
                }));

                // Sort notes in this notebook by last modified descending, then parsed date, then alphabetically
                notes.sort((a, b) => {
                    const timeA = noteDates[`${nb}/${a}`] || 0;
                    const timeB = noteDates[`${nb}/${b}`] || 0;
                    if (timeA !== timeB) return timeB - timeA;
                    
                    const dateA = parseNoteNameDate(a);
                    const dateB = parseNoteNameDate(b);
                    if (dateA !== null && dateB !== null) return dateB - dateA;
                    if (dateA !== null) return -1;
                    if (dateB !== null) return 1;
                    
                    return a.localeCompare(b);
                });

                notesByNotebook[nb] = notes;

                // Track the latest modified note time for this notebook
                const maxTime = notes.length > 0 ? (noteDates[`${nb}/${notes[0]}`] || 0) : 0;
                notebookLastModified[nb] = maxTime;
            }));

            // Sort notebooks by their latest note's modified time, then parsed date, then alphabetically
            notebooks.sort((a, b) => {
                const timeA = notebookLastModified[a] || 0;
                const timeB = notebookLastModified[b] || 0;
                if (timeA !== timeB) return timeB - timeA;
                
                const newestA = notesByNotebook[a] && notesByNotebook[a][0];
                const newestB = notesByNotebook[b] && notesByNotebook[b][0];
                
                const dateA = newestA ? parseNoteNameDate(newestA) : null;
                const dateB = newestB ? parseNoteNameDate(newestB) : null;
                if (dateA !== null && dateB !== null) return dateB - dateA;
                if (dateA !== null) return -1;
                if (dateB !== null) return 1;
                
                return a.localeCompare(b);
            });

            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
        } catch (err) {
            console.error("Failed to load notebooks:", err);
            setSyncStatus("error", "Load failed");
        }
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
            <span class="note-card-title">${escapeHtml(noteTitleCache[`${item.notebook}/${item.note}`] || noteFilenameTitle(item.note))}</span>`;
        $note.addEventListener("click", () => openNote(item.notebook, item.note));
        loadNoteCardTitle($note, item);
        return $note;
    }

    function createNoteIn(nb) {
        showModal("New Note", `Create note in "${nb}"`, async (name) => {
            const noteName = name.endsWith(".md") ? name : name + ".md";
            setSyncStatus("syncing", "Creating…");
            await putFile(`${nb}/${noteName}`, `# ${name.replace(/\.md$/, "")}\n\n`, `Create note ${nb}/${noteName}`);
            await loadNotebooks();
            openNote(nb, noteName);
        });
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

    function cacheNoteTitle(notebook, note, content) {
        const path = `${notebook}/${note}`;
        const title = getNoteTitle(content, note);
        noteTitleCache[path] = title;
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

    function loadNoteCardTitle($card, item) {
        const path = `${item.notebook}/${item.note}`;
        if (Object.prototype.hasOwnProperty.call(noteTitleCache, path)) {
            $card.querySelector(".note-card-title").textContent = noteTitleCache[path];
            return;
        }

        getCachedFileContent(path).then((content) => {
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
    // and returns the note-relative path (assets/<file>) to embed — the same
    // form the local app and agent use, so the Markdown stays portable.
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
        const $button = $("btn-editor-image");
        const $input = $("editor-image-input");
        const $editorRoot = $("editor");
        if (!$button || !$input || !$editorRoot) return;

        $button.addEventListener("click", () => {
            $input.value = "";
            $input.click();
        });
        $input.addEventListener("change", () => {
            const file = $input.files && $input.files[0];
            if (file) uploadAndInsertImage(file);
        });

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
    async function openNote(notebook, note) {
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
            initEditor(content);
            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
            window.dispatchEvent(new CustomEvent("everfree:note-changed", { detail: { notebook, note } }));
        } catch (err) {
            console.error("Failed to open note:", err);
            alert("Failed to open note: " + err.message);
            setSyncStatus("error", "Load failed");
        }
    }

    function initEditor(content = "") {
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
    async function deleteNote() {
        if (!currentNotebook || !currentNote) return;
        if (!confirm(`Delete "${currentNote}"? This cannot be undone.`)) return;
        stopEditorDictation();

        try {
            setSyncStatus("syncing", "Deleting…");
            const path = `${currentNotebook}/${currentNote}`;
            await deleteFile(path, `Delete ${path}`);

            if (editor) { editor.destroy(); editor = null; }
            currentNote = null;
            isDirty = false;
            $("editor-container").style.display = "none";
            $("empty-state").style.display = "flex";
            document.body.classList.remove("mobile-edit");

            setSyncStatus("ok", repoFull);
            await loadNotebooks();
        } catch (err) {
            console.error("Delete failed:", err);
            alert("Failed to delete note: " + err.message);
            setSyncStatus("error", "Delete failed");
        }
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
            const otherWidth = other.element.getBoundingClientRect().width;
            const editorMin = 360;
            const maxAvailable = window.innerWidth - otherWidth - editorMin - 16;
            return {
                min: pane.min,
                max: Math.max(pane.min, Math.min(pane.max, maxAvailable)),
            };
        }

        function setPaneWidth(pane, width, persist = false) {
            const bounds = limits(pane);
            const next = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
            viewApp.style.setProperty(pane.cssVariable, `${next}px`);
            pane.handle.setAttribute("aria-valuemin", String(bounds.min));
            pane.handle.setAttribute("aria-valuemax", String(bounds.max));
            pane.handle.setAttribute("aria-valuenow", String(next));
            if (persist) localStorage.setItem(pane.storageKey, String(next));
        }

        for (const pane of Object.values(panes)) {
            const saved = Number(localStorage.getItem(pane.storageKey));
            if (Number.isFinite(saved) && saved > 0) setPaneWidth(pane, saved);

            pane.handle.addEventListener("pointerdown", (event) => {
                if (!viewportAllowsResize()) return;
                event.preventDefault();
                active.pane = pane;
                active.startX = event.clientX;
                active.startWidth = pane.element.getBoundingClientRect().width;
                pane.handle.classList.add("is-active");
                document.body.classList.add("resizing-panes");
                pane.handle.setPointerCapture?.(event.pointerId);
            });

            pane.handle.addEventListener("keydown", (event) => {
                if (!viewportAllowsResize()) return;
                const current = pane.element.getBoundingClientRect().width;
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
            setPaneWidth(pane, pane.element.getBoundingClientRect().width, true);
            pane.handle.classList.remove("is-active");
            document.body.classList.remove("resizing-panes");
            active.pane = null;
        }

        window.addEventListener("pointerup", stopResize);
        window.addEventListener("pointercancel", stopResize);
        window.addEventListener("resize", () => {
            for (const pane of Object.values(panes)) {
                setPaneWidth(pane, pane.element.getBoundingClientRect().width);
            }
        });
    }

    // ── Modal ───────────────────────────────────────────────
    let modalCallback = null;
    function showModal(title, placeholder, callback) {
        $("modal-title").textContent = title;
        $("modal-input").placeholder = placeholder;
        $("modal-input").value = "";
        modalCallback = callback;
        $("modal-overlay").style.display = "flex";
        setTimeout(() => $("modal-input").focus(), 50);
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
        showModal("New Notebook", "Notebook name…", async (name) => {
            setSyncStatus("syncing", "Creating notebook…");
            // Create a .gitkeep file in the new folder
            await putFile(`${name}/.gitkeep`, "", `Create notebook ${name}`);
            await loadNotebooks();
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

    // ── Assistant bridge ────────────────────────────────────
    // Lets assist.js read the open note and the user's selection without
    // reaching into this module's private state.
    window.EverFreeBridge = {
        getNote() {
            if (!currentNotebook || !currentNote || !editor) return null;
            return { notebook: currentNotebook, note: currentNote, content: editor.getMarkdown() };
        },
        getSelection() {
            if (!editor || !editor.getSelectedText) return "";
            try { return (editor.getSelectedText() || "").trim(); } catch { return ""; }
        },
        // Selection text plus its range, captured together so text generated
        // for it later can be placed after it even if focus moved meanwhile.
        getSelectionInfo() {
            if (!editor) return null;
            let text = "", range = null;
            try { text = (editor.getSelectedText() || "").trim(); } catch { /* no selection */ }
            try { range = editor.getSelection(); } catch { /* keep null */ }
            return { text, range };
        },
        // Insert text right after `range` (from getSelectionInfo), leaving the
        // selected text itself untouched. Falls back to the cursor position.
        insertAfterRange(range, text) {
            if (!editor) return false;
            try {
                if (range) editor.setSelection(range[1], range[1]);
            } catch { /* stale range: insert at cursor instead */ }
            editor.insertText(text);
            editor.focus();
            return true;
        },
        insertAtCursor(text) {
            if (!editor) return false;
            editor.insertText(text);
            editor.focus();
            return true;
        },
        // WYSIWYG insertText would show raw Markdown syntax literally, so
        // formatted passages are appended through setMarkdown instead.
        insertMarkdown(text) {
            if (!editor) return false;
            if (editor.isMarkdownMode && editor.isMarkdownMode()) {
                editor.insertText(text);
            } else {
                const md = editor.getMarkdown();
                editor.setMarkdown(md ? md.replace(/\s+$/, "") + "\n\n" + text + "\n" : text + "\n");
                editor.moveCursorToEnd();
            }
            editor.focus();
            return true;
        },
    };

    // ── Init ────────────────────────────────────────────────
    setupEditorDictation();
    setupImageHandling();
    setupPaneResizers();
    applyTheme(getInitialTheme());

    if (token && (!tokenExpiresAt || tokenExpiresAt <= Date.now())) {
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
