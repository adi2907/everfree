/* ════════════════════════════════════════════════════════════
   EverFree — Writing Assistant Panel
   Shortcuts: ⌘K toggle panel · ⌘. continue writing
   Slash commands: /search <topic> · /image <prompt> · /chats [text]
   Chats persist on local disk, indexed by the note they belong to.
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    const $panel = document.getElementById("assist-panel");
    const $messages = document.getElementById("assist-messages");
    const $input = document.getElementById("assist-input");
    const $send = document.getElementById("assist-send");
    const $status = document.getElementById("assist-status");
    const $btnAssist = document.getElementById("btn-assist");
    const $btnClose = document.getElementById("assist-close-btn");
    const $btnNew = document.getElementById("assist-new-btn");
    const $btnSettings = document.getElementById("assist-settings-btn");
    const $settings = document.getElementById("assist-settings");
    const $setUrl = document.getElementById("assist-set-url");
    const $setModel = document.getElementById("assist-set-model");
    const $setModelList = document.getElementById("assist-model-list");
    const $setSerper = document.getElementById("assist-set-serper");
    const $setOpenrouter = document.getElementById("assist-set-openrouter");
    const $setOpenrouterModel = document.getElementById("assist-set-openrouter-model");
    const $setOpenrouterModelList = document.getElementById("assist-openrouter-model-list");
    const $setGemini = document.getElementById("assist-set-gemini");
    const $setGeminiModel = document.getElementById("assist-set-gemini-model");
    const $setGeminiModelList = document.getElementById("assist-gemini-model-list");
    const $setImageModel = document.getElementById("assist-set-image-model");
    const $settingsSave = document.getElementById("assist-settings-save");
    const $settingsCancel = document.getElementById("assist-settings-cancel");
    const $context = document.getElementById("assist-context");
    const $contextText = document.getElementById("assist-context-text");
    const $contextDel = document.getElementById("assist-context-del");

    // Text the user selected in the note and attached with ⌘L. Folded into the
    // next prompt sent to the model, then cleared.
    let pendingContext = "";

    // The active chat session. `id` is null until the first message is sent,
    // at which point it is assigned and the session is persisted to disk.
    // `messages` holds only the conversational turns (user + assistant text);
    // one-off actions (⌘. continue, /image, /chats) are not persisted.
    let currentChat = newSession();
    let busy = false;

    const bridge = () => window.EverFreeBridge || null;
    const enc = encodeURIComponent;

    function newSession(notebook = "", note = "") {
        return { id: null, notebook, note, title: "", messages: [] };
    }

    function genId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return Date.now().toString(36) + Math.random().toString(16).slice(2);
    }

    function deriveTitle(text) {
        const t = text.replace(/^\/\w+\s*/, "").trim();
        return (t || text).slice(0, 60);
    }

    function relTime(ts) {
        if (!ts) return "";
        const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
        if (secs < 60) return "just now";
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(ts * 1000).toLocaleDateString();
    }

    // ── Panel visibility ────────────────────────────────────
    function togglePanel(show) {
        const visible = show !== undefined ? show : $panel.hidden;
        $panel.hidden = !visible;
        document.body.classList.toggle("assist-open", visible);
        if (visible) {
            $input.focus();
            refreshStatus();
        }
    }

    async function refreshStatus() {
        try {
            const r = await fetch("/api/agent/status");
            const data = await r.json();
            if (data.ready) {
                $status.textContent = `● ${data.provider_label}${data.model ? ` · ${data.model}` : ""}`;
                $status.className = "assist-status ok";
                $status.title = `${data.provider_label} is configured`;
            } else {
                $status.textContent = `● ${data.provider_label || "Assistant"} not configured`;
                $status.className = "assist-status err";
                $status.title = data.detail || "Open assistant settings to configure a provider.";
            }
        } catch {
            $status.textContent = "";
        }
    }

    // ── Message rendering ───────────────────────────────────
    function scrollToBottom() {
        $messages.scrollTop = $messages.scrollHeight;
    }

    function clearMessages() {
        $messages.innerHTML = "";
    }

    function showHint() {
        const h = document.createElement("div");
        h.className = "assist-hint";
        h.innerHTML =
            "Ask anything about your note, or:<br>" +
            "<code>/search</code> a topic — research the web and draft a passage with sources<br>" +
            "<code>/image</code> a prompt — generate an image into your note's assets<br>" +
            "<code>/chats</code> [text] — browse this note's past chats (optionally filtered)<br>" +
            "<kbd>⌘.</kbd> continue writing · <kbd>⌘K</kbd> toggle panel · the ✎ icon starts a new chat";
        $messages.appendChild(h);
    }

    function addBubble(role, text) {
        const $b = document.createElement("div");
        $b.className = `assist-msg assist-${role}`;
        $b.textContent = text || "";
        $messages.appendChild($b);
        scrollToBottom();
        return $b;
    }

    // A user bubble that optionally shows the attached note excerpt above the prompt.
    function addUserBubble(text, contextText) {
        const $b = document.createElement("div");
        $b.className = "assist-msg assist-user";
        if (contextText) {
            const $q = document.createElement("div");
            $q.className = "assist-quote";
            $q.textContent = contextText.length > 220 ? contextText.slice(0, 220) + "…" : contextText;
            $b.appendChild($q);
        }
        const $t = document.createElement("div");
        $t.textContent = text;
        $b.appendChild($t);
        $messages.appendChild($b);
        scrollToBottom();
        return $b;
    }

    // ── Selected-excerpt context (⌘L) ───────────────────────
    function renderContextChip() {
        if (!pendingContext) {
            $context.hidden = true;
            return;
        }
        $contextText.textContent =
            pendingContext.length > 120 ? pendingContext.slice(0, 120) + "…" : pendingContext;
        $context.hidden = false;
    }

    function clearContext() {
        pendingContext = "";
        renderContextChip();
    }

    function addSelectionToChat() {
        const sel = bridge() && bridge().getSelection ? bridge().getSelection() : "";
        togglePanel(true);
        if (!sel) {
            addErrorLine("Select some text in your note first, then press ⌘L.");
            return;
        }
        pendingContext = sel;
        renderContextChip();
        $input.focus();
    }

    function foldContext(ctx, prompt) {
        const quoted = ctx.replace(/\n/g, "\n> ");
        return `Selected excerpt from my note:\n\n> ${quoted}\n\n${prompt}`;
    }

    function addToolLine(name, detail) {
        const $line = document.createElement("div");
        $line.className = "assist-tool";
        const icon = name === "web_search" ? "🔍" : "📖";
        const label = name === "web_search" ? "Searching" : "Reading";
        $line.textContent = `${icon} ${label}: ${detail}`;
        $messages.appendChild($line);
        scrollToBottom();
        return $line;
    }

    function addErrorLine(detail) {
        const $line = document.createElement("div");
        $line.className = "assist-error";
        $line.textContent = `⚠ ${detail}`;
        $messages.appendChild($line);
        scrollToBottom();
    }

    function addInsertButton(onInsert) {
        const $bar = document.createElement("div");
        $bar.className = "assist-actions-row";
        const $btn = document.createElement("button");
        $btn.className = "btn btn-ghost assist-insert-btn";
        $btn.textContent = "Insert into note";
        $btn.addEventListener("click", () => {
            if (onInsert()) {
                $btn.textContent = "✓ Inserted";
                $btn.disabled = true;
            } else {
                addErrorLine("Open a note first, then insert.");
            }
        });
        $bar.appendChild($btn);
        $messages.appendChild($bar);
        scrollToBottom();
    }

    function setBusy(value) {
        busy = value;
        $send.disabled = value;
        $input.disabled = value;
        if (!value) $input.focus();
    }

    // ── Persistence ─────────────────────────────────────────
    async function persistChat() {
        if (!currentChat.id || currentChat.messages.length === 0) return;
        try {
            await fetch(`/api/agent/chats/${currentChat.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    notebook: currentChat.notebook,
                    note: currentChat.note,
                    title: currentChat.title,
                    messages: currentChat.messages,
                }),
            });
        } catch {
            /* non-fatal: a failed save shouldn't break the conversation */
        }
    }

    function startNewChat() {
        const note = bridge() && bridge().getNote();
        currentChat = newSession(note ? note.notebook : "", note ? note.note : "");
        clearContext();
        clearMessages();
        showHint();
        if ($panel.hidden) togglePanel(true);
        else $input.focus();
    }

    async function loadNoteChats(notebook, note) {
        currentChat = newSession(notebook, note);
        clearContext();
        clearMessages();
        try {
            const list = await fetch(
                `/api/agent/chats?notebook=${enc(notebook)}&note=${enc(note)}`
            ).then((r) => r.json());
            if (list.length) {
                await openChat(list[0].id);
                return;
            }
        } catch {
            /* fall through to empty state */
        }
        showHint();
    }

    async function openChat(id) {
        try {
            const data = await fetch(`/api/agent/chats/${id}`).then((r) => r.json());
            currentChat = {
                id: data.id,
                notebook: data.notebook,
                note: data.note,
                title: data.title,
                messages: data.messages || [],
            };
            clearMessages();
            if (!currentChat.messages.length) {
                showHint();
                return;
            }
            for (const m of currentChat.messages) {
                if (m.role === "user") {
                    addUserBubble(m.text || m.content, m.context);
                } else {
                    const text = m.content;
                    addBubble("assistant", text);
                    addInsertButton(() => bridge() && bridge().insertMarkdown(text));
                }
            }
        } catch {
            addErrorLine("Could not open that chat.");
        }
    }

    function renderChatList(list, query) {
        const $wrap = document.createElement("div");
        $wrap.className = "assist-chatlist";
        if (!list.length) {
            $wrap.className = "assist-hint";
            $wrap.textContent = query
                ? `No chats for this note matching "${query}".`
                : "No saved chats for this note yet.";
            $messages.appendChild($wrap);
            scrollToBottom();
            return;
        }
        for (const c of list) {
            const $item = document.createElement("div");
            $item.className = "assist-chatitem";
            const current = c.id === currentChat.id;
            const $title = document.createElement("span");
            $title.className = "assist-chatitem-title";
            $title.textContent = (current ? "● " : "") + (c.title || "Untitled chat");
            const $meta = document.createElement("span");
            $meta.className = "assist-chatitem-meta";
            $meta.textContent = `${c.message_count} msg${c.message_count === 1 ? "" : "s"} · ${relTime(c.updated_at)}`;
            const $del = document.createElement("button");
            $del.className = "assist-chatitem-del";
            $del.title = "Delete chat";
            $del.textContent = "×";
            $del.addEventListener("click", async (e) => {
                e.stopPropagation();
                await fetch(`/api/agent/chats/${c.id}`, { method: "DELETE" });
                if (c.id === currentChat.id) startNewChat();
                else $item.remove();
            });
            $item.appendChild($title);
            $item.appendChild($meta);
            $item.appendChild($del);
            $item.addEventListener("click", () => openChat(c.id));
            $wrap.appendChild($item);
        }
        $messages.appendChild($wrap);
        scrollToBottom();
    }

    // ── Streaming chat ──────────────────────────────────────
    async function streamChat(body) {
        const resp = await fetch("/api/agent/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            let detail = `HTTP ${resp.status}`;
            try { detail = (await resp.json()).detail || detail; } catch { /* keep */ }
            throw new Error(detail);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        const $thinking = document.createElement("div");
        $thinking.className = "assist-tool";
        $thinking.textContent = "Thinking…";
        $messages.appendChild($thinking);
        scrollToBottom();

        const handleEvent = (event) => {
            if (event.type === "delta") {
                fullText += event.text;
            } else if (event.type === "tool") {
                $thinking.remove();
                addToolLine(event.name, event.detail);
            } else if (event.type === "error") {
                $thinking.remove();
                addErrorLine(event.detail);
            }
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try { handleEvent(JSON.parse(line)); } catch { /* skip bad line */ }
            }
        }
        $thinking.remove();
        if (fullText) addBubble("assistant", fullText);
        return fullText;
    }

    // ── Commands ────────────────────────────────────────────
    async function sendChat(displayText, modelText) {
        // The hint disappears once a real conversation starts.
        const hint = $messages.querySelector(".assist-hint");
        if (hint && currentChat.messages.length === 0) hint.remove();

        if (!currentChat.id) currentChat.id = genId();
        const note = bridge() && bridge().getNote();
        if (note) {
            currentChat.notebook = note.notebook;
            currentChat.note = note.note;
        }

        const ctx = pendingContext;
        addUserBubble(displayText, ctx);
        const userMsg = { role: "user", content: ctx ? foldContext(ctx, modelText) : modelText };
        if (ctx) {
            userMsg.text = displayText;
            userMsg.context = ctx;
        }
        currentChat.messages.push(userMsg);
        clearContext();
        if (!currentChat.title) currentChat.title = deriveTitle(displayText);
        setBusy(true);
        try {
            const text = await streamChat({ mode: "chat", messages: currentChat.messages, note });
            if (text) {
                currentChat.messages.push({ role: "assistant", content: text });
                const toInsert = text;
                addInsertButton(() => bridge() && bridge().insertMarkdown(toInsert));
                await persistChat();
            }
        } catch (err) {
            addErrorLine(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function continueWriting() {
        const note = bridge() && bridge().getNote();
        if (!note) {
            togglePanel(true);
            addErrorLine("Open a note first — ⌘. continues the note you're writing.");
            return;
        }
        togglePanel(true);
        addBubble("user", "⌘. Continue writing");
        setBusy(true);
        try {
            const text = await streamChat({ mode: "continue", note });
            if (text) {
                const toInsert = text;
                addInsertButton(() => bridge() && bridge().insertAtCursor(toInsert));
            }
        } catch (err) {
            addErrorLine(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function generateImage(prompt) {
        const note = bridge() && bridge().getNote();
        addBubble("user", `/image ${prompt}`);
        if (!note) {
            addErrorLine("Open a note first — images are saved into that notebook's assets folder.");
            return;
        }
        setBusy(true);
        const $line = document.createElement("div");
        $line.className = "assist-tool";
        $line.textContent = "🎨 Generating image…";
        $messages.appendChild($line);
        scrollToBottom();
        try {
            const resp = await fetch("/api/agent/image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt, notebook: note.notebook }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

            $line.remove();
            const $wrap = document.createElement("div");
            $wrap.className = "assist-msg assist-assistant assist-image";
            const $img = document.createElement("img");
            $img.src = data.preview_url;
            $img.alt = prompt;
            $wrap.appendChild($img);
            $messages.appendChild($wrap);
            addInsertButton(() => bridge() && bridge().insertImage(data.rel_path, prompt));
        } catch (err) {
            $line.remove();
            addErrorLine(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function listSavedChats(query) {
        const note = bridge() && bridge().getNote();
        addBubble("user", query ? `/chats ${query}` : "/chats");
        const params = new URLSearchParams();
        if (note) {
            params.set("notebook", note.notebook);
            params.set("note", note.note);
        }
        if (query) params.set("q", query);
        try {
            const list = await fetch(`/api/agent/chats?${params.toString()}`).then((r) => r.json());
            renderChatList(list, query);
        } catch {
            addErrorLine("Could not list chats.");
        }
    }

    function handleInput(raw) {
        const text = raw.trim();
        if (!text || busy) return;
        $input.value = "";

        const stripQuotes = (s) => s.trim().replace(/^"(.*)"$/s, "$1");

        let m;
        if ((m = text.match(/^\/chats(?:\s+(.+))?$/s))) {
            listSavedChats((m[1] || "").trim());
        } else if ((m = text.match(/^\/image\s+(.+)/s))) {
            generateImage(stripQuotes(m[1]));
        } else if ((m = text.match(/^\/search\s+(.+)/s))) {
            const query = stripQuotes(m[1]);
            sendChat(
                text,
                `Search the web and research this: "${query}". Then write a passage I can insert ` +
                `into my note, grounded in what you found, ending with the sources you used.`
            );
        } else {
            sendChat(text, text);
        }
    }

    // ── Settings ────────────────────────────────────────────
    function selectSettingsTab(provider) {
        document.querySelectorAll("[data-provider-tab]").forEach(($tab) => {
            const active = $tab.dataset.providerTab === provider;
            $tab.classList.toggle("active", active);
            $tab.setAttribute("aria-selected", active ? "true" : "false");
        });
        document.querySelectorAll("[data-provider-pane]").forEach(($pane) => {
            const active = $pane.dataset.providerPane === provider;
            $pane.classList.toggle("active", active);
            $pane.hidden = !active;
        });
    }

    function fillModelList($list, models) {
        $list.innerHTML = "";
        for (const model of models || []) {
            const $opt = document.createElement("option");
            $opt.value = model;
            $list.appendChild($opt);
        }
    }

    async function loadProviderModels(provider) {
        try {
            const body = {};
            if (provider === "lmstudio") body.lmstudio_url = $setUrl.value.trim();
            if (provider === "openrouter") body.api_key = $setOpenrouter.value.trim();
            if (provider === "gemini") body.api_key = $setGemini.value.trim();
            const response = await fetch(`/api/agent/models/${provider}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (provider === "lmstudio") fillModelList($setModelList, data.models);
            if (provider === "openrouter") fillModelList($setOpenrouterModelList, data.models);
            if (provider === "gemini") fillModelList($setGeminiModelList, data.models);
        } catch {
            /* Model IDs can still be entered manually. */
        }
    }

    async function openSettings() {
        try {
            const settings = await fetch("/api/agent/settings").then((r) => r.json());
            $setUrl.value = settings.lmstudio_url;
            $setModel.value = settings.lmstudio_model;
            $setOpenrouterModel.value = settings.openrouter_model;
            $setGeminiModel.value = settings.gemini_model;
            $setImageModel.value = settings.image_model;
            $setSerper.value = "";
            $setSerper.placeholder = settings.serper_api_key_set ? "•••••• (saved — leave blank to keep)" : "";
            $setOpenrouter.value = "";
            $setOpenrouter.placeholder = settings.openrouter_api_key_set ? "•••••• (saved — leave blank to keep)" : "";
            $setGemini.value = "";
            $setGemini.placeholder = settings.gemini_api_key_set ? "•••••• (saved — leave blank to keep)" : "";
            const provider = settings.active_provider || "lmstudio";
            const $radio = document.querySelector(`input[name="assist-provider"][value="${provider}"]`);
            if ($radio) $radio.checked = true;
            selectSettingsTab(provider);
            loadProviderModels("lmstudio");
            loadProviderModels("openrouter");
            loadProviderModels("gemini");
        } catch { /* show form with whatever we have */ }
        $settings.hidden = false;
    }

    async function saveSettings() {
        const body = {
            active_provider: document.querySelector('input[name="assist-provider"]:checked')?.value || "lmstudio",
            lmstudio_url: $setUrl.value.trim() || "http://localhost:1234/v1",
            lmstudio_model: $setModel.value.trim(),
            openrouter_model: $setOpenrouterModel.value.trim(),
            gemini_model: $setGeminiModel.value.trim(),
            image_model: $setImageModel.value.trim() || "google/gemini-2.5-flash-image",
        };
        if ($setSerper.value.trim()) body.serper_api_key = $setSerper.value.trim();
        if ($setOpenrouter.value.trim()) body.openrouter_api_key = $setOpenrouter.value.trim();
        if ($setGemini.value.trim()) body.gemini_api_key = $setGemini.value.trim();
        try {
            const r = await fetch("/api/agent/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            $settings.hidden = true;
            refreshStatus();
        } catch (err) {
            addErrorLine(`Could not save settings: ${err.message}`);
        }
    }

    // ── Events ──────────────────────────────────────────────
    if ($btnAssist) $btnAssist.addEventListener("click", () => togglePanel());
    $btnClose.addEventListener("click", () => togglePanel(false));
    $btnNew.addEventListener("click", startNewChat);
    $btnSettings.addEventListener("click", () => {
        if ($settings.hidden) openSettings();
        else $settings.hidden = true;
    });
    $settingsCancel.addEventListener("click", () => { $settings.hidden = true; });
    $settingsSave.addEventListener("click", saveSettings);
    document.querySelectorAll("[data-provider-tab]").forEach(($tab) => {
        $tab.addEventListener("click", () => {
            selectSettingsTab($tab.dataset.providerTab);
            loadProviderModels($tab.dataset.providerTab);
        });
    });
    $setModel.addEventListener("focus", () => loadProviderModels("lmstudio"));
    $setOpenrouterModel.addEventListener("focus", () => loadProviderModels("openrouter"));
    $setGeminiModel.addEventListener("focus", () => loadProviderModels("gemini"));
    $send.addEventListener("click", () => handleInput($input.value));

    $input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleInput($input.value);
        } else if (e.key === "Escape") {
            togglePanel(false);
        }
    });

    document.addEventListener("keydown", (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === "k" || e.key === "K") {
            e.preventDefault();
            togglePanel();
        } else if (e.key === ".") {
            e.preventDefault();
            if (!busy) continueWriting();
        } else if (e.key === "l" || e.key === "L") {
            e.preventDefault();
            addSelectionToChat();
        }
    });

    $contextDel.addEventListener("click", clearContext);

    // Switching notes loads that note's most recent chat (or a fresh one).
    window.addEventListener("everfree:note-changed", (e) => {
        const { notebook, note } = e.detail || {};
        if (!notebook || !note) return;
        if (busy) return; // don't yank a chat out from under a running request
        loadNoteChats(notebook, note);
    });
})();
