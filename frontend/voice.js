/* ════════════════════════════════════════════════════════════
   EverFree — Voice input (Web Speech API)
   Dictation helper shared by the notes editor and the assistant prompt.
   Runs entirely via the browser's built-in SpeechRecognition (live,
   streaming).

   This file is duplicated as web/voice.js for the hosted clients; keep the
   two identical.
   ════════════════════════════════════════════════════════════ */
(() => {
    "use strict";

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    window.voiceInputSupported = !!SR;

    // Errors that mean this session cannot continue. Anything else (notably
    // "network", a wifi blip) is transient: the engine keeps listening, so it
    // must not be reported as a stop.
    const TERMINAL_ERRORS = ["not-allowed", "service-not-allowed", "audio-capture"];

    /**
     * Create a dictation controller.
     * @param {object} cb
     * @param {(text:string)=>void} [cb.onInterim] in-progress transcript (not final)
     * @param {(text:string)=>void} [cb.onFinal]   each finalized chunk (append this)
     * @param {(active:boolean)=>void} [cb.onState] listening started/stopped
     * @param {(err:string)=>void} [cb.onError]    recognition error code. Only
     *        fires when dictation has actually stopped, so callers may safely
     *        clear their listening indicator from it.
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
                // stop() still delivers results for audio already captured, so
                // without this guard a trailing phrase lands in the note after
                // the user has toggled the mic off.
                if (!active || stopping) return;

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
                // Permission / hardware errors are terminal — drop out of
                // listening and tell the caller. Transient ones are swallowed:
                // the engine is still running, and reporting them would leave
                // the UI claiming dictation stopped while speech keeps being
                // transcribed.
                if (!TERMINAL_ERRORS.includes(e.error)) return;
                active = false;
                stopping = true;
                if (onState) onState(false);
                if (onError) onError(e.error);
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
                } catch (err) {
                    // A failed start means nothing is listening, so this is
                    // terminal and worth surfacing.
                    active = false;
                    if (onState) onState(false);
                    if (onError) onError(err && err.name ? err.name : "start-failed");
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
