/* ════════════════════════════════════════════════════════════
   EverFree — Frontend Application Logic (Git-Backed)
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    // ── State ───────────────────────────────────────────────
    let notebooks = [];
    let currentNotebook = null;
    let currentNote = null;
    let editor = null;
    let isDirty = false;

    // ── DOM References ──────────────────────────────────────
    const $notebookList = document.getElementById("notebook-list");
    const $emptyState = document.getElementById("empty-state");
    const $editorContainer = document.getElementById("editor-container");
    const $breadcrumb = document.getElementById("note-breadcrumb");
    const $saveStatus = document.getElementById("save-status");
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
    const $modalCancel = document.getElementById("modal-cancel");
    const $modalConfirm = document.getElementById("modal-confirm");

    // ── API Helpers ─────────────────────────────────────────
    const API = {
        async get(url) {
            const r = await fetch(url);
            if (!r.ok) {
                if (r.status === 409) throw new GitConflictError(await r.json());
                throw new Error(`GET ${url}: ${r.status}`);
            }
            return r.json();
        },
        async post(url, body) {
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                if (r.status === 409) throw new GitConflictError(await r.json());
                throw new Error(`POST ${url}: ${r.status}`);
            }
            return r.json();
        },
        async put(url, body) {
            const r = await fetch(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                if (r.status === 409) throw new GitConflictError(await r.json());
                throw new Error(`PUT ${url}: ${r.status}`);
            }
            return r.json();
        },
        async del(url) {
            const r = await fetch(url, { method: "DELETE" });
            if (!r.ok) {
                if (r.status === 409) throw new GitConflictError(await r.json());
                throw new Error(`DELETE ${url}: ${r.status}`);
            }
            return r.json();
        },
    };

    // ── Git Conflict Error ──────────────────────────────────
    class GitConflictError extends Error {
        constructor(data) {
            super(data.detail || "Git conflict detected");
            this.name = "GitConflictError";
            this.detail = data.detail;
        }
    }

    function showConflictAlert(detail) {
        const msg = `⚠️ Git Conflict Detected\n\n${detail}\n\nPlease resolve manually in your terminal:\n  cd ~/Documents/EverFree\n  git status\n  git diff\n\nOr force push with:\n  git add . && git commit -m "resolve" && git push --force origin main`;
        alert(msg);
        setSyncStatus("conflict", "Conflict — resolve manually");
    }

    // ── Sync Status UI ──────────────────────────────────────
    function setSyncStatus(state, text) {
        $syncIndicator.className = "sync-dot sync-" + state;
        $syncText.textContent = text;
    }

    async function checkSyncStatus() {
        try {
            const data = await API.get("/api/sync/status");
            if (data.git && data.remote) {
                setSyncStatus("ok", "Synced to GitHub");
            } else if (data.git) {
                setSyncStatus("warn", "Git repo (no remote)");
            } else {
                setSyncStatus("off", "Local only");
            }
        } catch {
            setSyncStatus("off", "Local only");
        }
    }

    async function triggerSync() {
        setSyncStatus("syncing", "Syncing…");
        try {
            const data = await API.post("/api/sync", {});
            setSyncStatus("ok", "Synced to GitHub");
            await loadNotebooks();
        } catch (err) {
            if (err instanceof GitConflictError) {
                showConflictAlert(err.detail);
            } else {
                setSyncStatus("error", "Sync failed");
                console.error("Sync error:", err);
            }
        }
    }

    // ── Load notebooks ──────────────────────────────────────
    async function loadNotebooks() {
        try {
            notebooks = await API.get("/api/notebooks");
            renderSidebar();
        } catch (err) {
            console.error("Failed to load notebooks:", err);
        }
    }

    // ── Render Sidebar ──────────────────────────────────────
    async function renderSidebar(filter = "") {
        $notebookList.innerHTML = "";
        const lowerFilter = filter.toLowerCase();

        for (const nb of notebooks) {
            let notes = [];
            try {
                notes = await API.get(`/api/notebooks/${encodeURIComponent(nb)}/notes`);
            } catch { /* empty */ }

            const filteredNotes = lowerFilter
                ? notes.filter(n => n.toLowerCase().includes(lowerFilter))
                : notes;

            if (lowerFilter && filteredNotes.length === 0 && !nb.toLowerCase().includes(lowerFilter)) {
                continue;
            }

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

            for (const note of filteredNotes) {
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

            const $addBtn = $header.querySelector(".notebook-add-note");
            $addBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                showModal("New Note", `Create note in "${nb}"`, async (name) => {
                    try {
                        await API.post(`/api/notebooks/${encodeURIComponent(nb)}/notes`, { name });
                        setSyncStatus("ok", "Synced to GitHub");
                        await loadNotebooks();
                        const noteName = name.endsWith(".md") ? name : name + ".md";
                        openNote(nb, noteName);
                    } catch (err) {
                        if (err instanceof GitConflictError) {
                            showConflictAlert(err.detail);
                        } else { throw err; }
                    }
                });
            });

            $item.appendChild($header);
            $item.appendChild($noteList);
            $notebookList.appendChild($item);
        }
    }

    // ── Open a Note ─────────────────────────────────────────
    async function openNote(notebook, note) {
        if (isDirty && !confirm("You have unsaved changes. Discard?")) return;

        try {
            const data = await API.get(
                `/api/notebooks/${encodeURIComponent(notebook)}/notes/${encodeURIComponent(note)}`
            );

            currentNotebook = notebook;
            currentNote = note;
            isDirty = false;

            $emptyState.style.display = "none";
            $editorContainer.style.display = "flex";
            $breadcrumb.textContent = `${notebook} / ${note.replace(/\.md$/, "")}`;
            $saveStatus.textContent = "";

            if (editor) {
                editor.destroy();
                editor = null;
            }

            initEditor(data.content);
            renderSidebar($searchInput.value);
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
        });

        // Apply current theme to the newly created editor
        const isDark = (localStorage.getItem("everfree-theme") || "dark") === "dark";
        const tuiWrapper = document.querySelector(".toastui-editor-defaultUI");
        if (tuiWrapper) tuiWrapper.classList.toggle("toastui-editor-dark", isDark);

        editor.on("change", () => {
            if (!isDirty) {
                isDirty = true;
                $saveStatus.textContent = "Unsaved changes";
                $saveStatus.className = "save-status";
            }
        });
    }

    // ── Save Note ───────────────────────────────────────────
    async function saveNote() {
        if (!currentNotebook || !currentNote || !editor) return;

        try {
            $saveStatus.textContent = "Saving…";
            $saveStatus.className = "save-status";
            setSyncStatus("syncing", "Pushing…");

            await API.put(
                `/api/notebooks/${encodeURIComponent(currentNotebook)}/notes/${encodeURIComponent(currentNote)}`,
                { content: editor.getMarkdown() }
            );

            isDirty = false;
            $saveStatus.textContent = "✓ Saved & pushed";
            $saveStatus.className = "save-status saved";
            setSyncStatus("ok", "Synced to GitHub");

            setTimeout(() => {
                if (!isDirty) $saveStatus.textContent = "";
            }, 2000);
        } catch (err) {
            if (err instanceof GitConflictError) {
                $saveStatus.textContent = "⚠ Conflict";
                $saveStatus.className = "save-status";
                showConflictAlert(err.detail);
            } else {
                console.error("Save failed:", err);
                $saveStatus.textContent = "⚠ Save failed";
                $saveStatus.className = "save-status";
                setSyncStatus("error", "Push failed");
            }
        }
    }

    // ── Delete Note ─────────────────────────────────────────
    async function deleteNote() {
        if (!currentNotebook || !currentNote) return;
        if (!confirm(`Delete "${currentNote}"? This cannot be undone.`)) return;

        try {
            setSyncStatus("syncing", "Deleting…");

            await API.del(
                `/api/notebooks/${encodeURIComponent(currentNotebook)}/notes/${encodeURIComponent(currentNote)}`
            );

            if (editor) {
                editor.destroy();
                editor = null;
            }
            currentNote = null;
            isDirty = false;
            $editorContainer.style.display = "none";
            $emptyState.style.display = "flex";

            setSyncStatus("ok", "Synced to GitHub");
            await loadNotebooks();
        } catch (err) {
            if (err instanceof GitConflictError) {
                showConflictAlert(err.detail);
            } else {
                console.error("Delete failed:", err);
                alert("Failed to delete note.");
                setSyncStatus("error", "Push failed");
            }
        }
    }

    // ── Modal ───────────────────────────────────────────────
    let modalCallback = null;

    function showModal(title, placeholder, callback) {
        $modalTitle.textContent = title;
        $modalInput.placeholder = placeholder;
        $modalInput.value = "";
        modalCallback = callback;
        $modalOverlay.style.display = "flex";
        setTimeout(() => $modalInput.focus(), 50);
    }

    function hideModal() {
        $modalOverlay.style.display = "none";
        modalCallback = null;
    }

    async function confirmModal() {
        const value = $modalInput.value.trim();
        if (!value || !modalCallback) return;
        try {
            await modalCallback(value);
            hideModal();
        } catch (err) {
            console.error("Modal action failed:", err);
            alert("Operation failed. Please try again.");
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
        const current = document.documentElement.getAttribute("data-theme") || "dark";
        applyTheme(current === "dark" ? "light" : "dark");
    });

    // Apply saved theme on load (default: dark)
    applyTheme(localStorage.getItem("everfree-theme") || "dark");

    // ── Event Bindings ──────────────────────────────────────
    $btnSave.addEventListener("click", saveNote);
    $btnDeleteNote.addEventListener("click", deleteNote);
    $btnSync.addEventListener("click", triggerSync);
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
            try {
                await API.post("/api/notebooks", { name });
                setSyncStatus("ok", "Synced to GitHub");
                await loadNotebooks();
            } catch (err) {
                if (err instanceof GitConflictError) {
                    showConflictAlert(err.detail);
                } else { throw err; }
            }
        });
    });

    // Ctrl/Cmd + S
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            saveNote();
        }
    });

    // Warn before leaving with unsaved changes
    window.addEventListener("beforeunload", (e) => {
        if (isDirty) {
            e.preventDefault();
            e.returnValue = "";
        }
    });

    // ── Init ────────────────────────────────────────────────
    loadNotebooks();
    checkSyncStatus();
})();
