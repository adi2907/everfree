/* ════════════════════════════════════════════════════════════
   EverFree — Voice input (Web Speech API)
   Shared dictation helper used by both the AI input (assist.js)
   and the notes editor (app.js). Runs entirely in the browser via
   the browser's built-in SpeechRecognition (live, streaming).
   ════════════════════════════════════════════════════════════ */
(() => {
    "use strict";

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    window.voiceInputSupported = !!SR;

    /**
     * Create a dictation controller.
     * @param {object} cb
     * @param {(text:string)=>void} [cb.onInterim] in-progress transcript (not final)
     * @param {(text:string)=>void} [cb.onFinal]   each finalized chunk (append this)
     * @param {(active:boolean)=>void} [cb.onState] listening started/stopped
     * @param {(err:string)=>void} [cb.onError]    recognition error code
     * @param {string} [cb.lang]                    BCP-47 language tag
     */
    window.createDictation = function ({ onInterim, onFinal, onState, onError, lang } = {}) {
        if (!SR) return null;

        let rec = null;
        let active = false;   // user wants to be listening
        let stopping = false; // user explicitly toggled off

        function build() {
            const r = new SR();
            r.continuous = true;
            r.interimResults = true;
            r.lang = lang || navigator.language || "en-US";

            r.onresult = (e) => {
                let interim = "";
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const res = e.results[i];
                    if (res.isFinal) {
                        if (onFinal) onFinal(res[0].transcript);
                    } else {
                        interim += res[0].transcript;
                    }
                }
                if (onInterim) onInterim(interim);
            };

            r.onerror = (e) => {
                if (onError) onError(e.error);
                // Permission / hardware errors are terminal — drop out of listening.
                if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
                    active = false;
                    stopping = true;
                    if (onState) onState(false);
                }
            };

            r.onend = () => {
                // Chrome ends the session after a silence window; transparently
                // restart so a single mic toggle feels continuous.
                if (active && !stopping) {
                    try { r.start(); return; } catch (_) { /* fall through */ }
                }
                active = false;
                if (onState) onState(false);
            };

            return r;
        }

        return {
            get active() { return active; },
            get supported() { return true; },
            start() {
                if (active) return;
                rec = build();
                active = true;
                stopping = false;
                try {
                    rec.start();
                    if (onState) onState(true);
                } catch (_) {
                    active = false;
                    if (onState) onState(false);
                }
            },
            stop() {
                stopping = true;
                active = false;
                if (rec) { try { rec.stop(); } catch (_) {} }
                if (onState) onState(false);
            },
            toggle() { if (active) this.stop(); else this.start(); },
        };
    };
})();
