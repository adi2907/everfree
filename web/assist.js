/* ════════════════════════════════════════════════════════════
   EverFree — Web Writing Assistant
   Gemini + OpenRouter only. Keys live in this browser's localStorage and are
   sent per-request to /api/agent/*, which proxies the providers. The chat is
   held in memory for the session.
   Shortcuts: ⌘K toggle · ⌘L attach selection · Enter send
   ════════════════════════════════════════════════════════════ */
(() => {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const $panel = $("assist-panel");
    const $messages = $("assist-messages");
    const $input = $("assist-input");
    const $slashMenu = $("assist-slash-menu");
    const $send = $("assist-send");
    const $status = $("assist-status");
    const $btnAssist = $("btn-assist");
    const $btnClose = $("assist-close-btn");
    const $btnNew = $("assist-new-btn");
    const $btnSettings = $("assist-settings-btn");
    const $settings = $("assist-settings");
    const $providerQuick = $("assist-provider-quick");
    const $context = $("assist-context");
    const $contextText = $("assist-context-text");
    const $contextDel = $("assist-context-del");

    const SETTINGS_KEY = "everfree-assist-settings";
    const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";
    const DEFAULTS = {
        provider: "openrouter",
        openrouter_api_key: "", openrouter_model: "",
        gemini_api_key: "", gemini_model: "gemini-2.5-flash",
        serper_api_key: "", image_model: DEFAULT_IMAGE_MODEL,
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
            openrouter_api_key: settings.openrouter_api_key,
            serper_api_key: settings.serper_api_key,
            gemini_model: settings.gemini_model,
            openrouter_model: settings.openrouter_model,
            image_model: settings.image_model || DEFAULT_IMAGE_MODEL,
        };
    }

    // ── Status ──────────────────────────────────────────────
    function refreshStatus() {
        $providerQuick.value = settings.provider;
        let ready, model, detail;
        if (settings.provider === "gemini") {
            ready = !!settings.gemini_api_key;
            model = settings.gemini_model;
            detail = "Add a Gemini API key in settings.";
        } else {
            ready = !!(settings.openrouter_api_key && settings.openrouter_model);
            model = settings.openrouter_model;
            detail = "Add an OpenRouter API key and model in settings.";
        }
        if (ready) {
            $status.textContent = model ? `● ${model}` : "● ready";
            $status.className = "assist-status ok";
            $status.title = "";
        } else {
            $status.textContent = "● not configured";
            $status.className = "assist-status err";
            $status.title = detail;
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
            "Ask anything about your note — the assistant can reason and search the web before answering.<br>" +
            "Type <code>/</code> for commands — <code>/image</code> a prompt to generate a picture.<br>" +
            "Select text in your note + <kbd>⌘L</kbd> to ask about that excerpt.";
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

    const TOOL_LABELS = {
        web_search: ["🔍", "Searching the web"],
        read_page: ["📖", "Reading page"],
        generate_image: ["🎨", "Generating image"],
    };

    function addToolLine(name, detail) {
        const $line = document.createElement("div");
        $line.className = "assist-tool";
        const [icon, label] = TOOL_LABELS[name] || ["🔧", name || "Working"];
        $line.textContent = detail ? `${icon} ${label}: ${detail}` : `${icon} ${label}`;
        $messages.appendChild($line);
        scrollToBottom();
    }

    function addImageBubble(url, alt, providerLabel, model) {
        const $wrap = document.createElement("div");
        $wrap.className = "assist-msg assist-assistant assist-image";
        const $img = document.createElement("img");
        $img.src = url;
        $img.alt = alt || "";
        $wrap.appendChild($img);
        if (providerLabel) {
            const $meta = document.createElement("div");
            $meta.className = "assist-image-meta";
            $meta.textContent = model ? `via ${providerLabel} · ${model}` : `via ${providerLabel}`;
            $wrap.appendChild($meta);
        }
        $messages.appendChild($wrap);
        scrollToBottom();
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

    const providerLabelFor = (p) => ({ gemini: "Gemini (free)", openrouter: "OpenRouter" }[p]);

    // ── Selection context (⌘L) ──────────────────────────────
    function renderContextChip() {
        if (!pendingContext) { $context.hidden = true; return; }
        $contextText.textContent = pendingContext.length > 120 ? pendingContext.slice(0, 120) + "…" : pendingContext;
        $context.hidden = false;
    }
    function clearContext() { pendingContext = ""; renderContextChip(); }
    function addSelectionToChat() {
        const sel = bridge() && bridge().getSelection ? bridge().getSelection() : "";
        togglePanel(true);
        if (!sel) { addErrorLine("Select some text in your note first, then press ⌘L."); return; }
        pendingContext = sel;
        renderContextChip();
        $input.focus();
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
            body: JSON.stringify({ provider: settings.provider, messages: chatMessages, note, keys: keysPayload() }),
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
            } else if (e.type === "tool") {
                dropThinking();
                addToolLine(e.name, e.detail);
            } else if (e.type === "image") {
                dropThinking();
                addImageBubble(e.url, e.alt, providerLabelFor(e.provider), e.model);
                produced = true;
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
        // Some models (especially free ones) end a tool run with an empty final
        // completion — show a hint instead of a silent, blank reply.
        if (!produced) addErrorLine("The model returned an empty response. Try again, or pick a different model in settings.");
        return fullText;
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

    async function generateImage(prompt) {
        addBubble("user", `/image ${prompt}`);
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
                body: JSON.stringify({ prompt, keys: keysPayload() }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
            $line.remove();
            addImageBubble(data.dataUrl, prompt, providerLabelFor(data.provider), data.model);
        } catch (err) {
            $line.remove();
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

    // ── Slash command menu ──────────────────────────────────
    const SLASH_COMMANDS = [{ cmd: "/image", desc: "Generate an image from a prompt" }];
    let slashItems = [], slashIndex = 0;
    const slashOpen = () => !$slashMenu.hidden;

    function hideSlashMenu() { $slashMenu.hidden = true; $slashMenu.innerHTML = ""; slashItems = []; }
    function updateSlashMenu() {
        const m = $input.value.match(/^\/(\w*)$/);
        if (!m) return hideSlashMenu();
        const prefix = "/" + m[1].toLowerCase();
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
            $row.innerHTML = `<span class="assist-slash-cmd"></span><span class="assist-slash-desc"></span>`;
            $row.querySelector(".assist-slash-cmd").textContent = item.cmd;
            $row.querySelector(".assist-slash-desc").textContent = item.desc;
            $row.addEventListener("mousedown", (e) => { e.preventDefault(); applySlash(item.cmd); });
            $slashMenu.appendChild($row);
        });
        $slashMenu.hidden = false;
    }
    function moveSlash(d) { slashIndex = (slashIndex + d + slashItems.length) % slashItems.length; renderSlashMenu(); }
    function applySlash(cmd) { $input.value = cmd + " "; hideSlashMenu(); $input.focus(); }

    // ── Input handling ──────────────────────────────────────
    function handleInput(raw) {
        const text = raw.trim();
        if (!text || busy) return;
        $input.value = "";
        hideSlashMenu();
        const stripQuotes = (s) => s.trim().replace(/^"(.*)"$/s, "$1");
        let m;
        if ((m = text.match(/^\/image\s+(.+)/s))) {
            generateImage(stripQuotes(m[1]));
        } else {
            sendChat(text, text);
        }
    }

    // ── Settings ────────────────────────────────────────────
    function selectSettingsTab(provider) {
        document.querySelectorAll("[data-provider-tab]").forEach(($t) => {
            $t.classList.toggle("active", $t.dataset.providerTab === provider);
        });
        document.querySelectorAll("[data-provider-pane]").forEach(($p) => {
            const active = $p.dataset.providerPane === provider;
            $p.classList.toggle("active", active);
            $p.hidden = !active;
        });
    }
    function openSettings() {
        $("assist-set-openrouter").value = "";
        $("assist-set-openrouter").placeholder = settings.openrouter_api_key ? "•••••• (saved — leave blank to keep)" : "";
        $("assist-set-openrouter-model").value = settings.openrouter_model;
        $("assist-set-gemini").value = "";
        $("assist-set-gemini").placeholder = settings.gemini_api_key ? "•••••• (saved — leave blank to keep)" : "";
        $("assist-set-gemini-model").value = settings.gemini_model;
        $("assist-set-serper").value = "";
        $("assist-set-serper").placeholder = settings.serper_api_key ? "•••••• (saved — leave blank to keep)" : "";
        $("assist-set-image-model").value = settings.image_model;
        selectSettingsTab(settings.provider);
        $settings.hidden = false;
    }
    function saveSettings() {
        settings.provider = $providerQuick.value;
        settings.openrouter_model = $("assist-set-openrouter-model").value.trim();
        settings.gemini_model = $("assist-set-gemini-model").value.trim() || "gemini-2.5-flash";
        settings.image_model = $("assist-set-image-model").value.trim() || DEFAULT_IMAGE_MODEL;
        const or = $("assist-set-openrouter").value.trim();
        const gm = $("assist-set-gemini").value.trim();
        const sp = $("assist-set-serper").value.trim();
        if (or) settings.openrouter_api_key = or;
        if (gm) settings.gemini_api_key = gm;
        if (sp) settings.serper_api_key = sp;
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
    document.querySelectorAll("[data-provider-tab]").forEach(($t) => {
        $t.addEventListener("click", () => selectSettingsTab($t.dataset.providerTab));
    });
    $send.addEventListener("click", () => handleInput($input.value));
    $providerQuick.addEventListener("change", () => { settings.provider = $providerQuick.value; persistSettings(); refreshStatus(); });
    $contextDel.addEventListener("click", clearContext);

    $input.addEventListener("input", updateSlashMenu);
    $input.addEventListener("keydown", (e) => {
        if (slashOpen()) {
            if (e.key === "ArrowDown") { e.preventDefault(); moveSlash(1); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); moveSlash(-1); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applySlash(slashItems[slashIndex].cmd); return; }
            if (e.key === "Escape") { e.preventDefault(); hideSlashMenu(); return; }
        }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleInput($input.value); }
        else if (e.key === "Escape") { togglePanel(false); }
    });

    document.addEventListener("keydown", (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === "k" || e.key === "K") { e.preventDefault(); togglePanel(); }
        else if (e.key === "l" || e.key === "L") { e.preventDefault(); addSelectionToChat(); }
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
