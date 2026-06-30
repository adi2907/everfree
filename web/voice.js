/* ════════════════════════════════════════════════════════════
   EverFree - Voice input (Web Speech API)
   Shared dictation helper for the hosted web and mobile clients.
   ════════════════════════════════════════════════════════════ */
(() => {
    "use strict";

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    window.voiceInputSupported = !!SR;

    window.createDictation = function ({ onInterim, onFinal, onState, onError, lang } = {}) {
        if (!SR) return null;

        let rec = null;
        let active = false;
        let stopping = false;

        function build() {
            const r = new SR();
            r.continuous = true;
            r.interimResults = true;
            r.lang = lang || navigator.language || "en-US";

            r.onresult = (e) => {
                let interim = "";
                for (let i = e.resultIndex; i < e.results.length; i += 1) {
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
                if (["not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) {
                    active = false;
                    stopping = true;
                    if (onState) onState(false);
                }
            };

            r.onend = () => {
                if (active && !stopping) {
                    try {
                        r.start();
                        return;
                    } catch (_) {
                        /* fall through */
                    }
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
                    active = false;
                    if (onState) onState(false);
                    if (onError) onError(err && err.name ? err.name : "start-failed");
                }
            },
            stop() {
                stopping = true;
                active = false;
                if (rec) {
                    try { rec.stop(); } catch (_) {}
                }
                if (onState) onState(false);
            },
            toggle() {
                if (active) this.stop();
                else this.start();
            },
        };
    };
})();
