/* EverFree — minimal embedded assistant. */
(() => {
    "use strict";

    const trigger = document.getElementById("btn-assistant");
    if (!trigger) return;

    const CHAT_STORE_KEY = "everfree-assistant-chats-v1";
    const API_KEY = "everfree-gemini-key";
    // Stored alongside the Gemini key, same lifetime. Nothing consumes it yet —
    // web search is not wired up; this only captures the key.
    const SERPER_KEY = "everfree-serper-key";
    const MAX_CHATS = 30;
    const MAX_MESSAGES = 40;
    const $ = (id) => document.getElementById(id);
    const bridge = () => window.EverFreeNoteContext || null;

    document.head.insertAdjacentHTML("beforeend", `<style>
        /* The panel is a flex sibling of the note panes, so opening it shrinks
           the editor instead of covering it. */
        .ef-ai-panel{position:relative;flex:0 0 var(--ef-ai-width,370px);width:var(--ef-ai-width,370px);max-width:100vw;height:100vh;z-index:3;display:flex;flex-direction:column;background:var(--bg-surface,#fff);color:var(--text-primary,#222);border-left:1px solid var(--border,#ddd);font-family:var(--font-sans,var(--font,system-ui,sans-serif))}
        .ef-ai-panel[hidden],.ef-ai-view[hidden],.ef-ai-selection[hidden]{display:none!important}
        .ef-ai-resizer{position:absolute;top:0;bottom:0;left:-4px;width:8px;z-index:4;cursor:col-resize;touch-action:none}
        .ef-ai-resizer::after{content:"";position:absolute;inset:0 3px;background:var(--border,#ddd);opacity:0;transition:opacity 120ms ease,background 120ms ease}
        .ef-ai-resizer:hover::after,.ef-ai-resizer:focus-visible::after,.ef-ai-resizer.is-active::after{background:var(--accent,#47735a);opacity:1}
        body.ef-ai-resizing,body.ef-ai-resizing *{cursor:col-resize!important;user-select:none!important}
        /* Widening the panel re-clamps the note panes; their width animation
           would otherwise lag a pointer that is still moving. */
        body.ef-ai-resizing .sidebar,body.ef-ai-resizing .note-browser{transition:none!important}
        .ef-ai-header{height:54px;display:flex;align-items:center;gap:4px;padding:0 10px 0 14px;border-bottom:1px solid var(--border,#ddd)}
        .ef-ai-title{flex:1;font-weight:650;font-size:14px}
        .ef-ai-icon{width:32px;height:32px;border:0;border-radius:7px;background:transparent;color:var(--text-secondary,#666);font:inherit;font-size:18px;cursor:pointer}
        .ef-ai-icon:hover{background:var(--bg-input,#eee);color:var(--text-primary,#222)}
        .ef-ai-messages{flex:1;min-height:0;overflow:auto;padding:18px 14px;display:flex;flex-direction:column;gap:14px}
        .ef-ai-empty{margin:auto;text-align:center;color:var(--text-muted,#777);font-size:13px;line-height:1.6}
        .ef-ai-message{max-width:92%;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
        .ef-ai-user{align-self:flex-end;padding:9px 12px;border-radius:12px 12px 3px 12px;background:var(--accent,#47735a);color:#fff}
        .ef-ai-assistant{align-self:stretch;max-width:100%;padding:2px 4px;color:var(--text-primary,#222)}
        .ef-ai-quote{margin:0 0 7px;padding:6px 8px;border-left:2px solid currentColor;background:rgba(255,255,255,.12);font-size:11px;opacity:.9}
        .ef-ai-error{align-self:stretch;color:var(--danger,#b64f4f);font-size:12px}
        .ef-ai-thinking{align-self:flex-start;color:var(--text-muted,#777);font-size:12px}
        .ef-ai-thinking::after{content:'…';animation:ef-ai-pulse 1s infinite}
        @keyframes ef-ai-pulse{50%{opacity:.25}}
        .ef-ai-sources{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
        .ef-ai-sources a{max-width:100%;padding:3px 7px;border:1px solid var(--border,#ddd);border-radius:999px;color:var(--text-secondary,#666);font-size:10px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .ef-ai-compose{padding:8px 12px max(12px,env(safe-area-inset-bottom));background:var(--bg-surface,#fff)}
        .ef-ai-model{margin:0 2px 7px;color:var(--text-muted,#777);font-size:11px;line-height:1.35}
        .ef-ai-model[data-fallback="true"]{color:var(--accent,#47735a)}
        .ef-ai-selection{display:flex;align-items:center;gap:8px;margin-bottom:7px;padding:7px 9px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg-input,#f4f4f4);font-size:11px}
        .ef-ai-selection strong{white-space:nowrap;color:var(--accent,#47735a)}
        .ef-ai-selection span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary,#666)}
        .ef-ai-selection button{border:0;background:none;color:var(--text-muted,#777);font-size:17px;cursor:pointer}
        .ef-ai-form{display:flex;align-items:flex-end;gap:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:14px;background:var(--bg-editor,var(--bg-surface,#fff));box-shadow:0 2px 12px rgba(0,0,0,.05)}
        .ef-ai-input{flex:1;min-height:46px;max-height:150px;resize:none;border:0;outline:0;background:transparent;color:var(--text-primary,#222);font:inherit;font-size:13px;line-height:1.5}
        .ef-ai-send{width:32px;height:32px;flex:0 0 auto;border:0;border-radius:50%;background:var(--accent,#47735a);color:#fff;font-size:17px;cursor:pointer}
        .ef-ai-send:disabled{opacity:.4;cursor:default}
        .ef-ai-mic{width:32px;height:32px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:var(--text-secondary,#666);cursor:pointer}
        .ef-ai-mic:hover{background:var(--bg-input,#eee);color:var(--text-primary,#222)}
        .ef-ai-mic[hidden]{display:none!important}
        .ef-ai-mic:disabled{opacity:.4;cursor:default}
        .ef-ai-mic.is-listening{background:var(--accent,#47735a);color:#fff}
        /* Interim speech is a preview only — it is never committed to the box. */
        .ef-ai-interim{margin:0 2px 6px;color:var(--text-muted,#777);font-size:12px;line-height:1.4;font-style:italic}
        .ef-ai-interim[hidden]{display:none!important}
        .ef-ai-settings,.ef-ai-history{position:absolute;inset:54px 0 0;z-index:2;overflow:auto;padding:18px 14px;background:var(--bg-surface,#fff)}
        .ef-ai-settings h3,.ef-ai-history h3{margin:0 0 6px;font-size:14px}
        .ef-ai-history p{margin:0 0 16px;color:var(--text-muted,#777);font-size:12px;line-height:1.5}
        .ef-ai-settings a{color:var(--accent,#47735a)}
        .ef-ai-settings input{width:100%;padding:10px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg-input,#f4f4f4);color:var(--text-primary,#222);font:inherit;font-size:13px;outline:none}
        .ef-ai-settings-head{display:flex;align-items:center;gap:4px;margin-bottom:14px}
        .ef-ai-settings-head h3{margin:0;flex:1}
        .ef-ai-help{width:26px;height:26px;flex:0 0 auto;font-size:15px;line-height:1}
        .ef-ai-help[aria-expanded="true"]{background:var(--bg-input,#eee);color:var(--text-primary,#222)}
        /* Reference material, not something to read on the way to pasting a key. */
        .ef-ai-help-text{margin:-4px 0 16px;padding:11px 12px;border-radius:9px;background:var(--bg-input,#f4f4f4)}
        .ef-ai-help-text[hidden]{display:none!important}
        .ef-ai-help-text p{margin:0 0 9px;color:var(--text-secondary,#666);font-size:12px;line-height:1.5}
        .ef-ai-help-text p:last-child{margin-bottom:0}
        .ef-ai-help-text strong{color:var(--text-primary,#222)}
        .ef-ai-field-label{display:block;margin:0 0 6px;font-size:12px;font-weight:600}
        .ef-ai-field-label span{margin-left:5px;color:var(--text-muted,#777);font-weight:400}
        .ef-ai-settings input + .ef-ai-field-label{margin-top:14px}
        .ef-ai-settings-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
        .ef-ai-button{padding:7px 11px;border:1px solid var(--border,#ddd);border-radius:7px;background:var(--bg-input,#f4f4f4);color:var(--text-primary,#222);font:inherit;font-size:12px;cursor:pointer}
        .ef-ai-button-primary{border-color:var(--accent,#47735a);background:var(--accent,#47735a);color:#fff}
        .ef-ai-chat-row{width:100%;display:block;margin:0 0 8px;padding:10px 11px;border:1px solid var(--border,#ddd);border-radius:9px;background:transparent;color:var(--text-primary,#222);font:inherit;text-align:left;cursor:pointer}
        .ef-ai-chat-row:hover{background:var(--bg-input,#f4f4f4)}
        .ef-ai-chat-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
        .ef-ai-chat-row span{display:block;margin-top:4px;color:var(--text-muted,#777);font-size:10px}
        /* Phones have no room to split, so the panel goes back to a full-screen
           overlay and the drag handle is pointless. */
        @media(max-width:768px){.ef-ai-panel{position:fixed;inset:0 0 0 auto;flex:none;width:100vw;height:100%;z-index:1200;box-shadow:-12px 0 32px rgba(0,0,0,.12)}.ef-ai-resizer{display:none}}
    </style>`);

    // Dock as a sibling of the note panes so opening the panel shrinks the
    // editor rather than covering it. Anchoring to the note browser rather than
    // to #view-app matters: mobile has a #view-app too, but it is hidden while a
    // note is open, which would take the panel down with it.
    const noteBrowser = document.getElementById("note-browser");
    const shell = (noteBrowser && noteBrowser.parentElement) || document.body;
    shell.insertAdjacentHTML("beforeend", `
        <aside class="ef-ai-panel" id="ef-ai-panel" aria-label="AI assistant" hidden>
            <div class="ef-ai-resizer" id="ef-ai-resizer" role="separator" aria-orientation="vertical"
                aria-label="Resize assistant" tabindex="0"></div>
            <header class="ef-ai-header">
                <span class="ef-ai-title">Assistant</span>
                <button class="ef-ai-icon" id="ef-ai-resume" title="Resume chat" aria-label="Resume chat">◷</button>
                <button class="ef-ai-icon" id="ef-ai-new" title="New chat" aria-label="New chat">＋</button>
                <button class="ef-ai-icon" id="ef-ai-info" title="API keys" aria-label="API keys">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="7.5" cy="15.5" r="4.5"/>
                        <path d="M10.7 12.3 21 2"/>
                        <path d="m17 6 3 3"/>
                        <path d="m14 9 3 3"/>
                    </svg>
                </button>
                <button class="ef-ai-icon" id="ef-ai-close" title="Close" aria-label="Close">×</button>
            </header>
            <section class="ef-ai-settings ef-ai-view" id="ef-ai-settings" hidden>
                <div class="ef-ai-settings-head">
                    <h3>API keys</h3>
                    <button class="ef-ai-icon ef-ai-help" id="ef-ai-help" type="button" title="About these keys"
                        aria-label="About these keys" aria-expanded="false" aria-controls="ef-ai-help-text">ⓘ</button>
                </div>
                <div class="ef-ai-help-text" id="ef-ai-help-text" hidden>
                    <p><strong>Gemini</strong> answers your questions. Get a key from
                        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.
                        The free tier currently includes 500 Gemini 3.5 Flash-Lite requests and 14,400 Gemma 4 31B requests per day.</p>
                    <p><strong>Serper</strong> is for web search. Gemini's own search grounding is not available on the
                        free tier, so a separate key from <a href="https://serper.dev" target="_blank" rel="noopener noreferrer">serper.dev</a>
                        is needed instead. Optional — the assistant works without it.</p>
                </div>
                <label class="ef-ai-field-label" for="ef-ai-key">Gemini key</label>
                <input type="password" id="ef-ai-key" aria-label="Gemini API key" autocomplete="off" placeholder="Paste your Gemini API key">
                <label class="ef-ai-field-label" for="ef-ai-serper-key">Serper key <span>optional</span></label>
                <input type="password" id="ef-ai-serper-key" aria-label="Serper API key" autocomplete="off" placeholder="Paste your Serper API key">
                <div class="ef-ai-settings-actions">
                    <button class="ef-ai-button" id="ef-ai-settings-cancel">Cancel</button>
                    <button class="ef-ai-button ef-ai-button-primary" id="ef-ai-settings-save">Save</button>
                </div>
            </section>
            <section class="ef-ai-history ef-ai-view" id="ef-ai-history" hidden>
                <h3>Resume chat</h3>
                <p id="ef-ai-history-note"></p>
                <div id="ef-ai-history-list"></div>
                <button class="ef-ai-button" id="ef-ai-history-close">Back</button>
            </section>
            <div class="ef-ai-messages" id="ef-ai-messages"></div>
            <div class="ef-ai-compose">
                <div class="ef-ai-model" id="ef-ai-model">Using Gemini 3.5 Flash-Lite</div>
                <div class="ef-ai-selection" id="ef-ai-selection" hidden>
                    <strong>Text selected</strong><span id="ef-ai-selection-text"></span>
                    <button id="ef-ai-selection-clear" title="Remove selection" aria-label="Remove selection">×</button>
                </div>
                <div class="ef-ai-interim" id="ef-ai-interim" hidden aria-live="polite"></div>
                <form class="ef-ai-form" id="ef-ai-form">
                    <textarea class="ef-ai-input" id="ef-ai-input" rows="2" placeholder="Reply"></textarea>
                    <button class="ef-ai-mic" id="ef-ai-mic" type="button" title="Dictate your message" aria-label="Dictate your message" aria-pressed="false" hidden>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                            <line x1="12" y1="19" x2="12" y2="23"/>
                            <line x1="8" y1="23" x2="16" y2="23"/>
                        </svg>
                    </button>
                    <button class="ef-ai-send" id="ef-ai-send" type="submit" title="Send" aria-label="Send">↑</button>
                </form>
            </div>
        </aside>`);

    let currentChat = null;
    let pendingSelection = "";
    let busy = false;

    function chatStore() {
        try {
            const value = JSON.parse(localStorage.getItem(CHAT_STORE_KEY) || "[]");
            return Array.isArray(value) ? value : [];
        } catch { return []; }
    }

    function writeStore(chats) {
        try { localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(chats.slice(0, MAX_CHATS))); }
        catch { /* Resume is optional when browser storage is unavailable. */ }
    }

    function noteKey(note) {
        if (!note) return "";
        return `${note.notebook || ""}/${note.note || ""}`;
    }

    function newId() {
        return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function blankChat() {
        const note = bridge() && bridge().getNote ? bridge().getNote() : null;
        return { id: newId(), noteKey: noteKey(note), title: "New chat", updatedAt: Date.now(), messages: [] };
    }

    function persistChat() {
        if (!currentChat || !currentChat.messages.length) return;
        currentChat.updatedAt = Date.now();
        currentChat.messages = currentChat.messages.slice(-MAX_MESSAGES);
        const chats = chatStore().filter((chat) => chat.id !== currentChat.id);
        chats.unshift(currentChat);
        writeStore(chats);
    }

    function closeViews() {
        $("ef-ai-settings").hidden = true;
        $("ef-ai-history").hidden = true;
    }

    function sourceLinks(container, sources) {
        if (!Array.isArray(sources) || !sources.length) return;
        const row = document.createElement("div");
        row.className = "ef-ai-sources";
        for (const source of sources) {
            if (!source || typeof source.url !== "string" || !/^https?:\/\//.test(source.url)) continue;
            const link = document.createElement("a");
            link.href = source.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = source.title || "Source";
            row.appendChild(link);
        }
        if (row.childNodes.length) container.appendChild(row);
    }

    function messageBubble(message) {
        const bubble = document.createElement("div");
        bubble.className = `ef-ai-message ef-ai-${message.role}`;
        if (message.role === "user" && message.selection) {
            const quote = document.createElement("div");
            quote.className = "ef-ai-quote";
            quote.textContent = message.selection.length > 220 ? `${message.selection.slice(0, 220)}…` : message.selection;
            bubble.appendChild(quote);
        }
        const text = document.createElement("div");
        text.textContent = message.content || "";
        bubble.appendChild(text);
        sourceLinks(bubble, message.sources);
        return { bubble, text };
    }

    function scrollBottom() {
        const messages = $("ef-ai-messages");
        messages.scrollTop = messages.scrollHeight;
    }

    function setActiveModel(model) {
        const indicator = $("ef-ai-model");
        const fallback = Boolean(model && model.fallback);
        const name = model && model.name ? model.name : "Gemini 3.5 Flash-Lite";
        indicator.dataset.fallback = String(fallback);
        indicator.textContent = fallback
            ? `Gemini quota reached — using ${name}`
            : `Using ${name}`;
    }

    function renderMessages() {
        const messages = $("ef-ai-messages");
        messages.replaceChildren();
        if (!currentChat || !currentChat.messages.length) {
            setActiveModel(null);
            const empty = document.createElement("div");
            empty.className = "ef-ai-empty";
            empty.textContent = "Ask anything about the note you have open.";
            messages.appendChild(empty);
            return;
        }
        for (const message of currentChat.messages) messages.appendChild(messageBubble(message).bubble);
        const lastModel = [...currentChat.messages].reverse().find((message) => message.modelName);
        setActiveModel(lastModel ? { name: lastModel.modelName, fallback: lastModel.fallback } : null);
        scrollBottom();
    }

    function setSelection(text) {
        pendingSelection = typeof text === "string" ? text : "";
        $("ef-ai-selection").hidden = !pendingSelection.trim();
        $("ef-ai-selection-text").textContent = pendingSelection.length > 120
            ? `${pendingSelection.slice(0, 120)}…` : pendingSelection;
    }

    function captureSelection(whileOpening = false) {
        if ($("ef-ai-panel").hidden && !whileOpening) return;
        const context = bridge();
        const selected = context && context.getSelection ? context.getSelection() : "";
        if (selected) setSelection(selected);
    }

    function setBusy(value) {
        busy = value;
        $("ef-ai-send").disabled = value;
        $("ef-ai-input").disabled = value;
        $("ef-ai-mic").disabled = value;
    }

    // ── Prompt dictation ────────────────────────────────────
    // Mirrors the notes editor: interim speech is previewed but never
    // committed, and only finalized chunks reach the box.
    let promptDictation = null;

    // The note editor owns its own dictation in app.js, which this file cannot
    // reach. Its mic buttons are the shared handle: a listening one carries
    // .is-listening, and clicking it toggles that session off. Same rule mobile
    // already applies between its two mics.
    const NOTE_MIC_IDS = ["btn-editor-mic", "btn-note-mic", "btn-capture-mic"];

    function stopNoteDictation() {
        for (const id of NOTE_MIC_IDS) {
            const mic = document.getElementById(id);
            if (mic && mic.classList.contains("is-listening")) mic.click();
        }
    }

    function stopPromptDictation() {
        if (promptDictation && promptDictation.active) promptDictation.stop();
    }

    function setPromptMicActive(listening) {
        const mic = $("ef-ai-mic");
        mic.classList.toggle("is-listening", listening);
        mic.setAttribute("aria-pressed", listening ? "true" : "false");
        mic.title = listening ? "Stop dictation" : "Dictate your message";
        if (!listening) showInterim("");
    }

    function showInterim(text) {
        const el = $("ef-ai-interim");
        el.textContent = text;
        el.hidden = !text;
    }

    function insertAtCursor(text) {
        const spoken = String(text || "").trim();
        const input = $("ef-ai-input");
        if (!spoken || input.disabled) return;
        const chunk = spoken + " ";
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + chunk + input.value.slice(end);
        const cursor = start + chunk.length;
        input.selectionStart = cursor;
        input.selectionEnd = cursor;
        input.focus();
    }

    function setupPromptDictation() {
        const mic = $("ef-ai-mic");
        if (typeof window.createDictation !== "function" || !window.voiceInputSupported) return;

        promptDictation = window.createDictation({
            onInterim: showInterim,
            onFinal(text) {
                showInterim("");
                insertAtCursor(text);
            },
            onState: setPromptMicActive,
            onError(error) {
                setPromptMicActive(false);
                addError(
                    error === "not-allowed"
                        ? "Microphone permission denied."
                        : error === "audio-capture"
                            ? "No microphone found."
                            : "Voice input stopped."
                );
            },
        });
        if (!promptDictation) return;

        mic.hidden = false;
        mic.addEventListener("click", () => {
            if (busy) return;
            if (!promptDictation.active) stopNoteDictation();
            promptDictation.toggle();
        });

        // The other direction of the same exclusion: starting a note mic ends
        // the prompt's session.
        document.addEventListener("click", (event) => {
            if (!(event.target instanceof Element)) return;
            if (NOTE_MIC_IDS.some((id) => event.target.closest(`#${id}`))) stopPromptDictation();
        }, true);
    }

    function addError(detail) {
        const error = document.createElement("div");
        error.className = "ef-ai-error";
        error.textContent = detail;
        $("ef-ai-messages").appendChild(error);
        scrollBottom();
    }

    function setHelpOpen(open) {
        $("ef-ai-help-text").hidden = !open;
        $("ef-ai-help").setAttribute("aria-expanded", open ? "true" : "false");
    }

    function openSettings() {
        closeViews();
        $("ef-ai-key").value = sessionStorage.getItem(API_KEY) || "";
        $("ef-ai-serper-key").value = sessionStorage.getItem(SERPER_KEY) || "";
        // Explain on first arrival, when there is no key yet and the reader has
        // no idea what to paste; stay out of the way on every later visit.
        setHelpOpen(!sessionStorage.getItem(API_KEY));
        $("ef-ai-settings").hidden = false;
        $("ef-ai-key").focus();
    }

    function showHistory() {
        closeViews();
        const note = bridge() && bridge().getNote ? bridge().getNote() : null;
        const key = noteKey(note);
        const chats = chatStore().filter((chat) => chat.noteKey === key && chat.messages && chat.messages.length);
        $("ef-ai-history-note").textContent = note ? `Chats for ${note.note || "this note"}` : "Open a note first.";
        const list = $("ef-ai-history-list");
        list.replaceChildren();
        if (!chats.length) {
            const empty = document.createElement("p");
            empty.textContent = "No previous chats for this note.";
            list.appendChild(empty);
        }
        for (const chat of chats) {
            const button = document.createElement("button");
            button.className = "ef-ai-chat-row";
            const title = document.createElement("strong");
            title.textContent = chat.title || "Chat";
            const date = document.createElement("span");
            date.textContent = new Date(chat.updatedAt || 0).toLocaleString();
            button.append(title, date);
            button.addEventListener("click", () => {
                currentChat = chat;
                closeViews();
                setSelection("");
                renderMessages();
                $("ef-ai-input").focus();
            });
            list.appendChild(button);
        }
        $("ef-ai-history").hidden = false;
    }

    async function streamReply(body) {
        const response = await fetch("/api/assistant/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            let detail = `Request failed (${response.status})`;
            try { detail = (await response.json()).detail || detail; } catch { /* keep default */ }
            throw new Error(detail);
        }

        const thinking = document.createElement("div");
        thinking.className = "ef-ai-thinking";
        thinking.textContent = "Thinking";
        $("ef-ai-messages").appendChild(thinking);
        scrollBottom();

        const answer = { role: "assistant", content: "", sources: [] };
        let rendered = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const handle = (event) => {
            if (event.type === "model") {
                answer.model = event.id || "";
                answer.modelName = event.name || "";
                answer.fallback = Boolean(event.fallback);
                setActiveModel(event);
            } else if (event.type === "delta") {
                thinking.remove();
                if (!rendered) {
                    rendered = messageBubble(answer);
                    $("ef-ai-messages").appendChild(rendered.bubble);
                }
                answer.content += event.text || "";
                rendered.text.append(event.text || "");
            } else if (event.type === "sources") {
                answer.sources = Array.isArray(event.sources) ? event.sources : [];
            } else if (event.type === "error") {
                throw new Error(event.detail || "The assistant could not answer.");
            }
            scrollBottom();
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try { handle(JSON.parse(line)); } catch (error) { thinking.remove(); throw error; }
            }
        }
        if (buffer.trim()) handle(JSON.parse(buffer));
        thinking.remove();
        if (!answer.content) throw new Error("The assistant returned an empty response.");
        if (rendered && answer.sources.length) sourceLinks(rendered.bubble, answer.sources);
        return answer;
    }

    async function send() {
        const prompt = $("ef-ai-input").value;
        if (!prompt.trim() || busy) return;
        stopPromptDictation();
        const context = bridge();
        const note = context && context.getNote ? context.getNote() : null;
        if (!note) { addError("Open a note first."); return; }
        const apiKey = sessionStorage.getItem(API_KEY) || "";
        if (!apiKey) { openSettings(); return; }
        if (!currentChat || currentChat.noteKey !== noteKey(note)) currentChat = blankChat();

        const history = currentChat.messages.map((message) => ({
            role: message.role,
            content: message.content,
            selection: message.selection || "",
        }));
        const selection = pendingSelection;
        const userMessage = { role: "user", content: prompt, selection };
        if (!currentChat.messages.length) currentChat.title = prompt.slice(0, 60);
        currentChat.messages.push(userMessage);
        $("ef-ai-input").value = "";
        setSelection("");
        renderMessages();
        persistChat();
        setBusy(true);
        try {
            const answer = await streamReply({
                api_key: apiKey,
                note,
                selection: { text: selection },
                history,
                prompt,
            });
            currentChat.messages.push(answer);
            persistChat();
        } catch (error) {
            addError(error.message || String(error));
        } finally {
            setBusy(false);
            $("ef-ai-input").focus();
        }
    }

    const WIDTH_KEY = "everfree-assistant-width";
    const MIN_WIDTH = 300;
    const MAX_WIDTH = 640;

    // Tell the pane resizers to re-clamp: the assistant just took (or gave
    // back) horizontal space they were sharing.
    function announceLayoutChange() {
        window.dispatchEvent(new CustomEvent("everfree:layout-change"));
    }

    function closePanel() {
        if ($("ef-ai-panel").hidden) return;
        stopPromptDictation();
        $("ef-ai-panel").hidden = true;
        announceLayoutChange();
    }

    function setPanelWidth(width, persist = false) {
        const editorMin = 320;
        const available = window.innerWidth - editorMin;
        const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available));
        const next = Math.round(Math.max(MIN_WIDTH, Math.min(max, width)));
        document.documentElement.style.setProperty("--ef-ai-width", `${next}px`);
        const handle = $("ef-ai-resizer");
        handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
        handle.setAttribute("aria-valuemax", String(max));
        handle.setAttribute("aria-valuenow", String(next));
        if (persist) localStorage.setItem(WIDTH_KEY, String(next));
        announceLayoutChange();
    }

    function setupPanelResizer() {
        const handle = $("ef-ai-resizer");
        const panel = $("ef-ai-panel");
        let startX = 0;
        let startWidth = 0;
        let dragging = false;

        const saved = Number(localStorage.getItem(WIDTH_KEY));
        if (Number.isFinite(saved) && saved > 0) setPanelWidth(saved);

        // The panel is docked on the right, so dragging left widens it.
        handle.addEventListener("pointerdown", (event) => {
            if (!window.matchMedia("(min-width: 769px)").matches) return;
            event.preventDefault();
            dragging = true;
            startX = event.clientX;
            startWidth = panel.getBoundingClientRect().width;
            handle.classList.add("is-active");
            document.body.classList.add("ef-ai-resizing");
            handle.setPointerCapture?.(event.pointerId);
        });

        handle.addEventListener("keydown", (event) => {
            if (!window.matchMedia("(min-width: 769px)").matches) return;
            const current = panel.getBoundingClientRect().width;
            let next = current;
            if (event.key === "ArrowLeft") next += 16;
            if (event.key === "ArrowRight") next -= 16;
            if (event.key === "Home") next = MAX_WIDTH;
            if (event.key === "End") next = MIN_WIDTH;
            if (next === current) return;
            event.preventDefault();
            setPanelWidth(next, true);
        });

        window.addEventListener("pointermove", (event) => {
            if (!dragging) return;
            setPanelWidth(startWidth + startX - event.clientX);
        });

        const stop = () => {
            if (!dragging) return;
            dragging = false;
            setPanelWidth(panel.getBoundingClientRect().width, true);
            handle.classList.remove("is-active");
            document.body.classList.remove("ef-ai-resizing");
        };
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        window.addEventListener("resize", () => {
            if (panel.hidden) return;
            setPanelWidth(panel.getBoundingClientRect().width);
        });
    }

    setupPanelResizer();
    setupPromptDictation();

    function openPanel() {
        $("ef-ai-panel").hidden = false;
        announceLayoutChange();
        closeViews();
        if (!currentChat) currentChat = blankChat();
        renderMessages();
        captureSelection();
        $("ef-ai-input").focus();
    }

    trigger.addEventListener("pointerdown", () => captureSelection(true));
    trigger.addEventListener("click", () => $("ef-ai-panel").hidden ? openPanel() : closePanel());
    $("ef-ai-close").addEventListener("click", closePanel);
    $("ef-ai-new").addEventListener("click", () => {
        if (busy) return;
        currentChat = blankChat();
        setSelection("");
        closeViews();
        renderMessages();
        $("ef-ai-input").focus();
    });
    $("ef-ai-resume").addEventListener("click", showHistory);
    $("ef-ai-info").addEventListener("click", openSettings);
    $("ef-ai-settings-cancel").addEventListener("click", closeViews);
    $("ef-ai-history-close").addEventListener("click", closeViews);
    $("ef-ai-help").addEventListener("click", () => {
        setHelpOpen($("ef-ai-help-text").hidden);
    });
    $("ef-ai-settings-save").addEventListener("click", () => {
        const key = $("ef-ai-key").value.trim();
        if (!key) return;
        sessionStorage.setItem(API_KEY, key);
        // Optional, and clearing the box is the way to remove it.
        const serper = $("ef-ai-serper-key").value.trim();
        if (serper) sessionStorage.setItem(SERPER_KEY, serper);
        else sessionStorage.removeItem(SERPER_KEY);
        closeViews();
        $("ef-ai-input").focus();
    });
    $("ef-ai-selection-clear").addEventListener("click", () => setSelection(""));
    $("ef-ai-form").addEventListener("submit", (event) => { event.preventDefault(); send(); });
    $("ef-ai-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closePanel();
    });
    document.addEventListener("mouseup", (event) => {
        if (!(event.target instanceof Element) || !event.target.closest("#ef-ai-panel")) setTimeout(captureSelection, 0);
    });
    document.addEventListener("keyup", (event) => {
        if (!(event.target instanceof Element) || !event.target.closest("#ef-ai-panel")) setTimeout(captureSelection, 0);
    });
    window.addEventListener("everfree:note-changed", () => {
        if (busy) return;
        currentChat = blankChat();
        setSelection("");
        if (!$("ef-ai-panel").hidden) renderMessages();
    });
})();
