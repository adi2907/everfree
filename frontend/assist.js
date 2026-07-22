/* ════════════════════════════════════════════════════════════
   EverFree — Writing Assistant Panel
   Two shortcuts, Cursor-style:
     ⌘K — write for me: completes the selected block in place (same language
          and voice), or continues from the cursor when nothing is selected.
          The text streams straight into the note; Esc cancels.
     ⌘L — talk about it: toggles the chat panel, attaching the current
          selection as context when there is one.
   Slash command: /chats [text]
   The assistant runs on Google Gemini and reads your notes on its own when
   useful. Chats persist on local disk, indexed by the note they belong to.
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
    const $setGemini = document.getElementById("assist-set-gemini");
    const $setGeminiModel = document.getElementById("assist-set-gemini-model");
    const $setGeminiModelList = document.getElementById("assist-gemini-model-list");
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
    // one-off actions (⌘K writing, /chats) are not persisted.
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
                $status.textContent = data.model ? `● ${data.model}` : "● ready";
                $status.className = "assist-status ok";
                $status.title = "Gemini is configured";
            } else {
                $status.textContent = "● not configured";
                $status.className = "assist-status err";
                $status.title = data.detail || "Open assistant settings to add a Gemini API key.";
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
            "Ask anything about your note — the assistant reads your other notes when useful.<br>" +
            "Type <code>/chats</code> to browse this note's past chats.<br>" +
            "<kbd>⌘K</kbd> in the note: completes your selection (or continues where you stopped) · <kbd>⌘L</kbd> chat about the selection";
        $messages.appendChild(h);
    }

    function addBubble(role, text) {
        const $b = document.createElement("div");
        $b.className = `assist-msg assist-${role}`;
        $b.textContent = text || "";
        if (role === "assistant" && text) addBubbleActions($b, () => text);
        $messages.appendChild($b);
        scrollToBottom();
        return $b;
    }

    // Insert / Copy row under an assistant reply, so an answer or rewrite can
    // land in the note without manual copying.
    function addBubbleActions($b, getText) {
        const $row = document.createElement("div");
        $row.className = "assist-msg-actions";
        const flash = ($btn, label) => {
            const old = $btn.textContent;
            $btn.textContent = label;
            setTimeout(() => { $btn.textContent = old; }, 1200);
        };
        const btn = (label, title, fn) => {
            const $x = document.createElement("button");
            $x.type = "button";
            $x.textContent = label;
            $x.title = title;
            $x.addEventListener("click", fn);
            $row.appendChild($x);
            return $x;
        };
        btn("↳ Insert", "Append this reply to the open note", (e) => {
            const ok = bridge() && bridge().insertMarkdown && bridge().insertMarkdown(getText());
            if (ok) flash(e.target, "Inserted ✓");
            else addErrorLine("Open a note to insert into.");
        });
        btn("⧉ Copy", "Copy this reply", async (e) => {
            try {
                await navigator.clipboard.writeText(getText());
                flash(e.target, "Copied ✓");
            } catch { /* clipboard unavailable */ }
        });
        $b.appendChild($row);
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

    // ⌘L — open the chat about the current selection; with nothing selected it
    // just toggles the panel.
    function toggleChat() {
        const sel = bridge() && bridge().getSelection ? bridge().getSelection() : "";
        if (sel) {
            pendingContext = sel;
            renderContextChip();
            togglePanel(true);
            $input.focus();
        } else {
            togglePanel();
        }
    }

    function foldContext(ctx, prompt) {
        const quoted = ctx.replace(/\n/g, "\n> ");
        return `Selected excerpt from my note:\n\n> ${quoted}\n\n${prompt}`;
    }

    const TOOL_LABELS = {
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
        // No confirm needed: the current chat is already saved to disk and stays
        // reachable through /chats, so clearing only starts a fresh session.
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
        if ($bubble && fullText) addBubbleActions($bubble, () => fullText);
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

    // ── ⌘K — write into the note ────────────────────────────
    // With a selection: the model completes that block in place (same language
    // and voice) and the text streams in right after the selection. Without
    // one: it continues the note from the cursor. Esc cancels mid-stream.
    let writeAbort = null;

    // Lean NDJSON reader for note-writing: delta text is inserted, reasoning
    // only drives the status pill, and errors throw. Cancellable via `signal`.
    async function streamPlain(body, onDelta, signal, onReason) {
        const resp = await fetch("/api/agent/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
        if (!resp.ok) {
            let detail = `HTTP ${resp.status}`;
            try { detail = (await resp.json()).detail || detail; } catch { /* keep */ }
            throw new Error(detail);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.type === "delta") onDelta(event.text);
                else if (event.type === "reason" && onReason) onReason();
                else if (event.type === "error") throw new Error(event.detail);
            }
        }
    }

    function showWritePill(label) {
        const $el = document.createElement("div");
        $el.className = "assist-write-pill";
        $el.innerHTML = `<span class="assist-write-dot"></span> <span class="assist-write-label"></span> · <kbd>esc</kbd> to stop`;
        const $label = $el.querySelector(".assist-write-label");
        $label.textContent = label;
        document.body.appendChild($el);
        return {
            setLabel(text) { $label.textContent = text; },
            remove() { $el.remove(); },
        };
    }

    async function aiWrite() {
        if (writeAbort) return; // one write at a time
        const b = bridge();
        const note = b && b.getNote();
        if (!note) {
            togglePanel(true);
            addErrorLine("Open a note first — ⌘K writes into the note you have open.");
            return;
        }
        if (!(note.content || "").trim()) {
            togglePanel(true);
            addErrorLine("Write a few words first — ⌘K picks up where you stop.");
            return;
        }
        const info = (b.getSelectionInfo && b.getSelectionInfo()) || { text: "", range: null };
        const selection = info.text || "";
        const mode = selection ? "complete" : "continue";

        // Glue between the existing text and the continuation: a newline when
        // the model starts a new list item, a space when it butts up against
        // the last word (models rarely lead with whitespace). Without a
        // selection the note's trailing text stands in as the anchor.
        const anchor = selection || (note.content || "").replace(/\s+$/, "");
        const glueFor = (t) => {
            if (!anchor || /\s$/.test(anchor)) return "";
            if (/^([-*+]|\d+\.)\s?/.test(t)) return "\n";
            return /^[\s.,;:!?)\]]/.test(t) ? "" : " ";
        };
        const writeLabel = selection ? "Completing selection" : "Continuing note";
        const pill = showWritePill(writeLabel);
        writeAbort = new AbortController();
        let started = false;
        try {
            await streamPlain({ mode, note, selection }, (text) => {
                if (!started) {
                    text = text.replace(/^\n+/, "");
                    if (!text) return;
                    started = true;
                    pill.setLabel(writeLabel);
                    // First chunk lands just after the selection (or at the
                    // cursor); later chunks flow from the caret it leaves.
                    if (selection) b.insertAfterRange(info.range, glueFor(text) + text);
                    else b.insertAtCursor(glueFor(text) + text);
                    return;
                }
                b.insertAtCursor(text);
            }, writeAbort.signal, () => {
                // Local reasoning models think first; say so instead of sitting mute.
                if (!started) pill.setLabel("Thinking");
            });
        } catch (err) {
            if (err.name !== "AbortError") {
                togglePanel(true);
                addErrorLine(err.message);
            }
        } finally {
            pill.remove();
            writeAbort = null;
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

        let m;
        if ((m = text.match(/^\/chats(?:\s+(.+))?$/s))) {
            listSavedChats((m[1] || "").trim());
        } else {
            sendChat(text, text);
        }
    }

    // ── Slash command menu (Claude Code style) ───────────────
    // Typing "/" at the start of an empty prompt opens a filterable list of
    // commands. Selecting one drops "/cmd " into the box so args can follow.
    const SLASH_COMMANDS = [
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
    function fillModelList($list, models) {
        $list.innerHTML = "";
        for (const model of models || []) {
            const $opt = document.createElement("option");
            $opt.value = model;
            $list.appendChild($opt);
        }
    }

    async function loadGeminiModels() {
        try {
            const response = await fetch("/api/agent/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: $setGemini.value.trim() }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            fillModelList($setGeminiModelList, (await response.json()).models);
        } catch {
            /* Model IDs can still be entered manually. */
        }
    }

    async function openSettings() {
        try {
            const settings = await fetch("/api/agent/settings").then((r) => r.json());
            $setGeminiModel.value = settings.gemini_model;
            $setGemini.value = "";
            $setGemini.placeholder = settings.gemini_api_key_set ? "•••••• (saved — leave blank to keep)" : "";
            loadGeminiModels();
        } catch { /* show form with whatever we have */ }
        $settings.hidden = false;
    }

    async function saveSettings() {
        const body = {
            gemini_model: $setGeminiModel.value.trim() || "gemini-2.5-flash",
        };
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
    $setGeminiModel.addEventListener("focus", loadGeminiModels);
    $send.addEventListener("click", () => handleInput($input.value));

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
        if (e.key === "Escape" && writeAbort) {
            e.preventDefault();
            writeAbort.abort();
            return;
        }
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === "k" || e.key === "K") {
            e.preventDefault();
            aiWrite();
        } else if (e.key === "l" || e.key === "L") {
            e.preventDefault();
            toggleChat();
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
