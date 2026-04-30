/* ════════════════════════════════════════════════════════════
   EverFree — Setup Wizard (OAuth Flows)
   ════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    const EVERNOTE_POLL_INTERVAL_MS = 5000;
    const EVERNOTE_POLL_RETRY_INTERVAL_MS = 7000;
    const IMPORT_TOOL_POLL_INTERVAL_MS = 2500;

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

    // Import tools
    const $importToolStatus  = $("import-tool-status");
    const $importToolSpinner = $("import-tool-spinner");
    const $importToolCheck   = $("import-tool-check");
    const $importToolTitle   = $("import-tool-title");
    const $importToolDetail  = $("import-tool-detail");
    const $importToolActions = $("import-tool-actions");
    const $importToolCommand = $("import-tool-command");

    // GitHub
    const $ghSetup       = $("github-setup");
    const $ghPending     = $("github-pending");
    const $ghAuthorized  = $("github-authorized");
    const $ghError       = $("github-error");
    const $ghUsername    = $("github-username");
    const $ghRepo        = $("github-repo");
    const $ghErrDetail   = $("github-error-detail");

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
    const $btnInstallTool = $("btn-install-evernote2md");
    const $btnRecheckTool = $("btn-recheck-import-tools");
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

    async function checkImportTools() {
        try {
            const resp = await fetch("/api/setup/import-tools/status");
            const data = await resp.json();
            renderImportToolStatus(data);

            if (data.install && data.install.running) {
                setTimeout(checkImportTools, IMPORT_TOOL_POLL_INTERVAL_MS);
            }

            return data.evernote2md && data.evernote2md.installed;
        } catch (e) {
            renderImportToolError("Could not check import tools: " + e.message);
            return false;
        }
    }

    function renderImportToolStatus(data) {
        const installed = data.evernote2md && data.evernote2md.installed;
        const installing = data.install && data.install.running;
        const installError = data.install && data.install.error;
        const hasBrew = data.homebrew && data.homebrew.installed;

        $importToolStatus.classList.toggle("tool-ok", installed);
        $importToolStatus.classList.toggle("tool-error", Boolean(installError) || (!installed && !installing && !hasBrew));
        $importToolSpinner.classList.toggle("hidden", installed || !installing);
        $importToolCheck.classList.toggle("hidden", !installed);
        $importToolActions.classList.toggle("hidden", installed || installing);
        $importToolCommand.classList.add("hidden");
        $btnInstallTool.classList.toggle("hidden", !hasBrew || installed);
        $btnInstallTool.disabled = installing;
        $btnEnConnect.disabled = !installed;

        if (installed) {
            $importToolTitle.textContent = "Evernote converter ready";
            $importToolDetail.textContent = data.evernote2md.path || "evernote2md is installed.";
            return;
        }

        if (installing) {
            $importToolTitle.textContent = "Installing Evernote converter…";
            $importToolDetail.textContent = data.install.detail || "Running brew install evernote2md.";
            return;
        }

        if (installError) {
            $importToolTitle.textContent = "Converter install failed";
            $importToolDetail.textContent = installError;
            return;
        }

        $importToolTitle.textContent = "Evernote converter required";
        if (hasBrew) {
            $importToolDetail.textContent = "EverFree can install evernote2md with Homebrew after you approve it.";
        } else {
            $importToolDetail.textContent = "Homebrew is required to install evernote2md.";
            $importToolCommand.textContent = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
            $importToolCommand.classList.remove("hidden");
        }
    }

    function renderImportToolError(message) {
        $importToolStatus.classList.add("tool-error");
        $importToolSpinner.classList.add("hidden");
        $importToolCheck.classList.add("hidden");
        $importToolActions.classList.remove("hidden");
        $btnInstallTool.classList.add("hidden");
        $btnEnConnect.disabled = true;
        $importToolTitle.textContent = "Import tool check failed";
        $importToolDetail.textContent = message;
    }

    $btnInstallTool.addEventListener("click", async () => {
        $btnInstallTool.disabled = true;
        $importToolTitle.textContent = "Starting installer…";
        $importToolDetail.textContent = "Running brew install evernote2md.";
        try {
            const resp = await fetch("/api/setup/import-tools/install", { method: "POST" });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || "Failed to start installer");
            }
            checkImportTools();
        } catch (e) {
            renderImportToolError(e.message);
        }
    });

    $btnRecheckTool.addEventListener("click", checkImportTools);

    $btnEnConnect.addEventListener("click", async () => {
        if (!await checkImportTools()) return;
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
        try {
            const resp = await fetch("/api/auth/github/start", { method: "POST" });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || "Failed to start auth");
            }

            const data = await resp.json();

            if (!data.user_code) throw new Error("No user code returned from GitHub. Is Device Flow enabled for your OAuth App?");

            showGhState("pending");

            // Set after revealing — Safari doesn't re-render text set on hidden elements
            $("github-user-code").textContent = data.user_code;
            const uriEl = $("github-verification-uri");
            uriEl.href = data.verification_uri;
            uriEl.textContent = data.verification_uri;

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
                const resp = await fetch("/api/auth/github/status");
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
        }, 2000);
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
            if (data.configured) {
                window.location.href = "/";
            } else if (data.evernote_synced) {
                // Notes already imported — skip straight to GitHub step
                skipEvernote = true;
                goToStep(2);
            }
        } catch { /* proceed with setup */ }
        checkImportTools();
    })();
})();
