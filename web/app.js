/* ════════════════════════════════════════════════════════════
   EverFree — Web Client (GitHub-backed)
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    // ── Storage Keys ────────────────────────────────────────
    const LS_TOKEN = "everfree-token";
    const LS_USER = "everfree-user";
    const LS_REPO = "everfree-repo";
    const LS_THEME = "everfree-theme";
    const DEFAULT_REPO = "everfree-notes";
    const EVERFREE_REPO_DESCRIPTION_MARKER = "git-backed markdown notes";

    // ── State ───────────────────────────────────────────────
    let token = localStorage.getItem(LS_TOKEN) || null;
    let user = localStorage.getItem(LS_USER) || null;
    let repoFull = localStorage.getItem(LS_REPO) || null; // "owner/repo"
    let defaultBranch = "main";

    let notebooks = [];
    let notesByNotebook = {}; // notebook -> [{name, sha}]
    let fileShas = {}; // "notebook/note.md" -> sha
    let noteContentCache = {}; // "notebook/note.md" -> markdown
    let currentNotebook = null;
    let currentNote = null;
    let editor = null;
    let isDirty = false;
    let searchSeq = 0;

    let devicePollTimer = null;

    // ── DOM ─────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const viewSignin = $("view-signin");
    const viewRepoPicker = $("view-repo-picker");
    const viewApp = $("view-app");

    const signinIdle = $("signin-idle");
    const signinPending = $("signin-pending");
    const signinError = $("signin-error");

    // ── View Routing ────────────────────────────────────────
    function showView(name) {
        viewSignin.classList.add("hidden");
        viewRepoPicker.classList.add("hidden");
        viewApp.classList.add("hidden");
        if (name === "signin") viewSignin.classList.remove("hidden");
        else if (name === "repo-picker") viewRepoPicker.classList.remove("hidden");
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
                    localStorage.setItem(LS_TOKEN, token);
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
            localStorage.setItem(LS_USER, user);
            if (repoFull) {
                await enterApp();
            } else {
                await autoConnectRepo();
            }
        } catch (err) {
            showSigninError("Failed to fetch user: " + err.message);
        }
    }

    async function autoConnectRepo() {
        try {
            const repo = await findEverFreeRepo();
            if (repo) {
                rememberRepo(repo);
                await enterApp();
                return;
            }
            await createAndEnterDefaultRepo(DEFAULT_REPO);
        } catch (err) {
            console.warn("Repo auto-connect failed:", err);
            await showRepoPicker();
        }
    }

    async function createAndEnterDefaultRepo(repoName) {
        try {
            const repo = await gh("POST", "/user/repos", {
                name: repoName,
                private: true,
                description: "EverFree — Git-backed Markdown notes",
                auto_init: true,
            });
            rememberRepo(repo);
            await enterApp();
        } catch (err) {
            if (/422/.test(err.message)) {
                const repo = await gh("GET", `/repos/${user}/${repoName}`);
                rememberRepo(repo);
                await enterApp();
            } else {
                await showRepoPicker();
            }
        }
    }

    async function findEverFreeRepo() {
        try {
            return await gh("GET", `/repos/${user}/${DEFAULT_REPO}`);
        } catch (err) {
            if (!isNotFoundError(err)) throw err;
        }

        const repos = await fetchUserRepos();
        const candidates = repos
            .filter(isEverFreeRepo)
            .sort(compareEverFreeRepos);

        return candidates[0] || null;
    }

    async function fetchUserRepos() {
        const repos = [];
        for (let page = 1; page <= 10; page += 1) {
            const batch = await gh("GET", `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`);
            if (!Array.isArray(batch) || batch.length === 0) break;
            repos.push(...batch);
            if (batch.length < 100) break;
        }
        return repos;
    }

    function isEverFreeRepo(repo) {
        const name = String(repo.name || "").toLowerCase();
        const description = String(repo.description || "").toLowerCase();
        return name === DEFAULT_REPO ||
            (description.includes("everfree") && description.includes(EVERFREE_REPO_DESCRIPTION_MARKER));
    }

    function compareEverFreeRepos(a, b) {
        const scoreDiff = repoScore(b) - repoScore(a);
        if (scoreDiff) return scoreDiff;
        return new Date(b.pushed_at || b.updated_at || 0) - new Date(a.pushed_at || a.updated_at || 0);
    }

    function repoScore(repo) {
        const name = String(repo.name || "").toLowerCase();
        const description = String(repo.description || "").toLowerCase();
        let score = 0;
        if (name === DEFAULT_REPO) score += 100;
        if (description.includes(EVERFREE_REPO_DESCRIPTION_MARKER)) score += 40;
        if (description.includes("everfree")) score += 20;
        if (repo.private) score += 10;
        if (!repo.fork) score += 5;
        return score;
    }

    function rememberRepo(repo) {
        if (repoFull && repoFull !== repo.full_name) {
            resetRepoData();
        }
        repoFull = repo.full_name;
        defaultBranch = repo.default_branch || "main";
        localStorage.setItem(LS_REPO, repoFull);
    }

    function clearRememberedRepo() {
        repoFull = null;
        defaultBranch = "main";
        localStorage.removeItem(LS_REPO);
        resetRepoData();
    }

    function resetRepoData() {
        notebooks = [];
        notesByNotebook = {};
        fileShas = {};
        noteContentCache = {};
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
            throw new Error(data.message || `${method} ${path}: ${r.status}`);
        }
        return data;
    }

    // ── Repo Picker ─────────────────────────────────────────
    async function showRepoPicker() {
        showView("repo-picker");
        const $list = $("repo-list");
        $list.innerHTML = '<div class="repo-loading">Loading your repositories…</div>';

        try {
            const repos = await fetchUserRepos();
            renderRepoList(repos);

            $("repo-search").addEventListener("input", (e) => {
                const q = e.target.value.toLowerCase();
                const filtered = q
                    ? repos.filter(r => r.full_name.toLowerCase().includes(q))
                    : repos;
                renderRepoList(filtered);
            });
        } catch (err) {
            $list.innerHTML = `<div class="repo-empty">Failed to load repos: ${escapeHtml(err.message)}</div>`;
        }
    }

    function renderRepoList(repos) {
        const $list = $("repo-list");
        if (repos.length === 0) {
            $list.innerHTML = '<div class="repo-empty">No repositories found.</div>';
            return;
        }
        $list.innerHTML = "";
        for (const r of repos) {
            const $row = document.createElement("div");
            $row.className = "repo-row";
            $row.innerHTML = `
                <div class="repo-info">
                    <span class="repo-name">${escapeHtml(r.full_name)}</span>
                    <span class="repo-meta">
                        ${r.private ? '<span class="repo-private">private</span>' : ""}
                        <span>${escapeHtml(r.default_branch || "main")}</span>
                    </span>
                </div>
            `;
            $row.addEventListener("click", () => selectRepo(r));
            $list.appendChild($row);
        }
    }

    async function selectRepo(repo) {
        rememberRepo(repo);
        await enterApp();
    }

    // ── Sign Out ────────────────────────────────────────────
    function signOut() {
        token = null;
        user = null;
        repoFull = null;
        localStorage.removeItem(LS_TOKEN);
        localStorage.removeItem(LS_USER);
        localStorage.removeItem(LS_REPO);
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        resetRepoData();
        signinIdle.classList.remove("hidden");
        signinPending.classList.add("hidden");
        signinError.classList.add("hidden");
        showView("signin");
    }

    // ── Enter App ───────────────────────────────────────────
    async function enterApp() {
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
    }

    // ── Base64 (UTF-8 safe) ─────────────────────────────────
    function b64EncodeUnicode(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }
    function b64DecodeUnicode(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    // ── Load Notebooks ──────────────────────────────────────
    async function loadNotebooks() {
        try {
            setSyncStatus("syncing", "Loading…");
            const root = await listContents("");
            notebooks = root
                .filter(item => item.type === "dir" && !item.name.startsWith("."))
                .map(item => item.name)
                .sort();

            // Fetch notes for each notebook in parallel
            notesByNotebook = {};
            await Promise.all(notebooks.map(async (nb) => {
                const items = await listContents(nb);
                const notes = items
                    .filter(item => item.type === "file" && item.name.endsWith(".md"))
                    .map(item => {
                        fileShas[`${nb}/${item.name}`] = item.sha;
                        return item.name;
                    })
                    .sort();
                notesByNotebook[nb] = notes;
            }));

            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
        } catch (err) {
            console.error("Failed to load notebooks:", err);
            setSyncStatus("error", "Load failed");
        }
    }

    // ── Render Sidebar ──────────────────────────────────────
    async function renderSidebar(filter = "") {
        const query = filter.trim();
        if (query) {
            await renderSearchResults(query);
            return;
        }

        searchSeq += 1;
        const $list = $("notebook-list");
        $list.innerHTML = "";

        for (const nb of notebooks) {
            const notes = notesByNotebook[nb] || [];

            const $item = document.createElement("div");
            $item.className = "notebook-item";

            const $header = document.createElement("div");
            $header.className = "notebook-header";
            if (currentNotebook === nb) $header.classList.add("active", "expanded");

            $header.innerHTML = `
                <svg class="notebook-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
                <span class="notebook-name">${escapeHtml(nb)}</span>
                <span class="notebook-count">${notes.length}</span>
                <button class="notebook-add-note" title="New Note" data-notebook="${escapeAttr(nb)}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                </button>
            `;

            const $noteList = document.createElement("div");
            $noteList.className = "note-list";
            if (currentNotebook === nb) $noteList.classList.add("expanded");

            for (const note of notes) {
                const $note = document.createElement("div");
                $note.className = "note-item";
                if (currentNotebook === nb && currentNote === note) {
                    $note.classList.add("active");
                }
                $note.innerHTML = `<span class="note-item-icon">📄</span> ${escapeHtml(note.replace(/\.md$/, ""))}`;
                $note.addEventListener("click", () => openNote(nb, note));
                $noteList.appendChild($note);
            }

            $header.addEventListener("click", (e) => {
                if (e.target.closest(".notebook-add-note")) return;
                const isExpanded = $header.classList.toggle("expanded");
                $noteList.classList.toggle("expanded", isExpanded);
            });

            $header.querySelector(".notebook-add-note").addEventListener("click", (e) => {
                e.stopPropagation();
                showModal("New Note", `Note name (in "${nb}")`, async (name) => {
                    const noteName = name.endsWith(".md") ? name : name + ".md";
                    setSyncStatus("syncing", "Creating…");
                    await putFile(`${nb}/${noteName}`, `# ${name.replace(/\.md$/, "")}\n\n`, `Create note ${nb}/${noteName}`);
                    await loadNotebooks();
                    openNote(nb, noteName);
                });
            });

            $item.appendChild($header);
            $item.appendChild($noteList);
            $list.appendChild($item);
        }

        if (notebooks.length === 0) {
            $list.innerHTML = '<div class="notebook-loading">No notebooks yet. Click + to create one.</div>';
        }
    }

    async function renderSearchResults(query) {
        const seq = ++searchSeq;
        const $list = $("notebook-list");
        $list.innerHTML = '<div class="notebook-loading">Searching note contents…</div>';

        try {
            const results = await searchNotes(query);
            if (seq !== searchSeq) return;

            if (results.length === 0) {
                $list.innerHTML = '<div class="notebook-loading">No matching notes.</div>';
                return;
            }

            $list.innerHTML = "";
            const $header = document.createElement("div");
            $header.className = "search-results-header";
            $header.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
            $list.appendChild($header);

            for (const result of results) {
                const $note = document.createElement("div");
                $note.className = "note-item search-result-item";
                if (currentNotebook === result.notebook && currentNote === result.note) {
                    $note.classList.add("active");
                }
                $note.innerHTML = `
                    <span class="note-item-icon">📄</span>
                    <span class="search-result-body">
                        <span>${escapeHtml(result.title)}</span>
                        <span class="search-result-meta">${escapeHtml(result.notebook)}</span>
                        ${result.snippet ? `<span class="search-result-snippet">${escapeHtml(result.snippet)}</span>` : ""}
                    </span>
                `;
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
                const title = note.replace(/\.md$/, "");
                const content = await getCachedFileContent(path);
                const titleMatch = title.toLowerCase().includes(lowerQuery);
                const notebookMatch = nb.toLowerCase().includes(lowerQuery);
                const contentMatch = content.toLowerCase().includes(lowerQuery);

                if (!titleMatch && !notebookMatch && !contentMatch) continue;

                results.push({
                    notebook: nb,
                    note,
                    title,
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

    // ── Open Note ───────────────────────────────────────────
    async function openNote(notebook, note) {
        if (isDirty && !confirm("You have unsaved changes. Discard?")) return;

        try {
            setSyncStatus("syncing", "Loading note…");
            const path = `${notebook}/${note}`;
            const { content } = await getFile(path);

            currentNotebook = notebook;
            currentNote = note;
            isDirty = false;

            $("empty-state").style.display = "none";
            $("editor-container").style.display = "flex";
            $("note-breadcrumb").textContent = `${notebook} / ${note.replace(/\.md$/, "")}`;
            $("save-status").textContent = "";

            if (editor) { editor.destroy(); editor = null; }
            initEditor(content);
            renderSidebar($("search-input").value);
            setSyncStatus("ok", repoFull);
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
        });

        const isDark = (localStorage.getItem(LS_THEME) || "dark") === "dark";
        const tuiWrapper = document.querySelector(".toastui-editor-defaultUI");
        if (tuiWrapper) tuiWrapper.classList.toggle("toastui-editor-dark", isDark);

        editor.on("change", () => {
            if (!isDirty) {
                isDirty = true;
                const $s = $("save-status");
                $s.textContent = "Unsaved changes";
                $s.className = "save-status";
            }
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

        try {
            setSyncStatus("syncing", "Deleting…");
            const path = `${currentNotebook}/${currentNote}`;
            await deleteFile(path, `Delete ${path}`);

            if (editor) { editor.destroy(); editor = null; }
            currentNote = null;
            isDirty = false;
            $("editor-container").style.display = "none";
            $("empty-state").style.display = "flex";

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
    $("btn-signin-retry").addEventListener("click", () => {
        signinError.classList.add("hidden");
        signinIdle.classList.remove("hidden");
    });
    $("btn-signout-from-picker").addEventListener("click", signOut);
    $("btn-signout").addEventListener("click", signOut);
    $("btn-switch-repo").addEventListener("click", () => {
        $("account-popover").classList.add("hidden");
        clearRememberedRepo();
        showRepoPicker();
    });

    $("btn-account").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleAccountPopover();
    });

    $("btn-theme").addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "dark";
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

    $("btn-new-notebook").addEventListener("click", () => {
        showModal("New Notebook", "Notebook name…", async (name) => {
            setSyncStatus("syncing", "Creating notebook…");
            // Create a .gitkeep file in the new folder
            await putFile(`${name}/.gitkeep`, "", `Create notebook ${name}`);
            await loadNotebooks();
        });
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
    applyTheme(localStorage.getItem(LS_THEME) || "dark");

    if (token && user) {
        if (repoFull) {
            enterApp();
        } else {
            autoConnectRepo().catch(() => showView("signin"));
        }
    } else {
        showView("signin");
    }
})();
