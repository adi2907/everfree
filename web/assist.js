/* ════════════════════════════════════════════════════════════
   EverFree — Web Writing Assistant
   Google Gemini only. The API key lives in this browser's localStorage and is
   sent per-request to /api/agent/*, which proxies Gemini. The chat is held in
   memory for the session.
   Two shortcuts, Cursor-style:
     ⌘K — write for me: completes the selected block in place (same language
          and voice), or continues from the cursor. Esc cancels.
     ⌘L — talk about it: toggles the chat panel, attaching the current
          selection as context when there is one.
   ════════════════════════════════════════════════════════════ */
(() => {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const $panel = $("assist-panel");
    const $messages = $("assist-messages");
    const $input = $("assist-input");
    const $send = $("assist-send");
    const $status = $("assist-status");
    const $btnAssist = $("btn-assist");
    const $btnClose = $("assist-close-btn");
    const $btnNew = $("assist-new-btn");
    const $btnSettings = $("assist-settings-btn");
    const $settings = $("assist-settings");
    const $context = $("assist-context");
    const $contextText = $("assist-context-text");
    const $contextDel = $("assist-context-del");

    const SETTINGS_KEY = "everfree-assist-settings";
    const DEFAULT_CHAT_MODEL = "gemini-2.5-flash";
    const DEFAULTS = {
        gemini_api_key: "",
        gemini_model: DEFAULT_CHAT_MODEL,
    };

    let settings = loadSettings();
    let chatMessages = [];   // { role, content } — in-memory session
    let pendingContext = "";  // text attached with ⌘L
    let busy = false;

    const bridge = () => window.EverFreeBridge || null;

    function loadSettings() {
        try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); }
        catch { return Object.assign({}, DEFAULTS); }
    }
    function persistSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
    function keysPayload() {
        return {
            gemini_api_key: settings.gemini_api_key,
            gemini_model: settings.gemini_model || DEFAULT_CHAT_MODEL,
        };
    }

    // ── Status ──────────────────────────────────────────────
    function refreshStatus() {
        if (settings.gemini_api_key) {
            const model = settings.gemini_model || DEFAULT_CHAT_MODEL;
            $status.textContent = `● ${model}`;
            $status.className = "assist-status ok";
            $status.title = "";
        } else {
            $status.textContent = "● not configured";
            $status.className = "assist-status err";
            $status.title = "Add a Google Gemini API key in settings.";
        }
    }

    // ── Panel ───────────────────────────────────────────────
    function togglePanel(show) {
        const visible = show !== undefined ? show : $panel.hidden;
        $panel.hidden = !visible;
        document.body.classList.toggle("assist-open", visible);
        if (visible) { $input.focus(); refreshStatus(); }
    }

    // ── Rendering ───────────────────────────────────────────
    const scrollToBottom = () => { $messages.scrollTop = $messages.scrollHeight; };
    const clearMessages = () => { $messages.innerHTML = ""; };

    function showHint() {
        const h = document.createElement("div");
        h.className = "assist-hint";
        h.innerHTML =
            "Ask anything about your note — the assistant reads what you're working on before answering.<br>" +
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

    function addUserBubble(text, ctx) {
        const $b = document.createElement("div");
        $b.className = "assist-msg assist-user";
        if (ctx) {
            const $q = document.createElement("div");
            $q.className = "assist-quote";
            $q.textContent = ctx.length > 220 ? ctx.slice(0, 220) + "…" : ctx;
            $b.appendChild($q);
        }
        const $t = document.createElement("div");
        $t.textContent = text;
        $b.appendChild($t);
        $messages.appendChild($b);
        scrollToBottom();
        return $b;
    }

    function addReasoningBlock() {
        const $d = document.createElement("details");
        $d.className = "assist-reasoning";
        $d.open = true;
        const $s = document.createElement("summary");
        $s.textContent = "Thinking";
        const $body = document.createElement("div");
        $body.className = "assist-reasoning-body";
        $d.appendChild($s); $d.appendChild($body);
        $messages.appendChild($d);
        scrollToBottom();
        return { $d, $body };
    }

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

    function setBusy(v) {
        busy = v;
        $send.disabled = v;
        $input.disabled = v;
        if (!v) $input.focus();
    }

    // ── Selection context (⌘L) ──────────────────────────────
    function renderContextChip() {
        if (!pendingContext) { $context.hidden = true; return; }
        $contextText.textContent = pendingContext.length > 120 ? pendingContext.slice(0, 120) + "…" : pendingContext;
        $context.hidden = false;
    }
    function clearContext() { pendingContext = ""; renderContextChip(); }
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

    // ── Streaming ───────────────────────────────────────────
    async function streamChat(note) {
        const resp = await fetch("/api/agent/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: chatMessages, note, keys: keysPayload() }),
        });
        if (!resp.ok) {
            let detail = `HTTP ${resp.status}`;
            try { detail = (await resp.json()).detail || detail; } catch { /* keep */ }
            throw new Error(detail);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", fullText = "";
        const $thinking = document.createElement("div");
        $thinking.className = "assist-tool";
        $thinking.textContent = "Thinking…";
        $messages.appendChild($thinking);
        scrollToBottom();

        let reasoning = null, $bubble = null, produced = false;
        const dropThinking = () => { if ($thinking.parentNode) $thinking.remove(); };

        const handle = (e) => {
            if (e.type === "reason") {
                dropThinking();
                if (!reasoning) reasoning = addReasoningBlock();
                reasoning.$body.append(e.text);
                scrollToBottom();
            } else if (e.type === "delta") {
                dropThinking();
                if (!$bubble) $bubble = addStreamingBubble();
                fullText += e.text;
                $bubble.append(e.text);
                produced = true;
                scrollToBottom();
            } else if (e.type === "error") {
                dropThinking();
                addErrorLine(e.detail);
                produced = true;
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
                try { handle(JSON.parse(line)); } catch { /* skip */ }
            }
        }
        dropThinking();
        if (reasoning && fullText) reasoning.$d.open = false;
        if ($bubble && fullText) addBubbleActions($bubble, () => fullText);
        // Some models (especially free ones) end a tool run with an empty final
        // completion — show a hint instead of a silent, blank reply.
        if (!produced) addErrorLine("The model returned an empty response. Try again, or pick a different model in settings.");
        return fullText;
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
            await streamPlain(
                { mode, note, selection, keys: keysPayload() },
                (text) => {
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
                },
                writeAbort.signal,
                () => { if (!started) pill.setLabel("Thinking"); }
            );
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

    async function sendChat(displayText, modelText) {
        const hint = $messages.querySelector(".assist-hint");
        if (hint && chatMessages.length === 0) hint.remove();

        const ctx = pendingContext;
        addUserBubble(displayText, ctx);
        chatMessages.push({ role: "user", content: ctx ? foldContext(ctx, modelText) : modelText });
        clearContext();
        setBusy(true);
        try {
            const note = bridge() && bridge().getNote();
            const text = await streamChat(note || {});
            if (text) chatMessages.push({ role: "assistant", content: text });
        } catch (err) {
            addErrorLine(err.message);
        } finally {
            setBusy(false);
        }
    }

    // ── Chat lifecycle ──────────────────────────────────────
    function startNewChat() {
        chatMessages = [];
        clearContext();
        clearMessages();
        showHint();
        if ($panel.hidden) togglePanel(true);
        else $input.focus();
    }
    function clearChat() {
        if (busy) return;
        startNewChat();
    }

    // ── Input handling ──────────────────────────────────────
    function handleInput(raw) {
        const text = raw.trim();
        if (!text || busy) return;
        $input.value = "";
        sendChat(text, text);
    }

    // ── Settings ────────────────────────────────────────────
    function openSettings() {
        $("assist-set-gemini").value = "";
        $("assist-set-gemini").placeholder = settings.gemini_api_key ? "•••••• (saved — leave blank to keep)" : "";
        $("assist-set-gemini-model").value = settings.gemini_model;
        $settings.hidden = false;
    }
    function saveSettings() {
        settings.gemini_model = $("assist-set-gemini-model").value.trim() || DEFAULT_CHAT_MODEL;
        const key = $("assist-set-gemini").value.trim();
        if (key) settings.gemini_api_key = key;
        persistSettings();
        $settings.hidden = true;
        refreshStatus();
    }

    // ── Events ──────────────────────────────────────────────
    if ($btnAssist) $btnAssist.addEventListener("click", () => togglePanel());
    $btnClose.addEventListener("click", () => togglePanel(false));
    $btnNew.addEventListener("click", clearChat);
    $btnSettings.addEventListener("click", () => { if ($settings.hidden) openSettings(); else $settings.hidden = true; });
    $("assist-settings-cancel").addEventListener("click", () => { $settings.hidden = true; });
    $("assist-settings-save").addEventListener("click", saveSettings);
    $send.addEventListener("click", () => handleInput($input.value));
    $contextDel.addEventListener("click", clearContext);

    $input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleInput($input.value); }
        else if (e.key === "Escape") { togglePanel(false); }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && writeAbort) {
            e.preventDefault();
            writeAbort.abort();
            return;
        }
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === "k" || e.key === "K") { e.preventDefault(); aiWrite(); }
        else if (e.key === "l" || e.key === "L") { e.preventDefault(); toggleChat(); }
    });

    // Switching notes starts a fresh session for that note.
    window.addEventListener("everfree:note-changed", () => {
        if (busy) return;
        chatMessages = [];
        clearContext();
        clearMessages();
        showHint();
    });

    refreshStatus();
})();
