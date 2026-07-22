/* ════════════════════════════════════════════════════════════
   EverFree — Frontend Application Logic (Git-Backed)
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    // ── State ───────────────────────────────────────────────
    let notebooks = [];
    let notesByNotebook = {};
    let selectedNotebook = null;
    let currentNotebook = null;
    let currentNote = null;
    let editor = null;
    let editorDictation = null;
    let isDirty = false;
    let searchSeq = 0;
    let noteBrowserRenderSeq = 0;
    const NOTE_CARD_BATCH_SIZE = 100;

    // ── DOM References ──────────────────────────────────────
    const $notebookList = document.getElementById("notebook-list");
    const $noteBrowserList = document.getElementById("note-browser-list");
    const $noteBrowserTitle = document.getElementById("note-browser-title");
    const $libraryTotal = document.getElementById("library-total");
    const $btnAllNotes = document.getElementById("btn-all-notes");
    const $btnNewNote = document.getElementById("btn-new-note");
    const $btnNewNotebookInline = document.getElementById("btn-new-notebook-inline");
    const $btnShowNotes = document.getElementById("btn-show-notes");
    const $btnRailSearch = document.getElementById("btn-rail-search");
    const $emptyState = document.getElementById("empty-state");
    const $editorContainer = document.getElementById("editor-container");
    const $breadcrumb = document.getElementById("note-breadcrumb");
    const $saveStatus = document.getElementById("save-status");
    const $btnEditorMic = document.getElementById("btn-editor-mic");
    const $btnSave = document.getElementById("btn-save");
    const $btnDeleteNote = document.getElementById("btn-delete-note");
    const $btnNewNotebook = document.getElementById("btn-new-notebook");
    const $btnTheme = document.getElementById("btn-theme");
    const $btnSync = document.getElementById("btn-sync");
    const $syncIndicator = document.getElementById("sync-indicator");
    const $syncText = document.getElementById("sync-text");
    const $searchInput = document.getElementById("search-input");
    const $modalOverlay = document.getElementById("modal-overlay");
    const $modalTitle = document.getElementById("modal-title");
    const $modalInput = document.getElementById("modal-input");
    const $modalSelect = document.getElementById("modal-select");
    const $modalCancel = document.getElementById("modal-cancel");
    const $modalConfirm = document.getElementById("modal-confirm");

    // ── API Helpers ─────────────────────────────────────────
    class ApiError extends Error {
        constructor(detail, status) {
            super(detail || `Request failed (${status})`);
            this.name = "ApiError";
            this.status = status;
            this.detail = detail;
        }
    }

    async function _request(method, url, body) {
        const opts = { method };
        if (body !== undefined) {
            opts.headers = { "Content-Type": "application/json" };
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        if (!r.ok) {
            let detail = `${method} ${url}: ${r.status}`;
            try { detail = (await r.json()).detail || detail; } catch { /* ignore */ }
            throw new ApiError(detail, r.status);
        }
        return r.json();
    }

    const API = {
        get: (url) => _request("GET", url),
        post: (url, body) => _request("POST", url, body || {}),
        put: (url, body) => _request("PUT", url, body || {}),
        del: (url) => _request("DELETE", url),
    };

    // ── Sync Status UI ──────────────────────────────────────
    // The backend now syncs in the background; the frontend just reflects the
    // worker's state, which it polls. State → (dot class, label).
    const SYNC_LABELS = {
        idle: ["ok", "Synced to GitHub"],
        syncing: ["syncing", "Syncing…"],
        offline: ["warn", "Offline — changes saved locally"],
        conflict: ["warn", "Synced — review conflict copies"],
        error: ["error", "Sync issue — retrying"],
        blocked: ["error", "Not syncing — action needed"],
        local: ["off", "Local only"],
    };

    let lastConflictCount = 0;
    let lastBlockedDetail = null;

    function setSyncStatus(state, text) {
        $syncIndicator.className = "sync-dot sync-" + state;
        $syncText.textContent = text;
    }

    function renderSyncState(data) {
        if (!data || data.git === false) {
            setSyncStatus("off", "Local only");
            return;
        }
        const status = data.status || "idle";
        const [dot, label] = SYNC_LABELS[status] || SYNC_LABELS.idle;

        // A blocked sync will never clear on its own, so it takes priority over
        // the "saved locally" reassurance and states the fault in full.
        if (status === "blocked") {
            setSyncStatus(dot, label);
            $syncText.title = data.detail || "";
            showBlockedBanner(data);
            return;
        }
        hideBlockedBanner();
        $syncText.title = "";

        let text = data.pending && status !== "syncing" ? "Saved locally" : label;
        if (status === "idle" && !data.remote) {
            setSyncStatus("warn", "Git repo (no remote)");
            return;
        }
        setSyncStatus(dot, text);

        const conflicts = data.conflicts || [];
        if (conflicts.length > lastConflictCount) {
            showConflictBanner(conflicts);
        }
        if (conflicts.length === 0) hideConflictBanner();
        lastConflictCount = conflicts.length;
    }

    async function pollSyncStatus() {
        try {
            renderSyncState(await API.get("/api/sync/status"));
        } catch {
            setSyncStatus("off", "Local only");
        }
    }

    async function triggerSync() {
        setSyncStatus("syncing", "Syncing…");
        try {
            await API.post("/api/sync", {});
            // Reflect progress shortly after the worker picks it up.
            setTimeout(pollSyncStatus, 800);
            setTimeout(() => { pollSyncStatus(); loadNotebooks(); }, 2500);
        } catch (err) {
            setSyncStatus("error", "Sync failed");
            console.error("Sync error:", err);
        }
    }

    // ── Conflict banner ─────────────────────────────────────
    // When a note was edited on two devices at once, the worker keeps the local
    // copy and saves the remote one as a "conflicted copy" note. Tell the user
    // rather than dead-ending them in the terminal.
    function showConflictBanner(conflicts) {
        let $banner = document.getElementById("conflict-banner");
        if (!$banner) {
            $banner = document.createElement("div");
            $banner.id = "conflict-banner";
            $banner.className = "conflict-banner";
            document.body.appendChild($banner);
        }
        const names = conflicts
            .map((p) => p.split("/").pop().replace(/\.md$/, ""))
            .slice(0, 5)
            .join(", ");
        $banner.innerHTML = `
            <span>⚠️ ${conflicts.length} note${conflicts.length === 1 ? " was" : "s were"} edited elsewhere too.
            Your version was kept; the other was saved as a “conflicted copy”: ${escapeHtml(names)}.</span>
            <button id="conflict-dismiss">Got it</button>`;
        $banner.querySelector("#conflict-dismiss").addEventListener("click", async () => {
            try { await API.post("/api/sync/conflicts/clear", {}); } catch { /* ignore */ }
            hideConflictBanner();
            lastConflictCount = 0;
        });
    }

    function hideConflictBanner() {
        const $banner = document.getElementById("conflict-banner");
        if ($banner) $banner.remove();
    }

    // ── Blocked-sync banner ─────────────────────────────────
    // A revoked sign-in or a remote we refuse to sync stops backups until the
    // user acts. The old UI showed "Sync issue — retrying" and dropped the
    // explanation, so a stalled backup looked like a passing hiccup. This says
    // what broke, that the notes are still safe locally, and how to fix it.
    const BLOCKED_ACTIONS = {
        reauth: ["Sign in again", "/setup"],
        remote: ["Open setup", "/setup"],
    };

    function showBlockedBanner(data) {
        const detail = data.detail || "Sync is blocked.";
        // Only rebuild when the message changes, so the button stays clickable.
        if (lastBlockedDetail === detail && document.getElementById("blocked-banner")) return;
        lastBlockedDetail = detail;

        let $banner = document.getElementById("blocked-banner");
        if (!$banner) {
            $banner = document.createElement("div");
            $banner.id = "blocked-banner";
            $banner.className = "conflict-banner blocked-banner";
            document.body.appendChild($banner);
        }
        const [actionLabel, actionHref] = BLOCKED_ACTIONS[data.action] || [];
        const actionButton = actionLabel
            ? `<button id="blocked-action">${escapeHtml(actionLabel)}</button>`
            : "";
        $banner.innerHTML = `
            <span>⛔ Not syncing to GitHub. ${escapeHtml(detail)}
            Your notes are still saved on this Mac.</span>
            ${actionButton}
            <button id="blocked-retry">Retry</button>`;

        if (actionLabel) {
            $banner.querySelector("#blocked-action").addEventListener("click", () => {
                window.location.href = actionHref;
            });
        }
        $banner.querySelector("#blocked-retry").addEventListener("click", () => {
            triggerSync().catch(() => {});
        });
    }

    function hideBlockedBanner() {
        const $banner = document.getElementById("blocked-banner");
        if ($banner) $banner.remove();
        lastBlockedDetail = null;
    }

    // ── Load notebooks ──────────────────────────────────────
    async function loadNotebooks() {
        try {
            const library = await API.get("/api/library");
            notebooks = library.notebooks || [];
            notesByNotebook = library.notes || {};
            if (currentNotebook && notebooks.includes(currentNotebook)) {
                selectedNotebook = currentNotebook;
            } else if (selectedNotebook && !notebooks.includes(selectedNotebook)) {
                selectedNotebook = null;
            }
            renderSidebar($searchInput.value);
        } catch (err) {
            console.error("Failed to load notebooks:", err);
        }
    }

    // ── Render notebook library + note browser ──────────────
    async function renderSidebar(filter = "") {
        const query = filter.trim();
        renderNotebookLibrary();
        if (query) {
            await renderSearchResults(query);
            return;
        }

        searchSeq += 1;
        renderNoteBrowser();
    }

    function renderNotebookLibrary() {
        $notebookList.innerHTML = "";
        const total = notebooks.reduce((sum, nb) => sum + (notesByNotebook[nb] || []).length, 0);
        $libraryTotal.textContent = total ? String(total) : "";
        $btnAllNotes.classList.toggle("active", !selectedNotebook);

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
                </button>
            `;

            $header.addEventListener("click", (e) => {
                if (e.target.closest(".notebook-add-note")) return;
                selectedNotebook = nb;
                $searchInput.value = "";
                renderSidebar();
            });

            $header.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                showNotebookMenu(e, nb);
            });

            const $addBtn = $header.querySelector(".notebook-add-note");
            $addBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                showModal("New Note", `Create note in "${nb}"`, async (name) => {
                    await API.post(`/api/notebooks/${encodeURIComponent(nb)}/notes`, { name });
                    await loadNotebooks();
                    const noteName = name.endsWith(".md") ? name : name + ".md";
                    openNote(nb, noteName);
                });
            });

            $notebookList.appendChild($header);
        }
    }

    function renderNoteBrowser() {
        const renderSeq = ++noteBrowserRenderSeq;
        const visible = selectedNotebook
            ? (notesByNotebook[selectedNotebook] || []).map((note) => ({ notebook: selectedNotebook, note }))
            : notebooks.flatMap((notebook) => (notesByNotebook[notebook] || []).map((note) => ({ notebook, note })));

        $noteBrowserTitle.textContent = selectedNotebook || "All notes";
        $noteBrowserList.innerHTML = "";

        if (visible.length === 0) {
            $noteBrowserList.innerHTML = '<div class="notebook-loading">No notes here yet.</div>';
            return;
        }

        function appendBatch(start) {
            if (renderSeq !== noteBrowserRenderSeq) return;
            const fragment = document.createDocumentFragment();
            const end = Math.min(start + NOTE_CARD_BATCH_SIZE, visible.length);
            for (let i = start; i < end; i += 1) {
                fragment.appendChild(createNoteCard(visible[i]));
            }
            $noteBrowserList.appendChild(fragment);
            if (end < visible.length) {
                requestAnimationFrame(() => appendBatch(end));
            }
        }

        appendBatch(0);
    }

    function createNoteCard(item) {
        const $note = document.createElement("button");
        $note.type = "button";
        $note.className = "note-card";
        if (currentNotebook === item.notebook && currentNote === item.note) {
            $note.classList.add("active");
        }
        $note.innerHTML = `
            <span class="note-card-title">${escapeHtml(item.note.replace(/\.md$/, ""))}</span>`;
        $note.addEventListener("click", () => openNote(item.notebook, item.note));
        $note.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showNoteMenu(e, item.notebook, item.note);
        });
        return $note;
    }

    async function renderSearchResults(query) {
        noteBrowserRenderSeq += 1;
        const seq = ++searchSeq;
        $noteBrowserTitle.textContent = "Search";
        $noteBrowserList.innerHTML = '<div class="notebook-loading">Searching…</div>';

        try {
            const results = await API.get(`/api/search?q=${encodeURIComponent(query)}`);
            if (seq !== searchSeq) return;

            if (results.length === 0) {
                $noteBrowserList.innerHTML = '<div class="notebook-loading">No matching notes.</div>';
                return;
            }

            $noteBrowserList.innerHTML = "";
            const $header = document.createElement("div");
            $header.className = "search-results-header";
            $header.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
            $noteBrowserList.appendChild($header);

            for (const result of results) {
                const $item = document.createElement("button");
                $item.type = "button";
                $item.className = "note-card search-result-item";
                if (currentNotebook === result.notebook && currentNote === result.note) {
                    $item.classList.add("active");
                }
                const title = result.title || result.note.replace(/\.md$/, "");
                $item.innerHTML = `
                    <span class="search-result-body">
                        <span class="note-card-title">${highlight(title, query)}</span>
                        <span class="search-result-meta">${escapeHtml(result.notebook)}</span>
                        ${result.snippet ? `<span class="search-result-snippet">${highlight(result.snippet, query)}</span>` : ""}
                    </span>
                `;
                $item.addEventListener("click", () => openNote(result.notebook, result.note));
                $noteBrowserList.appendChild($item);
            }
        } catch (err) {
            if (seq !== searchSeq) return;
            console.error("Search failed:", err);
            $noteBrowserList.innerHTML = '<div class="notebook-loading">Search failed.</div>';
        }
    }

    // ── Open a Note ─────────────────────────────────────────
    async function openNote(notebook, note) {
        if (isDirty && !confirm("You have unsaved changes. Discard?")) return;
        stopEditorDictation();

        try {
            const data = await API.get(
                `/api/notebooks/${encodeURIComponent(notebook)}/notes/${encodeURIComponent(note)}`
            );

            currentNotebook = notebook;
            selectedNotebook = notebook;
            currentNote = note;
            isDirty = false;

            $emptyState.style.display = "none";
            $editorContainer.style.display = "flex";
            // Phone single-pane: hand the screen to the editor (CSS-gated to mobile).
            document.body.classList.add("mobile-edit");
            $breadcrumb.textContent = `${notebook} / ${note.replace(/\.md$/, "")}`;
            $saveStatus.textContent = "";

            if (editor) {
                editor.destroy();
                editor = null;
            }

            initEditor(data.content);
            renderSidebar($searchInput.value);
            window.dispatchEvent(new CustomEvent("everfree:note-changed", {
                detail: { notebook, note },
            }));
        } catch (err) {
            console.error("Failed to open note:", err);
            alert("Failed to open note.");
        }
    }

    // ── Initialize Toast UI Editor (WYSIWYG) ─────────────────
    function initEditor(content = "") {
        editor = new toastui.Editor({
            el: document.getElementById("editor"),
            height: "100%",
            initialEditType: "wysiwyg",
            initialValue: content,
            placeholder: "Start writing…",
            hooks: {
                // Paste or drag-drop an image: upload the blob to the notebook's
                // assets/ folder and insert it as a note-relative path (the same
                // form the agent uses), so it renders here and stays portable in
                // the synced Markdown. Returning false prevents Toast UI's default
                // base64 inlining.
                addImageBlobHook(blob, callback) {
                    uploadImageBlob(blob).then((relPath) => {
                        if (!relPath) return;
                        callback(relPath, blob.name || "image");
                        // Re-render from Markdown so customHTMLRenderer maps the
                        // relative assets/ path to the local /notes/ route — a
                        // freshly inserted node keeps the raw src and won't load.
                        requestAnimationFrame(() => {
                            if (editor) editor.setMarkdown(editor.getMarkdown());
                        });
                    });
                    return false;
                },
            },
            customHTMLRenderer: {
                // Resolve note-relative image paths (e.g. assets/foo.png) against
                // the local server's /notes/<notebook>/ route so they render.
                image(node, context) {
                    const result = context.origin();
                    const src = node.destination || "";
                    if (result && currentNotebook && !/^(https?:|data:|\/)/.test(src)) {
                        result.attributes.src =
                            `/notes/${encodeURIComponent(currentNotebook)}/` +
                            src.split("/").map(encodeURIComponent).join("/");
                    }
                    return result;
                },
            },
        });

        // Apply current theme to the newly created editor
        const isDark = (localStorage.getItem("everfree-theme") || "light") === "dark";
        const tuiWrapper = document.querySelector(".toastui-editor-defaultUI");
        if (tuiWrapper) tuiWrapper.classList.toggle("toastui-editor-dark", isDark);

        editor.on("change", () => {
            changeSeq += 1;
            if (!isDirty) {
                isDirty = true;
                $saveStatus.textContent = "Unsaved changes";
                $saveStatus.className = "save-status";
            }
            scheduleAutosave();
        });
    }

    // ── Image paste / drag-drop upload ──────────────────────
    // Uploads the blob to the open note's assets/ folder; returns the
    // note-relative path (assets/<file>) to embed, or null on failure.
    async function uploadImageBlob(blob) {
        if (!currentNotebook) {
            alert("Open a note before adding an image.");
            return null;
        }
        if (!blob || !/^image\//.test(blob.type || "")) {
            alert("Only image files can be added.");
            return null;
        }
        try {
            const r = await fetch(`/api/notebooks/${encodeURIComponent(currentNotebook)}/assets`, {
                method: "POST",
                headers: { "Content-Type": blob.type },
                body: blob,
            });
            if (!r.ok) {
                let detail = `Upload failed (${r.status})`;
                try { detail = (await r.json()).detail || detail; } catch { /* ignore */ }
                throw new Error(detail);
            }
            return (await r.json()).rel_path;
        } catch (err) {
            console.error("Image upload failed:", err);
            alert("Couldn't add image: " + (err.message || err));
            return null;
        }
    }

    // ── Editor voice input ──────────────────────────────────
    function setEditorMicActive(active) {
        if (!$btnEditorMic) return;
        $btnEditorMic.classList.toggle("is-listening", active);
        $btnEditorMic.setAttribute("aria-pressed", active ? "true" : "false");
        $btnEditorMic.title = active ? "Stop dictation" : "Dictate into note (voice input)";
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
        if (!$btnEditorMic) return;
        if (typeof window.createDictation !== "function" || !window.voiceInputSupported) {
            $btnEditorMic.disabled = true;
            $btnEditorMic.title = "Voice input is not supported in this browser";
            $btnEditorMic.setAttribute("aria-disabled", "true");
            return;
        }

        editorDictation = window.createDictation({
            onFinal: appendDictationToEditor,
            onState: setEditorMicActive,
            onError(error) {
                setEditorMicActive(false);
                $saveStatus.textContent =
                    error === "not-allowed"
                        ? "Microphone permission denied"
                        : error === "audio-capture"
                            ? "No microphone found"
                            : "Voice input stopped";
                $saveStatus.className = "save-status";
            },
        });
        if (!editorDictation) {
            $btnEditorMic.disabled = true;
            $btnEditorMic.title = "Voice input is not supported in this browser";
            $btnEditorMic.setAttribute("aria-disabled", "true");
            return;
        }

        $btnEditorMic.setAttribute("aria-pressed", "false");
        $btnEditorMic.addEventListener("click", () => {
            if (!currentNotebook || !currentNote || !editor) return;
            editorDictation.toggle();
        });
    }

    // ── Autosave ────────────────────────────────────────────
    // Writes to disk are instant. GitHub pushes happen only on explicit Save,
    // explicit Sync, or clean server shutdown.
    let autosaveTimer = null;
    let changeSeq = 0;          // bumped on every edit
    let writerActive = false;   // true while the single save-writer loop runs
    let writerPromise = Promise.resolve();
    const AUTOSAVE_DELAY = 1200;

    function scheduleAutosave() {
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => { saveNote({ auto: true }).catch(() => {}); }, AUTOSAVE_DELAY);
    }

    // ── Save Note ───────────────────────────────────────────
    // Exactly one writer runs at a time. It keeps issuing PUTs until the latest
    // edit (tracked by changeSeq) is persisted, so edits made while a save is in
    // flight are never dropped. The writerActive flag is checked and set
    // synchronously (no await between), so concurrent callers — repeated Cmd+S,
    // autosave, rename — all share the same writer rather than spawning rivals.
    function startWriter() {
        if (!writerActive) {
            writerActive = true;
            writerPromise = (async () => {
                try {
                    while (currentNote && isDirty) {
                        await _doSaveOnce();   // throws on PUT failure
                    }
                } finally {
                    writerActive = false;
                }
            })();
        }
        return writerPromise;
    }

    async function saveNote(opts = {}) {
        if (!currentNotebook || !currentNote || !editor) return;
        clearTimeout(autosaveTimer);
        if (isDirty) {
            await startWriter();    // rejects if a PUT fails, so callers can react
        }
        if (opts.sync) {
            await triggerSync();
        }
    }

    async function _doSaveOnce() {
        const savingNotebook = currentNotebook;
        const savingNote = currentNote;
        // Snapshot content and the edit counter together (no await between) so we
        // can tell whether the user typed more while this PUT was in flight.
        const seqAtSave = changeSeq;
        const content = editor.getMarkdown();
        $saveStatus.textContent = "Saving…";
        $saveStatus.className = "save-status";
        try {
            await API.put(
                `/api/notebooks/${encodeURIComponent(savingNotebook)}/notes/${encodeURIComponent(savingNote)}`,
                { content }
            );
        } catch (err) {
            console.error("Save failed:", err);
            $saveStatus.textContent = "⚠ Save failed";
            $saveStatus.className = "save-status";
            throw err;              // propagate; the writer loop stops and callers see it
        }

        // Mark clean only if still on the same note AND nothing changed since the
        // snapshot. Otherwise leave isDirty true so the writer loop iterates again.
        if (currentNotebook === savingNotebook && currentNote === savingNote && changeSeq === seqAtSave) {
            isDirty = false;
            $saveStatus.textContent = "✓ Saved";
            $saveStatus.className = "save-status saved";
            setTimeout(() => { if (!isDirty) $saveStatus.textContent = ""; }, 2000);
        }
    }

    // Wait for any in-flight save writer to finish, without disturbing the open
    // note's pending autosave. Use this before mutating an UNRELATED note/path
    // so the open note's scheduled autosave still fires and its edits aren't
    // orphaned. (When the mutation targets the open note itself, callers clear
    // its autosave timer explicitly and either save or discard it.)
    async function waitForWriter() {
        await writerPromise.catch(() => {});
    }

    // ── Delete Note ─────────────────────────────────────────
    async function deleteNote() {
        if (!currentNotebook || !currentNote) return;
        if (!confirm(`Delete "${currentNote.replace(/\.md$/, "")}"? It stays recoverable in your Git history.`)) return;
        const nb = currentNotebook, nt = currentNote;
        // Deleting the open note: cancel its autosave (discarding it), wait for
        // any in-flight save, then drop local state so nothing targets it.
        clearTimeout(autosaveTimer);
        await waitForWriter();
        if (editor) { editor.destroy(); editor = null; }
        currentNote = null;
        isDirty = false;
        $editorContainer.style.display = "none";
        $emptyState.style.display = "flex";
        document.body.classList.remove("mobile-edit");
        try {
            await API.del(`/api/notebooks/${encodeURIComponent(nb)}/notes/${encodeURIComponent(nt)}`);
            await loadNotebooks();
        } catch (err) {
            console.error("Delete failed:", err);
            alert("Failed to delete note: " + (err.detail || err.message));
        }
    }

    // ── Context menu (rename / move / delete) ────────────────
    function closeContextMenu() {
        const existing = document.getElementById("context-menu");
        if (existing) existing.remove();
    }

    function showContextMenu(event, items) {
        closeContextMenu();
        const $menu = document.createElement("div");
        $menu.id = "context-menu";
        $menu.className = "context-menu";
        for (const item of items) {
            const $btn = document.createElement("button");
            $btn.className = "context-menu-item" + (item.danger ? " danger" : "");
            $btn.textContent = item.label;
            $btn.addEventListener("click", () => {
                closeContextMenu();
                item.action();
            });
            $menu.appendChild($btn);
        }
        document.body.appendChild($menu);
        const { innerWidth: w, innerHeight: h } = window;
        const rect = $menu.getBoundingClientRect();
        $menu.style.left = Math.min(event.clientX, w - rect.width - 8) + "px";
        $menu.style.top = Math.min(event.clientY, h - rect.height - 8) + "px";
    }

    function showNoteMenu(event, notebook, note) {
        const base = note.replace(/\.md$/, "");
        const isCurrent = () => currentNotebook === notebook && currentNote === note;

        // Fully persist the open note's latest content to its OLD path before we
        // rename/move it. saveNote() runs the writer loop until the latest edit
        // is saved (changeSeq matched) and throws if a PUT fails — in which case
        // we propagate so the caller aborts the rename instead of moving stale
        // content. Returns true if the note being acted on is the open one.
        async function settleCurrent() {
            // Unrelated note: just wait for any active writer; leave the open
            // note's autosave alone so its edits still get saved.
            if (!isCurrent()) { await waitForWriter(); return false; }
            clearTimeout(autosaveTimer);
            await saveNote();   // no-op if already clean; throws on failure
            return true;
        }

        showContextMenu(event, [
            {
                label: "Rename…",
                action: () => showModal("Rename Note", "New name…", async (name) => {
                    const wasCurrent = await settleCurrent();
                    const res = await API.post(
                        `/api/notebooks/${encodeURIComponent(notebook)}/notes/${encodeURIComponent(note)}/rename`,
                        { new_name: name });
                    await loadNotebooks();
                    if (wasCurrent) openNote(notebook, res.note);
                }, { value: base }),
            },
            {
                label: "Move to…",
                action: () => showModal("Move Note", "", async (target) => {
                    const wasCurrent = await settleCurrent();
                    await API.post(
                        `/api/notebooks/${encodeURIComponent(notebook)}/notes/${encodeURIComponent(note)}/move`,
                        { target_notebook: target });
                    await loadNotebooks();
                    if (wasCurrent) openNote(target, note);
                }, { select: notebooks.filter((n) => n !== notebook) }),
            },
            {
                label: "Delete",
                danger: true,
                action: async () => {
                    if (!confirm(`Delete "${base}"? It stays recoverable in your Git history.`)) return;
                    if (isCurrent()) {
                        clearTimeout(autosaveTimer);   // discard the open note's autosave
                        await waitForWriter();
                        if (editor) { editor.destroy(); editor = null; }
                        currentNote = null;
                        isDirty = false;
                        $editorContainer.style.display = "none";
                        $emptyState.style.display = "flex";
                        document.body.classList.remove("mobile-edit");
                    } else {
                        await waitForWriter();         // unrelated note: keep open note's autosave
                    }
                    await API.del(`/api/notebooks/${encodeURIComponent(notebook)}/notes/${encodeURIComponent(note)}`);
                    await loadNotebooks();
                },
            },
        ]);
    }

    function showNotebookMenu(event, notebook) {
        const hasOpenNote = () => currentNotebook === notebook && currentNote;
        showContextMenu(event, [
            {
                label: "Rename…",
                action: () => showModal("Rename Notebook", "New name…", async (name) => {
                    const reopen = hasOpenNote() ? currentNote : null;
                    // Persist the open note fully before moving its folder; throws
                    // (aborting the rename) if the save fails. If the open note is
                    // in a different notebook, leave its autosave untouched.
                    if (hasOpenNote()) { clearTimeout(autosaveTimer); await saveNote(); }
                    else await waitForWriter();
                    const res = await API.post(
                        `/api/notebooks/${encodeURIComponent(notebook)}/rename`, { new_name: name });
                    if (currentNotebook === notebook) currentNotebook = res.name;
                    if (selectedNotebook === notebook) selectedNotebook = res.name;
                    await loadNotebooks();
                    if (reopen) openNote(res.name, reopen);
                }, { value: notebook }),
            },
            {
                label: "Delete notebook",
                danger: true,
                action: async () => {
                    if (!confirm(`Delete notebook "${notebook}" and all its notes? Recoverable in your Git history.`)) return;
                    if (currentNotebook === notebook) {
                        clearTimeout(autosaveTimer);   // discard the open note's autosave
                        await waitForWriter();
                        if (editor) { editor.destroy(); editor = null; }
                        currentNotebook = null;
                        currentNote = null;
                        if (selectedNotebook === notebook) selectedNotebook = null;
                        isDirty = false;
                        $editorContainer.style.display = "none";
                        $emptyState.style.display = "flex";
                        document.body.classList.remove("mobile-edit");
                    } else {
                        await waitForWriter();         // unrelated notebook: keep open note's autosave
                    }
                    await API.del(`/api/notebooks/${encodeURIComponent(notebook)}`);
                    await loadNotebooks();
                },
            },
        ]);
    }

    // ── Modal ───────────────────────────────────────────────
    let modalCallback = null;
    let modalIsSelect = false;

    function showModal(title, placeholder, callback, opts = {}) {
        $modalTitle.textContent = title;
        modalCallback = callback;
        modalIsSelect = Array.isArray(opts.select);

        if (modalIsSelect) {
            $modalInput.style.display = "none";
            $modalSelect.style.display = "block";
            $modalSelect.innerHTML = "";
            for (const name of opts.select) {
                const $opt = document.createElement("option");
                $opt.value = name;
                $opt.textContent = name;
                $modalSelect.appendChild($opt);
            }
        } else {
            $modalSelect.style.display = "none";
            $modalInput.style.display = "block";
            $modalInput.placeholder = placeholder;
            $modalInput.value = opts.value || "";
        }

        $modalOverlay.style.display = "flex";
        setTimeout(() => {
            if (modalIsSelect) {
                $modalSelect.focus();
            } else {
                $modalInput.focus();
                $modalInput.select();
            }
        }, 50);
    }

    function hideModal() {
        $modalOverlay.style.display = "none";
        modalCallback = null;
    }

    async function confirmModal() {
        const value = (modalIsSelect ? $modalSelect.value : $modalInput.value).trim();
        if (!value || !modalCallback) return;
        const cb = modalCallback;
        try {
            await cb(value);
            hideModal();
        } catch (err) {
            console.error("Modal action failed:", err);
            alert((err && err.detail) || "Operation failed. Please try again.");
        }
    }

    // ── Search ──────────────────────────────────────────────
    let searchTimeout = null;
    function onSearch() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            renderSidebar($searchInput.value);
        }, 200);
    }

    // ── Utility ─────────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // Escape first, then wrap query matches in <mark> so highlighting is XSS-safe.
    function highlight(text, query) {
        const safe = escapeHtml(text);
        const q = (query || "").trim();
        if (!q) return safe;
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return safe.replace(new RegExp(escaped, "gi"), (m) => `<mark>${m}</mark>`);
    }

    // ── Theme ────────────────────────────────────────────────
    const $tuiDarkCss = document.getElementById("tui-dark-css");

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        const isDark = theme === "dark";
        $tuiDarkCss.disabled = !isDark;
        // Toast UI Editor dark mode requires this class on its wrapper
        const tuiWrapper = document.querySelector(".toastui-editor-defaultUI");
        if (tuiWrapper) tuiWrapper.classList.toggle("toastui-editor-dark", isDark);
        document.getElementById("theme-icon-dark").style.display = isDark ? "block" : "none";
        document.getElementById("theme-icon-light").style.display = isDark ? "none" : "block";
        localStorage.setItem("everfree-theme", theme);
    }

    $btnTheme.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "light";
        applyTheme(current === "dark" ? "light" : "dark");
    });

    // Apply saved theme on load (default: light)
    applyTheme(localStorage.getItem("everfree-theme") || "light");

    // ── Event Bindings ──────────────────────────────────────
    $btnSave.addEventListener("click", () => saveNote({ sync: true }).catch(() => {}));
    $btnDeleteNote.addEventListener("click", deleteNote);
    $btnSync.addEventListener("click", triggerSync);
    // Phone single-pane: return from the editor to the note list.
    const $btnMobileBack = document.getElementById("btn-mobile-back");
    if ($btnMobileBack) {
        $btnMobileBack.addEventListener("click", () => {
            document.body.classList.remove("mobile-edit");
        });
    }
    $modalCancel.addEventListener("click", hideModal);
    $modalConfirm.addEventListener("click", confirmModal);
    $searchInput.addEventListener("input", onSearch);

    $modalOverlay.addEventListener("click", (e) => {
        if (e.target === $modalOverlay) hideModal();
    });

    $modalInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmModal();
        if (e.key === "Escape") hideModal();
    });

    $btnNewNotebook.addEventListener("click", () => {
        showModal("New Notebook", "Notebook name…", async (name) => {
            await API.post("/api/notebooks", { name });
            selectedNotebook = name;
            await loadNotebooks();
        });
    });

    $btnNewNotebookInline.addEventListener("click", () => $btnNewNotebook.click());

    $btnAllNotes.addEventListener("click", () => {
        selectedNotebook = null;
        $searchInput.value = "";
        renderSidebar();
    });

    $btnNewNote.addEventListener("click", () => {
        const notebook = selectedNotebook || currentNotebook || notebooks[0];
        if (!notebook) {
            $btnNewNotebook.click();
            return;
        }
        showModal("New Note", `Create note in "${notebook}"`, async (name) => {
            await API.post(`/api/notebooks/${encodeURIComponent(notebook)}/notes`, { name });
            await loadNotebooks();
            const noteName = name.endsWith(".md") ? name : name + ".md";
            openNote(notebook, noteName);
        });
    });

    $btnShowNotes.addEventListener("click", () => {
        document.getElementById("assist-close-btn")?.click();
    });

    $btnRailSearch.addEventListener("click", () => {
        document.getElementById("assist-close-btn")?.click();
        setTimeout(() => $searchInput.focus(), 50);
    });

    $modalSelect.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmModal();
        if (e.key === "Escape") hideModal();
    });

    // Dismiss the context menu on any outside click / escape / scroll.
    document.addEventListener("click", closeContextMenu);
    document.addEventListener("scroll", closeContextMenu, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeContextMenu();
    });

    // Ctrl/Cmd + S
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            saveNote({ sync: true }).catch(() => {});
        }
    });

    // Warn before leaving with unsaved changes
    window.addEventListener("beforeunload", (e) => {
        if (isDirty) {
            e.preventDefault();
            e.returnValue = "";
        }
    });

    // ── Bridge for the writing assistant panel (assist.js) ──
    window.EverFreeBridge = {
        getNote() {
            if (!currentNotebook || !currentNote || !editor) return null;
            return { notebook: currentNotebook, note: currentNote, content: editor.getMarkdown() };
        },
        getSelection() {
            if (!editor) return "";
            try {
                return (editor.getSelectedText() || "").trim();
            } catch {
                return "";
            }
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
            if (editor.isMarkdownMode()) {
                editor.insertText(text);
            } else {
                const md = editor.getMarkdown();
                editor.setMarkdown(md ? md.replace(/\s+$/, "") + "\n\n" + text + "\n" : text + "\n");
                editor.moveCursorToEnd();
            }
            editor.focus();
            return true;
        },
        insertImage(relPath, altText) {
            if (!editor) return false;
            editor.exec("addImage", { imageUrl: relPath, altText: altText || "image" });
            editor.focus();
            return true;
        },
        saveNote,
        // Lets the assistant surface a note it just created with create_note.
        refreshLibrary() {
            loadNotebooks();
        },
    };

    // ── Init ────────────────────────────────────────────────
    setupEditorDictation();
    loadNotebooks();
    pollSyncStatus();
    // Reflect the background sync worker's state (and remote edits pulled in).
    setInterval(pollSyncStatus, 5000);
})();
