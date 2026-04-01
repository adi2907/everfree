/* ════════════════════════════════════════════════════════════
   ExitNote — Setup Wizard (OAuth Flows)
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    const EVERNOTE_POLL_INTERVAL_MS = 5000;
    const EVERNOTE_POLL_RETRY_INTERVAL_MS = 7000;

    // ── State ───────────────────────────────────────────────
    let currentStep = 1;
    let skipEvernote = false;
    let githubPollTimer = null;

    // ── DOM refs ────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const $step1      = $("step-1");
    const $step2      = $("step-2");
    const $step3      = $("step-3");
    const $indicators = $("step-indicators");

    // Evernote
    const $enIdle     = $("evernote-idle");
    const $enRunning  = $("evernote-running");
    const $enDone     = $("evernote-done");
    const $enError    = $("evernote-error");
    const $enDetail   = $("evernote-detail");
    const $enDoneDetail = $("evernote-done-detail");
    const $enErrDetail  = $("evernote-error-detail");

    // GitHub
    const $ghSetup       = $("github-setup");
    const $ghPending     = $("github-pending");
    const $ghAuthorized  = $("github-authorized");
    const $ghError       = $("github-error");
    const $ghClientId    = $("github-client-id");
    const $ghUsername    = $("github-username");
    const $ghRepo        = $("github-repo");
    const $ghErrDetail   = $("github-error-detail");
    const $deviceCode    = $("device-code");
    const $deviceLink    = $("device-flow-link");

    // Progress
    const $progressIcon    = $("progress-icon");
    const $progressTitle   = $("progress-title");
    const $progressDetail  = $("progress-detail");
    const $progressBar     = $("progress-bar");
    const $progressSteps   = $("progress-steps");
    const $setupErrorBox   = $("setup-error-box");
    const $setupErrDetail  = $("setup-error-detail");

    // Buttons
    const $btnEnConnect   = $("btn-evernote-connect");
    const $btnEnRetry     = $("btn-evernote-retry");
    const $btnSkip        = $("btn-skip-evernote");
    const $btnNext1       = $("btn-next-1");
    const $btnGhSignin    = $("btn-github-signin");
    const $btnGhRetry     = $("btn-github-retry");
    const $btnBack2       = $("btn-back-2");
    const $btnNext2       = $("btn-next-2");
    const $btnRetrySetup  = $("btn-retry-setup");


    // ── Step navigation ─────────────────────────────────────
    function goToStep(step) {
        currentStep = step;
        [$step1, $step2, $step3].forEach((s, i) =>
            s.classList.toggle("hidden", i + 1 !== step)
        );

        const dots  = $indicators.querySelectorAll(".step-dot");
        const lines = $indicators.querySelectorAll(".step-line");
        dots.forEach((dot, i) => {
            dot.classList.toggle("active", i + 1 === step);
            dot.classList.toggle("done", i + 1 < step);
        });
        lines.forEach((line, i) => line.classList.toggle("done", i + 1 < step));
    }


    // ══════════════════════════════════════════════════════════
    //  STEP 1: EVERNOTE AUTH
    // ══════════════════════════════════════════════════════════

    function showEnState(state) {
        [$enIdle, $enRunning, $enDone, $enError].forEach(el => el.classList.add("hidden"));
        const map = { idle: $enIdle, running: $enRunning, done: $enDone, error: $enError };
        if (map[state]) map[state].classList.remove("hidden");
    }

    $btnEnConnect.addEventListener("click", async () => {
        showEnState("running");
        try {
            const resp = await fetch("/api/auth/evernote/start", { method: "POST" });
            if (!resp.ok) throw new Error((await resp.json()).detail);
            pollEvernote();
        } catch (e) {
            showEnState("error");
            $enErrDetail.textContent = e.message;
        }
    });

    async function pollEvernote() {
        try {
            const resp = await fetch("/api/auth/evernote/status");
            const data = await resp.json();

            if (data.status === "running") {
                $enDetail.textContent = data.detail || "Check your browser to authorize";
                setTimeout(pollEvernote, EVERNOTE_POLL_INTERVAL_MS);
            } else if (data.status === "done") {
                showEnState("done");
                $enDoneDetail.textContent = data.detail || "Notes imported";
                $btnNext1.disabled = false;
                skipEvernote = false;
            } else if (data.status === "error") {
                showEnState("error");
                $enErrDetail.textContent = data.error || "Unknown error";
            }
        } catch {
            setTimeout(pollEvernote, EVERNOTE_POLL_RETRY_INTERVAL_MS);
        }
    }

    $btnEnRetry.addEventListener("click", () => showEnState("idle"));

    $btnSkip.addEventListener("click", () => {
        skipEvernote = true;
        goToStep(2);
    });

    $btnNext1.addEventListener("click", () => goToStep(2));


    // ══════════════════════════════════════════════════════════
    //  STEP 2: GITHUB DEVICE FLOW
    // ══════════════════════════════════════════════════════════

    function showGhState(state) {
        [$ghSetup, $ghPending, $ghAuthorized, $ghError].forEach(el => el.classList.add("hidden"));
        const map = { setup: $ghSetup, pending: $ghPending, authorized: $ghAuthorized, error: $ghError };
        if (map[state]) map[state].classList.remove("hidden");
        $btnNext2.disabled = state !== "authorized";
    }

    $btnGhSignin.addEventListener("click", async () => {
        const clientId = $ghClientId.value.trim();
        if (!clientId) {
            $ghClientId.focus();
            return alert("Please enter your GitHub OAuth App Client ID first.");
        }

        try {
            const resp = await fetch("/api/auth/github/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ client_id: clientId }),
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || "Failed to start auth");
            }

            const data = await resp.json();
            $deviceCode.textContent = data.user_code;
            $deviceLink.href = data.verification_uri;
            showGhState("pending");

            // Auto-open GitHub in new tab
            window.open(data.verification_uri, "_blank");

            // Start polling
            startGitHubPoll();
        } catch (e) {
            showGhState("error");
            $ghErrDetail.textContent = e.message;
        }
    });

    function startGitHubPoll() {
        if (githubPollTimer) clearInterval(githubPollTimer);
        githubPollTimer = setInterval(async () => {
            try {
                const resp = await fetch("/api/auth/github/poll", { method: "POST" });
                const data = await resp.json();

                if (data.status === "authorized") {
                    clearInterval(githubPollTimer);
                    $ghUsername.textContent = data.username;
                    showGhState("authorized");
                } else if (data.status === "error") {
                    clearInterval(githubPollTimer);
                    showGhState("error");
                    $ghErrDetail.textContent = data.detail || "Authorization failed";
                }
                // else "pending" — keep polling
            } catch {
                // network error, keep polling
            }
        }, 5000);
    }

    $btnGhRetry.addEventListener("click", () => showGhState("setup"));
    $btnBack2.addEventListener("click", () => {
        if (githubPollTimer) clearInterval(githubPollTimer);
        goToStep(1);
    });


    // ══════════════════════════════════════════════════════════
    //  STEP 3: REPO CREATION + GIT PUSH
    // ══════════════════════════════════════════════════════════

    const SETUP_STEPS = [
        { key: "github_create", label: "Create private GitHub repository" },
        { key: "git_init",      label: "Initialize local Git repository" },
        { key: "git_push",      label: "Push notes to GitHub" },
        { key: "complete",      label: "All done!" },
    ];

    $btnNext2.addEventListener("click", async () => {
        const repo = $ghRepo.value.trim();
        if (!repo) {
            $ghRepo.focus();
            return alert("Please enter a repository name.");
        }
        if (!/^[a-zA-Z0-9._-]+$/.test(repo)) {
            $ghRepo.focus();
            return alert("Invalid repo name. Use letters, numbers, hyphens, underscores, dots.");
        }

        goToStep(3);

        // Render progress step items
        $progressSteps.innerHTML = SETUP_STEPS.map(s =>
            `<div class="progress-step-item" data-key="${s.key}">
                <span class="step-icon">○</span>
                <span>${s.label}</span>
            </div>`
        ).join("");

        $setupErrorBox.classList.add("hidden");
        $progressIcon.textContent = "⚙️";
        $progressIcon.classList.remove("done");
        $progressTitle.textContent = "Creating your repository…";
        $progressDetail.textContent = "Starting…";
        $progressBar.style.width = "0%";

        try {
            const resp = await fetch("/api/setup/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo_name: repo }),
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || "Failed to start setup");
            }
            pollSetup();
        } catch (e) {
            $progressIcon.textContent = "❌";
            $progressIcon.classList.add("done");
            $progressTitle.textContent = "Setup Failed";
            $setupErrorBox.classList.remove("hidden");
            $setupErrDetail.textContent = e.message;
        }
    });

    async function pollSetup() {
        try {
            const resp = await fetch("/api/setup/progress");
            const data = await resp.json();
            updateSetupUI(data);

            if (!data.complete && !data.error) {
                setTimeout(pollSetup, 800);
            }
        } catch {
            setTimeout(pollSetup, 1500);
        }
    }

    function updateSetupUI(data) {
        const currentKey = data.step;
        const currentIdx = SETUP_STEPS.findIndex(s => s.key === currentKey);
        const pct = Math.max(0, Math.min(100, ((currentIdx + 1) / SETUP_STEPS.length) * 100));

        $progressBar.style.width = pct + "%";
        $progressDetail.textContent = data.detail || "";

        const items = $progressSteps.querySelectorAll(".progress-step-item");
        items.forEach((item, i) => {
            const icon = item.querySelector(".step-icon");
            if (i < currentIdx) {
                item.className = "progress-step-item done";
                icon.textContent = "✓";
            } else if (item.getAttribute("data-key") === currentKey) {
                item.className = "progress-step-item active";
                icon.textContent = "⟳";
            } else {
                item.className = "progress-step-item";
                icon.textContent = "○";
            }
        });

        if (data.error) {
            $progressIcon.textContent = "❌";
            $progressIcon.classList.add("done");
            $progressTitle.textContent = "Setup Failed";
            $setupErrorBox.classList.remove("hidden");
            $setupErrDetail.textContent = data.error;
        }

        if (data.complete) {
            $progressIcon.textContent = "🎉";
            $progressIcon.classList.add("done");
            $progressTitle.textContent = "You're all set!";
            $progressDetail.textContent = "Redirecting to your notes…";
            $progressBar.style.width = "100%";
            items.forEach(item => {
                item.className = "progress-step-item done";
                item.querySelector(".step-icon").textContent = "✓";
            });
            setTimeout(() => { window.location.href = "/"; }, 1500);
        }
    }

    $btnRetrySetup.addEventListener("click", () => goToStep(2));


    // ── Init ────────────────────────────────────────────────
    (async () => {
        try {
            const resp = await fetch("/api/setup/status");
            const data = await resp.json();
            if (data.configured) window.location.href = "/";
        } catch { /* proceed with setup */ }
    })();
})();
