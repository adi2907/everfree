/* ════════════════════════════════════════════════════════════
   EverFree — Mobile Client
   ════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    const LS_TOKEN = 'everfree-token';
    const LS_USER  = 'everfree-user';
    const LS_REPO  = 'everfree-repo';
    const DEFAULT_REPO = 'everfree-notes';
    const EVERFREE_REPO_DESCRIPTION_MARKER = 'git-backed markdown notes';

    // ── State ────────────────────────────────────────────────
    let token      = localStorage.getItem(LS_TOKEN);
    let user       = localStorage.getItem(LS_USER);
    let repoFull   = localStorage.getItem(LS_REPO);
    let defaultBranch = 'main';

    let notebooks       = [];
    let notesByNotebook = {};
    let fileShas        = {};
    let noteContentCache = {};
    let allNotesLoaded  = false;

    let captureTarget = { type: 'scratch' };
    let editingNotebook = null;
    let editingNote     = null;
    let devicePollTimer = null;
    let searchSeq = 0;
    let browseSearchTimer = null;

    // ── DOM ──────────────────────────────────────────────────
    const $ = id => document.getElementById(id);

    // ── Views ────────────────────────────────────────────────
    const VIEWS = ['signin', 'loading', 'repo-picker', 'app', 'note-edit'];

    function showView(name) {
        VIEWS.forEach(v => {
            const el = $(`view-${v}`);
            if (!el) return;
            el.classList.remove('active');
            el.classList.add('hidden');
        });
        const el = $(`view-${name}`);
        if (el) {
            el.classList.remove('hidden');
            el.classList.add('active');
        }
    }

    // ── GitHub Device Flow ───────────────────────────────────
    async function startDeviceFlow() {
        $('si-idle').classList.add('hidden');
        $('si-error').classList.add('hidden');
        $('si-pending').classList.remove('hidden');

        try {
            const r = await fetch('/api/github/device-start', { method: 'POST' });
            const data = await r.json();
            if (!r.ok || data.error) throw new Error(data.error_description || data.error || 'Failed to start');
            $('user-code').textContent = data.user_code;
            const link = $('verify-url');
            link.href = data.verification_uri;
            link.textContent = data.verification_uri.replace(/^https?:\/\//, '');
            pollDeviceFlow(data.device_code, data.interval || 5);
        } catch (err) {
            showSigninError(err.message);
        }
    }

    function pollDeviceFlow(deviceCode, intervalSec) {
        let interval = intervalSec * 1000;
        const tick = async () => {
            try {
                const r = await fetch('/api/github/device-poll', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_code: deviceCode }),
                });
                const data = await r.json();
                if (data.error === 'authorization_pending') { devicePollTimer = setTimeout(tick, interval); return; }
                if (data.error === 'slow_down') { interval += 5000; devicePollTimer = setTimeout(tick, interval); return; }
                if (data.error) throw new Error(data.error_description || data.error);
                if (data.access_token) {
                    token = data.access_token;
                    localStorage.setItem(LS_TOKEN, token);
                    await fetchUserAndConnect();
                }
            } catch (err) {
                showSigninError(err.message);
            }
        };
        devicePollTimer = setTimeout(tick, interval);
    }

    function showSigninError(msg) {
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        $('si-idle').classList.add('hidden');
        $('si-pending').classList.add('hidden');
        $('si-error').classList.remove('hidden');
        $('error-msg').textContent = msg;
    }

    async function fetchUserAndConnect() {
        try {
            const me = await gh('GET', '/user');
            user = me.login;
            localStorage.setItem(LS_USER, user);
            showView('loading');
            await autoConnectRepo();
        } catch (err) {
            showSigninError('Failed to get user: ' + err.message);
        }
    }

    // ── GitHub API ───────────────────────────────────────────
    async function gh(method, path, body) {
        const url = path.startsWith('http') ? path : 'https://api.github.com' + path;
        const opts = {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        if (r.status === 401) { signOut(); throw new Error('Session expired.'); }
        if (r.status === 204) return null;
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || `${method} ${path}: ${r.status}`);
        return data;
    }

    // ── Auto-connect to everfree-notes ───────────────────────
    async function autoConnectRepo() {
        if (repoFull) { await enterApp(); return; }

        $('loading-text').textContent = 'Connecting to your notes…';
        try {
            const repo = await findEverFreeRepo();
            if (repo) {
                rememberRepo(repo);
                await enterApp();
                return;
            }
            await createDefaultRepo();
        } catch (err) {
            console.warn('Repo auto-connect failed:', err);
            await showRepoPicker();
        }
    }

    async function createDefaultRepo() {
        $('loading-text').textContent = 'Creating your notes repository…';
        try {
            const repo = await gh('POST', '/user/repos', {
                name: DEFAULT_REPO,
                private: true,
                description: 'EverFree — Git-backed Markdown notes',
                auto_init: true,
            });
            rememberRepo(repo);
            await enterApp();
        } catch (err) {
            if (/422/.test(err.message)) {
                const repo = await gh('GET', `/repos/${user}/${DEFAULT_REPO}`);
                rememberRepo(repo);
                await enterApp();
            } else {
                await showRepoPicker();
            }
        }
    }

    async function findEverFreeRepo() {
        try {
            return await gh('GET', `/repos/${user}/${DEFAULT_REPO}`);
        } catch (err) {
            if (!isNotFoundError(err)) throw err;
        }

        const repos = await fetchUserRepos();
        const candidates = repos
            .filter(isEverFreeRepo)
            .sort(compareEverFreeRepos);

        return candidates[0] || null;
    }

    async function fetchUserRepos() {
        const repos = [];
        for (let page = 1; page <= 10; page += 1) {
            const batch = await gh('GET', `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`);
            if (!Array.isArray(batch) || batch.length === 0) break;
            repos.push(...batch);
            if (batch.length < 100) break;
        }
        return repos;
    }

    function isEverFreeRepo(repo) {
        const name = String(repo.name || '').toLowerCase();
        const description = String(repo.description || '').toLowerCase();
        return name === DEFAULT_REPO ||
            (description.includes('everfree') && description.includes(EVERFREE_REPO_DESCRIPTION_MARKER));
    }

    function compareEverFreeRepos(a, b) {
        const scoreDiff = repoScore(b) - repoScore(a);
        if (scoreDiff) return scoreDiff;
        return new Date(b.pushed_at || b.updated_at || 0) - new Date(a.pushed_at || a.updated_at || 0);
    }

    function repoScore(repo) {
        const name = String(repo.name || '').toLowerCase();
        const description = String(repo.description || '').toLowerCase();
        let score = 0;
        if (name === DEFAULT_REPO) score += 100;
        if (description.includes(EVERFREE_REPO_DESCRIPTION_MARKER)) score += 40;
        if (description.includes('everfree')) score += 20;
        if (repo.private) score += 10;
        if (!repo.fork) score += 5;
        return score;
    }

    function rememberRepo(repo) {
        repoFull = repo.full_name;
        defaultBranch = repo.default_branch || 'main';
        localStorage.setItem(LS_REPO, repoFull);
    }

    function clearRememberedRepo() {
        repoFull = null;
        defaultBranch = 'main';
        localStorage.removeItem(LS_REPO);
    }

    function isNotFoundError(err) {
        return /404|Not Found/i.test(err && err.message ? err.message : String(err));
    }

    // ── Enter App ────────────────────────────────────────────
    async function enterApp() {
        try {
            const meta = await gh('GET', `/repos/${repoFull}`);
            defaultBranch = meta.default_branch || 'main';
        } catch (err) {
            if (isNotFoundError(err) && repoFull) {
                clearRememberedRepo();
                await autoConnectRepo();
                return;
            }
            console.error('Failed to load repo:', err);
            showView('signin');
            showSigninError('Failed to load repository: ' + err.message);
            return;
        }

        // Pre-fetch today's scratch SHA in background (avoids save race)
        prefetchScratchSha();

        showView('app');
        $('acct-username').textContent = user || '—';
        $('acct-repo').textContent = repoFull || '—';
        updateTargetLabel();
    }

    // ── Contents API ─────────────────────────────────────────
    async function listContents(path = '') {
        try {
            const data = await gh('GET', `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
            return Array.isArray(data) ? data : [data];
        } catch (err) {
            if (/404|Not Found/i.test(err.message)) return [];
            throw err;
        }
    }

    async function getFile(path) {
        const data = await gh('GET', `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
        const content = b64Decode(data.content.replace(/\n/g, ''));
        fileShas[path] = data.sha;
        noteContentCache[path] = content;
        return { content, sha: data.sha };
    }

    async function putFile(path, content, message) {
        const body = {
            message: message || `Update ${path}`,
            content: b64Encode(content),
            branch: defaultBranch,
        };
        if (fileShas[path]) body.sha = fileShas[path];
        const data = await gh('PUT', `/repos/${repoFull}/contents/${encodeURI(path)}`, body);
        if (data && data.content) fileShas[path] = data.content.sha;
        noteContentCache[path] = content;
        return data;
    }

    function b64Encode(str) { return btoa(unescape(encodeURIComponent(str))); }
    function b64Decode(str) { return decodeURIComponent(escape(atob(str))); }

    // ── Scratch Pad ──────────────────────────────────────────
    function todayStr() { return new Date().toISOString().split('T')[0]; }
    function scratchPath() { return `Scratch/${todayStr()}.md`; }

    async function prefetchScratchSha() {
        const path = scratchPath();
        if (fileShas[path]) return;
        try {
            const data = await gh('GET', `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
            fileShas[path] = data.sha;
        } catch (_) {}
    }

    async function saveCapture() {
        const text = $('capture-area').value.trim();
        if (!text) return;

        const btn = $('btn-save');
        btn.textContent = 'Saving…';
        btn.disabled = true;

        try {
            if (captureTarget.type === 'scratch') {
                await saveScratch(text);
            } else {
                await appendToNote(captureTarget.notebook, captureTarget.note, text);
            }
            $('capture-area').value = '';
            btn.disabled = true; // stays disabled until user types again
            showToast('Saved ✓');
        } catch (err) {
            showToast('Save failed: ' + err.message, 'error');
        } finally {
            btn.textContent = 'Save';
        }
    }

    async function saveScratch(text) {
        const path = scratchPath();
        const date = todayStr();
        const timeStr = new Date().toTimeString().slice(0, 5);

        if (!fileShas[path]) {
            // Create new daily file
            const content = `# Scratch — ${date}\n\n**${timeStr}** — ${text}\n`;
            await putFile(path, content, `Scratch: ${date}`);
        } else {
            // Append to existing daily file
            const { content: existing } = await getFile(path);
            const appended = existing.trimEnd() + `\n\n---\n\n**${timeStr}** — ${text}\n`;
            await putFile(path, appended, `Scratch: append ${date}`);
        }
    }

    async function appendToNote(notebook, note, text) {
        const path = `${notebook}/${note}`;
        const timeStr = new Date().toTimeString().slice(0, 5);
        const { content: existing } = await getFile(path);
        const appended = existing.trimEnd() + `\n\n---\n\n**${timeStr}** — ${text}\n`;
        await putFile(path, appended, `Append to ${path}`);
    }

    // ── Browse Tab ───────────────────────────────────────────
    async function initBrowseTab() {
        if (allNotesLoaded) { await renderNoteList($('browse-search').value); return; }
        $('note-list').innerHTML = '<div class="list-loading">Loading…</div>';
        await loadAllContent();
        await renderNoteList($('browse-search').value);
    }

    async function loadAllContent() {
        try {
            const root = await listContents('');
            notebooks = root
                .filter(item => item.type === 'dir' && !item.name.startsWith('.'))
                .map(item => item.name)
                .sort();

            notesByNotebook = {};
            await Promise.all(notebooks.map(async nb => {
                const items = await listContents(nb);
                const notes = items
                    .filter(item => item.type === 'file' && item.name.endsWith('.md'))
                    .map(item => {
                        fileShas[`${nb}/${item.name}`] = item.sha;
                        return item.name;
                    })
                    .sort();
                notesByNotebook[nb] = notes;
            }));
            allNotesLoaded = true;
        } catch (err) {
            $('note-list').innerHTML = `<div class="list-empty">Failed to load: ${esc(err.message)}</div>`;
        }
    }

    async function renderNoteList(filter = '') {
        const $list = $('note-list');
        const query = filter.trim();
        if (query) {
            await renderSearchResults(query);
            return;
        }

        searchSeq += 1;
        $list.innerHTML = '';
        let count = 0;

        for (const nb of notebooks) {
            const notes = notesByNotebook[nb] || [];
            if (notes.length === 0) continue;

            const $header = document.createElement('div');
            $header.className = 'list-section-header';
            $header.textContent = nb;
            $list.appendChild($header);

            for (const note of notes) {
                const $row = document.createElement('div');
                $row.className = 'note-row';
                $row.innerHTML = `<span class="note-row-name">${esc(note.replace(/\.md$/, ''))}</span><svg class="note-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
                $row.addEventListener('click', () => openNoteEdit(nb, note));
                $list.appendChild($row);
                count++;
            }
        }

        if (count === 0) {
            $list.innerHTML = '<div class="list-empty">No notes yet.</div>';
        }
    }

    async function renderSearchResults(query) {
        const seq = ++searchSeq;
        const $list = $('note-list');
        $list.innerHTML = '<div class="list-loading">Searching note contents…</div>';

        try {
            const results = await searchNotes(query);
            if (seq !== searchSeq) return;

            $list.innerHTML = '';
            if (results.length === 0) {
                $list.innerHTML = '<div class="list-empty">No notes match.</div>';
                return;
            }

            const $header = document.createElement('div');
            $header.className = 'list-section-header';
            $header.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
            $list.appendChild($header);

            for (const result of results) {
                const $row = document.createElement('div');
                $row.className = 'note-row search-result-row';
                $row.innerHTML = `
                    <span class="search-result-text">
                        <span class="note-row-name">${esc(result.title)}</span>
                        <span class="search-result-meta">${esc(result.notebook)}</span>
                        ${result.snippet ? `<span class="search-result-snippet">${esc(result.snippet)}</span>` : ''}
                    </span>
                    <svg class="note-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                `;
                $row.addEventListener('click', () => openNoteEdit(result.notebook, result.note));
                $list.appendChild($row);
            }
        } catch (err) {
            if (seq !== searchSeq) return;
            $list.innerHTML = `<div class="list-empty">Search failed: ${esc(err.message)}</div>`;
        }
    }

    async function searchNotes(query) {
        const results = [];
        const lowerQuery = query.toLowerCase();

        for (const nb of notebooks) {
            for (const note of notesByNotebook[nb] || []) {
                const path = `${nb}/${note}`;
                const title = note.replace(/\.md$/, '');
                let content = '';
                try {
                    content = await getCachedFileContent(path);
                } catch (_) {
                    continue;
                }

                const titleMatch = title.toLowerCase().includes(lowerQuery);
                const notebookMatch = nb.toLowerCase().includes(lowerQuery);
                const contentMatch = content.toLowerCase().includes(lowerQuery);

                if (!titleMatch && !notebookMatch && !contentMatch) continue;

                results.push({
                    notebook: nb,
                    note,
                    title,
                    snippet: makeSnippet(content, query),
                });
                if (results.length >= 100) return results;
            }
        }

        return results;
    }

    async function getCachedFileContent(path) {
        if (Object.prototype.hasOwnProperty.call(noteContentCache, path)) {
            return noteContentCache[path];
        }
        const { content } = await getFile(path);
        return content;
    }

    function makeSnippet(content, query, size = 140) {
        const idx = content.toLowerCase().indexOf(query.toLowerCase());
        if (idx < 0) return '';
        const start = Math.max(0, idx - Math.floor(size / 2));
        const end = Math.min(content.length, idx + query.length + Math.floor(size / 2));
        let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet += '...';
        return snippet;
    }

    // ── Note Editor ──────────────────────────────────────────
    async function openNoteEdit(notebook, note) {
        editingNotebook = notebook;
        editingNote = note;
        $('editor-title').textContent = note.replace(/\.md$/, '');
        $('note-edit-area').value = '';
        $('note-edit-area').disabled = true;
        $('btn-save-note').disabled = true;
        showView('note-edit');

        try {
            const { content } = await getFile(`${notebook}/${note}`);
            $('note-edit-area').value = content;
            $('note-edit-area').disabled = false;
            $('btn-save-note').disabled = false;
        } catch (err) {
            $('note-edit-area').value = `Error loading note: ${err.message}`;
        }
    }

    async function saveNoteEdit() {
        if (!editingNotebook || !editingNote) return;
        const btn = $('btn-save-note');
        btn.textContent = 'Saving…';
        btn.disabled = true;
        try {
            const path = `${editingNotebook}/${editingNote}`;
            await putFile(path, $('note-edit-area').value, `Update ${path}`);
            showToast('Saved ✓');
        } catch (err) {
            showToast('Save failed: ' + err.message, 'error');
        } finally {
            btn.textContent = 'Save';
            btn.disabled = false;
        }
    }

    // ── Target Picker ────────────────────────────────────────
    function updateTargetLabel() {
        const $label = $('target-label');
        if (!$label) return;
        if (captureTarget.type === 'scratch') {
            $label.textContent = `Scratch · ${todayStr()}`;
        } else {
            $label.textContent = `${captureTarget.notebook} · ${captureTarget.note.replace(/\.md$/, '')}`;
        }
    }

    function openTargetDrawer() {
        renderTargetList();
        $('target-drawer').classList.remove('hidden');
        $('drawer-overlay').classList.remove('hidden');
    }

    function closeTargetDrawer() {
        $('target-drawer').classList.add('hidden');
        $('drawer-overlay').classList.add('hidden');
    }

    function renderTargetList() {
        const $list = $('target-list');
        $list.innerHTML = '';

        // Scratch (default)
        const $scratch = document.createElement('div');
        $scratch.className = 'target-row' + (captureTarget.type === 'scratch' ? ' selected' : '');
        $scratch.innerHTML = `<span class="target-row-icon">📅</span><div class="target-row-text"><div class="target-row-name">Scratch · Today</div><div class="target-row-sub">${scratchPath()}</div></div>`;
        $scratch.addEventListener('click', () => {
            captureTarget = { type: 'scratch' };
            updateTargetLabel();
            closeTargetDrawer();
        });
        $list.appendChild($scratch);

        if (!allNotesLoaded) {
            $list.insertAdjacentHTML('beforeend', '<div class="list-loading">Loading notes…</div>');
            loadAllContent().then(() => { if (!$('target-drawer').classList.contains('hidden')) renderTargetList(); });
            return;
        }

        for (const nb of notebooks) {
            const notes = notesByNotebook[nb] || [];
            if (notes.length === 0) continue;

            const $header = document.createElement('div');
            $header.className = 'target-section-header';
            $header.textContent = nb;
            $list.appendChild($header);

            for (const note of notes) {
                const $row = document.createElement('div');
                const isSelected = captureTarget.type === 'note' && captureTarget.notebook === nb && captureTarget.note === note;
                $row.className = 'target-row' + (isSelected ? ' selected' : '');
                $row.innerHTML = `<span class="target-row-icon">📝</span><div class="target-row-text"><div class="target-row-name">${esc(note.replace(/\.md$/, ''))}</div><div class="target-row-sub">${esc(nb)}</div></div>`;
                $row.addEventListener('click', () => {
                    captureTarget = { type: 'note', notebook: nb, note };
                    updateTargetLabel();
                    closeTargetDrawer();
                });
                $list.appendChild($row);
            }
        }
    }

    // ── Repo Picker ──────────────────────────────────────────
    async function showRepoPicker() {
        showView('repo-picker');
        const $list = $('rp-list');
        $list.innerHTML = '<div class="list-loading">Loading repositories…</div>';

        let allRepos = [];
        try {
            allRepos = await fetchUserRepos();
            renderRepoList(allRepos, '');
        } catch (err) {
            $list.innerHTML = `<div class="list-empty">Error: ${esc(err.message)}</div>`;
            return;
        }

        $('rp-search').addEventListener('input', (e) => {
            renderRepoList(allRepos, e.target.value);
        });
    }

    function renderRepoList(repos, filter) {
        const $list = $('rp-list');
        const q = filter.toLowerCase();
        const filtered = q ? repos.filter(r => r.full_name.toLowerCase().includes(q)) : repos;
        $list.innerHTML = '';
        if (filtered.length === 0) {
            $list.innerHTML = '<div class="list-empty">No repositories found.</div>';
            return;
        }
        for (const r of filtered) {
            const $row = document.createElement('div');
            $row.className = 'repo-row';
            $row.innerHTML = `<div class="repo-row-name">${esc(r.full_name)}</div><div class="repo-row-meta">${r.private ? 'private' : 'public'} · ${esc(r.default_branch || 'main')}</div>`;
            $row.addEventListener('click', async () => {
                rememberRepo(r);
                allNotesLoaded = false;
                notebooks = [];
                notesByNotebook = {};
                fileShas = {};
                noteContentCache = {};
                showView('loading');
                $('loading-text').textContent = 'Loading your notes…';
                await enterApp();
            });
            $list.appendChild($row);
        }
    }

    // ── Tab Switching ────────────────────────────────────────
    function switchTab(name) {
        ['capture', 'browse', 'account'].forEach(t => {
            const pane = $(`tab-${t}`);
            pane.classList.toggle('active', t === name);
            pane.classList.toggle('hidden', t !== name);
        });
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === name);
        });
        if (name === 'browse') initBrowseTab();
    }

    // ── Sign Out ─────────────────────────────────────────────
    function signOut() {
        token = null; user = null; repoFull = null;
        localStorage.removeItem(LS_TOKEN);
        localStorage.removeItem(LS_USER);
        localStorage.removeItem(LS_REPO);
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        allNotesLoaded = false; notebooks = []; notesByNotebook = {}; fileShas = {}; noteContentCache = {};
        $('si-idle').classList.remove('hidden');
        $('si-pending').classList.add('hidden');
        $('si-error').classList.add('hidden');
        showView('signin');
    }

    // ── Toast ────────────────────────────────────────────────
    let toastTimer = null;
    function showToast(msg, type = 'success') {
        const $t = $('toast');
        $t.textContent = msg;
        $t.className = `toast toast-${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => $t.classList.add('hidden'), 2500);
    }

    // ── Utility ──────────────────────────────────────────────
    function esc(str) {
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }

    // ── Event Bindings ────────────────────────────────────────
    $('btn-signin').addEventListener('click', startDeviceFlow);
    $('btn-retry').addEventListener('click', () => {
        $('si-error').classList.add('hidden');
        $('si-idle').classList.remove('hidden');
    });

    $('btn-save').addEventListener('click', saveCapture);
    $('capture-area').addEventListener('input', () => {
        $('btn-save').disabled = $('capture-area').value.trim() === '';
    });

    $('btn-target').addEventListener('click', openTargetDrawer);
    $('btn-close-drawer').addEventListener('click', closeTargetDrawer);
    $('drawer-overlay').addEventListener('click', closeTargetDrawer);

    $('browse-search').addEventListener('input', e => {
        clearTimeout(browseSearchTimer);
        browseSearchTimer = setTimeout(() => renderNoteList(e.target.value), 250);
    });

    $('btn-back-browse').addEventListener('click', () => showView('app'));
    $('btn-save-note').addEventListener('click', saveNoteEdit);

    $('btn-signout').addEventListener('click', signOut);
    $('btn-switch-repo').addEventListener('click', async () => {
        clearRememberedRepo();
        allNotesLoaded = false;
        notebooks = [];
        notesByNotebook = {};
        noteContentCache = {};
        await showRepoPicker();
    });

    $('btn-rp-back').addEventListener('click', () => {
        if (repoFull) showView('app');
        else showView('signin');
    });
    $('btn-rp-signout').addEventListener('click', signOut);

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // ── Init ─────────────────────────────────────────────────
    if (token && user && repoFull) {
        showView('loading');
        $('loading-text').textContent = 'Loading your notes…';
        enterApp();
    } else if (token && user) {
        showView('loading');
        autoConnectRepo().catch(err => {
            showSigninError(err.message);
            showView('signin');
        });
    } else {
        showView('signin');
    }
})();
