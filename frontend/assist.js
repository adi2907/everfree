/* ════════════════════════════════════════════════════════════
   EverFree — Writing Assistant Panel
   Shortcuts: ⌘K toggle panel · ⌘. continue writing · ⌘L attach selection
   Slash commands: /image <prompt> · /chats [text]
   The assistant searches the web and reads your notes on its own when useful.
   Chats persist on local disk, indexed by the note they belong to.
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    const $panel = document.getElementById("assist-panel");
    const $messages = document.getElementById("assist-messages");
    const $input = document.getElementById("assist-input");
    const $slashMenu = document.getElementById("assist-slash-menu");
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
    const $providerQuick = document.getElementById("assist-provider-quick");

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
            if ($providerQuick && data.provider) $providerQuick.value = data.provider;
            if (data.ready) {
                // The provider name lives in the dropdown now; show just the model.
                $status.textContent = data.model ? `● ${data.model}` : "● ready";
                $status.className = "assist-status ok";
                $status.title = `${data.provider_label} is configured`;
            } else {
                $status.textContent = "● not configured";
                $status.className = "assist-status err";
                $status.title = data.detail || "Open assistant settings to configure a provider.";
            }
        } catch {
            $status.textContent = "";
        }
    }

    // Flip the active provider from the header dropdown (persisted server-side).
    async function switchProvider(provider) {
        try {
            await fetch("/api/agent/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active_provider: provider }),
            });
        } catch { /* keep the dropdown value; refreshStatus will reconcile */ }
        refreshStatus();
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
            "Ask anything about your note — the assistant searches the web and reads your other notes when useful.<br>" +
            "Type <code>/</code> for commands — <code>/image</code> a prompt, or <code>/chats</code> to browse past chats.<br>" +
            "<kbd>⌘.</kbd> continue writing · <kbd>⌘K</kbd> toggle panel · use Clear chat to start fresh";
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

    const TOOL_LABELS = {
        web_search: ["🔍", "Searching the web"],
        read_page: ["📖", "Reading page"],
        search_notes: ["🗂", "Searching your notes"],
        read_note: ["📄", "Reading note"],
        list_notebooks: ["🗂", "Listing notebooks"],
        list_notes: ["🗂", "Listing notes"],
        create_note: ["📝", "Creating note"],
    };

    function addToolLine(name, detail) {
        const $line = document.createElement("div");
        $line.className = "assist-tool";
        const [icon, label] = TOOL_LABELS[name] || ["🔧", name || "Working"];
        $line.textContent = detail ? `${icon} ${label}: ${detail}` : `${icon} ${label}`;
        $messages.appendChild($line);
        scrollToBottom();
        return $line;
    }

    // A collapsible trace the agent's reasoning streams into.
    function addReasoningBlock() {
        const $d = document.createElement("details");
        $d.className = "assist-reasoning";
        $d.open = true;
        const $s = document.createElement("summary");
        $s.textContent = "Thinking";
        const $body = document.createElement("div");
        $body.className = "assist-reasoning-body";
        $d.appendChild($s);
        $d.appendChild($body);
        $messages.appendChild($d);
        scrollToBottom();
        return { $d, $body };
    }

    // An assistant bubble that answer tokens stream into as they arrive.
    function addStreamingBubble() {
        const $b = document.createElement("div");
        $b.className = "assist-msg assist-assistant";
        $messages.appendChild($b);
        scrollToBottom();
        return $b;
    }

    function addErrorLine(detail) {
        const $line = document.createElement("div");
        $line.className = "assist-error";
        $line.textContent = `⚠ ${detail}`;
        $messages.appendChild($line);
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

    function clearChat() {
        if (busy) return;
        const hasChat = currentChat.messages.length > 0 || $messages.querySelector(".assist-msg");
        if (hasChat && !confirm("Clear this chat and start fresh? Saved chats remain available through /chats.")) {
            return;
        }
        startNewChat();
    }

    async function loadNoteChats(notebook, note) {
        currentChat = newSession(notebook, note);
        clearContext();
        clearMessages();
        let opened = false;
        try {
            const list = await fetch(
                `/api/agent/chats?notebook=${enc(notebook)}&note=${enc(note)}`
            ).then((r) => r.json());
            if (list.length) {
                await openChat(list[0].id);
                opened = true;
            }
        } catch {
            /* fall through to empty state */
        }
        if (!opened) showHint();
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

        let reasoning = null;   // { $d, $body } created on the first reason token
        let $bubble = null;     // assistant bubble created on the first answer token
        const dropThinking = () => { if ($thinking.parentNode) $thinking.remove(); };

        const handleEvent = (event) => {
            if (event.type === "reason") {
                dropThinking();
                if (!reasoning) reasoning = addReasoningBlock();
                reasoning.$body.append(event.text);
                scrollToBottom();
            } else if (event.type === "delta") {
                dropThinking();
                if (!$bubble) $bubble = addStreamingBubble();
                fullText += event.text;
                $bubble.append(event.text);
                scrollToBottom();
            } else if (event.type === "tool") {
                dropThinking();
                addToolLine(event.name, event.detail);
                // A note the agent just created should appear in the library now.
                if (event.name === "create_note" && bridge() && bridge().refreshLibrary) {
                    bridge().refreshLibrary();
                }
            } else if (event.type === "error") {
                dropThinking();
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
        dropThinking();
        // Collapse the reasoning trace once a real answer exists; keep it open if
        // reasoning was all we got back.
        if (reasoning && fullText) reasoning.$d.open = false;
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
            await streamChat({ mode: "continue", note });
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
            // Small caption noting which provider served it, so the free-tier →
            // OpenRouter fallback is observable.
            const providerLabel = { gemini: "Gemini (free)", openrouter: "OpenRouter" }[data.provider];
            if (providerLabel) {
                const $meta = document.createElement("div");
                $meta.className = "assist-image-meta";
                $meta.textContent = data.model ? `via ${providerLabel} · ${data.model}` : `via ${providerLabel}`;
                $wrap.appendChild($meta);
            }
            $messages.appendChild($wrap);
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
        hideSlashMenu();

        const stripQuotes = (s) => s.trim().replace(/^"(.*)"$/s, "$1");

        let m;
        if ((m = text.match(/^\/chats(?:\s+(.+))?$/s))) {
            listSavedChats((m[1] || "").trim());
        } else if ((m = text.match(/^\/image\s+(.+)/s))) {
            generateImage(stripQuotes(m[1]));
        } else {
            sendChat(text, text);
        }
    }

    // ── Slash command menu (Claude Code style) ───────────────
    // Typing "/" at the start of an empty prompt opens a filterable list of
    // commands. Selecting one drops "/cmd " into the box so args can follow.
    const SLASH_COMMANDS = [
        { cmd: "/image", desc: "Generate an image into your note's assets" },
        { cmd: "/chats", desc: "Browse this note's past chats" },
    ];
    let slashItems = [];   // currently shown commands
    let slashIndex = 0;    // highlighted row

    const slashOpen = () => !$slashMenu.hidden;

    function hideSlashMenu() {
        $slashMenu.hidden = true;
        $slashMenu.innerHTML = "";
        slashItems = [];
    }

    function updateSlashMenu() {
        // Only while typing the command token itself: a leading "/" and no space.
        const match = $input.value.match(/^\/(\w*)$/);
        if (!match) return hideSlashMenu();
        const prefix = "/" + match[1].toLowerCase();
        slashItems = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(prefix));
        if (!slashItems.length) return hideSlashMenu();
        slashIndex = 0;
        renderSlashMenu();
    }

    function renderSlashMenu() {
        $slashMenu.innerHTML = "";
        slashItems.forEach((item, i) => {
            const $row = document.createElement("div");
            $row.className = "assist-slash-item" + (i === slashIndex ? " active" : "");
            $row.setAttribute("role", "option");
            $row.innerHTML =
                `<span class="assist-slash-cmd"></span><span class="assist-slash-desc"></span>`;
            $row.querySelector(".assist-slash-cmd").textContent = item.cmd;
            $row.querySelector(".assist-slash-desc").textContent = item.desc;
            // mousedown (not click) so the textarea keeps focus through selection.
            $row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                applySlash(item.cmd);
            });
            $slashMenu.appendChild($row);
        });
        $slashMenu.hidden = false;
    }

    function moveSlash(delta) {
        slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
        renderSlashMenu();
    }

    function applySlash(cmd) {
        $input.value = cmd + " ";
        hideSlashMenu();
        $input.focus();
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
            // Open the tab for whichever provider currently answers, but the
            // active provider itself is chosen via the header dropdown.
            selectSettingsTab(settings.active_provider || "lmstudio");
            loadProviderModels("lmstudio");
            loadProviderModels("openrouter");
            loadProviderModels("gemini");
        } catch { /* show form with whatever we have */ }
        $settings.hidden = false;
    }

    async function saveSettings() {
        const body = {
            // The active provider is owned by the header dropdown; keep it in sync
            // so saving credentials never silently changes which provider answers.
            active_provider: $providerQuick ? $providerQuick.value : "lmstudio",
            lmstudio_url: $setUrl.value.trim() || "http://localhost:1234/v1",
            lmstudio_model: $setModel.value.trim(),
            openrouter_model: $setOpenrouterModel.value.trim(),
            gemini_model: $setGeminiModel.value.trim(),
            image_model: $setImageModel.value.trim() || "google/gemini-3.1-flash-lite-image",
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
    $btnNew.addEventListener("click", clearChat);
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
    if ($providerQuick) {
        $providerQuick.addEventListener("change", () => switchProvider($providerQuick.value));
    }

    $input.addEventListener("input", updateSlashMenu);

    $input.addEventListener("keydown", (e) => {
        // While the slash menu is open it captures navigation keys.
        if (slashOpen()) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                moveSlash(1);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                moveSlash(-1);
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                applySlash(slashItems[slashIndex].cmd);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                hideSlashMenu();
                return;
            }
        }
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
