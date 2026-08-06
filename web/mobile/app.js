/* ════════════════════════════════════════════════════════════
   EverFree — Mobile Client
   ════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    const AUTH_TOKEN_KEY = 'everfree-token';
    const AUTH_USER_KEY  = 'everfree-user';
    const AUTH_REPO_KEY  = 'everfree-repo';
    const AUTH_EXPIRES_KEY = 'everfree-token-expires-at';
    // Owned by assistant.js, cleared here: sign-out lives in this file.
    const ASSISTANT_KEYS = ['everfree-gemini-key', 'everfree-openrouter-key'];
    const DEFAULT_REPO = 'everfree-notes';

    // A session lasts until the user signs out — see web/app.js and ADR 0001.
    const authStore = localStorage;

    // ── State ────────────────────────────────────────────────
    let token      = authStore.getItem(AUTH_TOKEN_KEY);
    let user       = authStore.getItem(AUTH_USER_KEY);
    let repoFull   = authStore.getItem(AUTH_REPO_KEY);
    // 0 means "no expiry advertised", not "expired" — see web/app.js.
    let tokenExpiresAt = Number(authStore.getItem(AUTH_EXPIRES_KEY)) || 0;
    let defaultBranch = 'main';

    let notebooks       = [];
    let notesByNotebook = {};
    let fileShas        = {};
    let noteContentCache = {};
    let noteModifiedCache = {};
    let allNotesLoaded  = false;

    let captureTarget = { type: 'scratch' };
    let editingNotebook = null;
    let editingNote     = null;
    let devicePollTimer = null;
    let searchSeq = 0;
    let browseSearchTimer = null;
    let captureDictation = null;
    let noteDictation = null;

    // ── DOM ──────────────────────────────────────────────────
    const $ = id => document.getElementById(id);

    // ── Views ────────────────────────────────────────────────
    const VIEWS = ['signin', 'loading', 'app', 'note-edit'];

    function showView(name) {
        if (name !== 'note-edit') stopDictation(noteDictation);
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
                    tokenExpiresAt = expiryFromResponse(data);
                    authStore.setItem(AUTH_TOKEN_KEY, token);
                    authStore.setItem(AUTH_EXPIRES_KEY, String(tokenExpiresAt));
                    await fetchUserAndConnect();
                }
            } catch (err) {
                showSigninError(err.message);
            }
        };
        devicePollTimer = setTimeout(tick, interval);
    }

    // Returns an absolute expiry, or 0 when GitHub advertises none.
    function expiryFromResponse(data) {
        const seconds = Number(data.expires_in);
        return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : 0;
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
            authStore.setItem(AUTH_USER_KEY, user);
            showView('loading');
            await autoConnectRepo();
        } catch (err) {
            showView('signin');
            showSigninError(err.message);
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
        if (!r.ok) {
            const error = new Error(data.message || `${method} ${path}: ${r.status}`);
            error.status = r.status;
            throw error;
        }
        return data;
    }

    // ── Auto-connect to everfree-notes ───────────────────────
    async function autoConnectRepo() {
        $('loading-text').textContent = 'Connecting to your notes…';
        try {
            const repo = await gh('GET', `/repos/${user}/${DEFAULT_REPO}`);
            rememberRepo(repo);
            await enterApp();
            return;
        } catch (err) {
            if (!isNotFoundError(err)) throw err;
        }
        await createDefaultRepo();
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
            if (err.status === 422) {
                const repo = await gh('GET', `/repos/${user}/${DEFAULT_REPO}`);
                rememberRepo(repo);
                await enterApp();
                return;
            }
            throw err;
        }
    }

    function rememberRepo(repo) {
        const expected = `${user}/${DEFAULT_REPO}`.toLowerCase();
        if (String(repo.full_name || '').toLowerCase() !== expected) {
            throw new Error(`EverFree only supports ${user}/${DEFAULT_REPO}.`);
        }
        if (!repo.private) {
            throw new Error(`${user}/${DEFAULT_REPO} must be private before EverFree can use it.`);
        }
        repoFull = repo.full_name;
        defaultBranch = repo.default_branch || 'main';
        authStore.setItem(AUTH_REPO_KEY, repoFull);
    }

    function clearRememberedRepo() {
        repoFull = null;
        defaultBranch = 'main';
        authStore.removeItem(AUTH_REPO_KEY);
    }

    function isNotFoundError(err) {
        return /404|Not Found/i.test(err && err.message ? err.message : String(err));
    }

    // ── Enter App ────────────────────────────────────────────
    async function enterApp() {
        if (String(repoFull).toLowerCase() !== `${user}/${DEFAULT_REPO}`.toLowerCase()) {
            clearRememberedRepo();
            throw new Error(`EverFree only supports ${user}/${DEFAULT_REPO}.`);
        }
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
        noteModifiedCache[path] = Date.now();
        return data;
    }

    async function deleteFile(path, message) {
        if (!fileShas[path]) {
            const data = await gh('GET', `/repos/${repoFull}/contents/${encodeURI(path)}?ref=${defaultBranch}`);
            fileShas[path] = data.sha;
        }
        await gh('DELETE', `/repos/${repoFull}/contents/${encodeURI(path)}`, {
            message: message || `Delete ${path}`,
            sha: fileShas[path],
            branch: defaultBranch,
        });
        forgetPath(path);
    }

    // Delete a whole folder in one commit. The Contents API deletes one file per
    // request and has no recursive form, so a notebook with N notes would be N
    // commits and would strand a half-deleted folder if any of them failed. The
    // Git Data API writes a single tree with those paths removed instead — six
    // requests whether the notebook holds two notes or two hundred. web/app.js
    // carries the same helper; the two clients share no module.
    async function deleteFolder(prefix, message) {
        const ref = await gh('GET', `/repos/${repoFull}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        const head = ref.object.sha;
        const commit = await gh('GET', `/repos/${repoFull}/git/commits/${head}`);
        const tree = await gh('GET', `/repos/${repoFull}/git/trees/${commit.tree.sha}?recursive=1`);

        // Blobs only. Naming a tree with sha:null makes GitHub reject the write,
        // and dropping every blob under the folder drops the folder with them —
        // Git has no empty directories.
        const doomed = (tree.tree || []).filter(
            entry => entry.type === 'blob' && entry.path.startsWith(prefix + '/'));
        if (!doomed.length) return;

        const newTree = await gh('POST', `/repos/${repoFull}/git/trees`, {
            base_tree: commit.tree.sha,
            tree: doomed.map(entry => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: null })),
        });
        const newCommit = await gh('POST', `/repos/${repoFull}/git/commits`, {
            message: message || `Delete ${prefix}`,
            tree: newTree.sha,
            parents: [head],
        });
        await gh('PATCH', `/repos/${repoFull}/git/refs/heads/${encodeURIComponent(defaultBranch)}`, {
            sha: newCommit.sha,
        });

        for (const entry of doomed) forgetPath(entry.path);
    }

    // Drop every cached trace of a path. A stale sha here would make the next
    // write to a recreated note fail the sha check.
    function forgetPath(path) {
        delete fileShas[path];
        delete noteContentCache[path];
        delete noteModifiedCache[path];
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

    function parseNoteNameDate(name) {
        const clean = name.replace(/\.md$/, '').replace(/_/g, ' ').trim();
        const match = clean.match(/^(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
        if (!match) return null;
        
        const day = parseInt(match[1], 10);
        const monthStr = match[2].toLowerCase();
        const year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();
        
        const months = {
            jan: 0, january: 0,
            feb: 1, february: 1,
            mar: 2, march: 2,
            apr: 3, april: 3,
            may: 4,
            jun: 5, june: 5,
            jul: 6, july: 6,
            aug: 7, august: 7,
            sep: 8, september: 8,
            oct: 9, october: 9,
            nov: 10, november: 10,
            dec: 11, december: 11
        };
        
        const month = months[monthStr.substring(0, 3)];
        if (month === undefined) return null;
        
        return new Date(year, month, day).getTime();
    }

    async function getNoteLastModified(nb, noteName) {
        const path = `${nb}/${noteName}`;
        if (noteModifiedCache[path] !== undefined) {
            return noteModifiedCache[path];
        }
        try {
            const commits = await gh('GET', `/repos/${repoFull}/commits?path=${encodeURIComponent(path)}&per_page=1`);
            if (commits && commits.length > 0) {
                const time = new Date(commits[0].commit.committer.date).getTime();
                noteModifiedCache[path] = time;
                return time;
            }
        } catch (err) {
            console.error(`Failed to get modified date for ${path}:`, err);
        }
        return 0; // fallback
    }

    async function loadAllContent() {
        try {
            const root = await listContents('');
            notebooks = root
                .filter(item => item.type === 'dir' && !item.name.startsWith('.'))
                .map(item => item.name);

            notesByNotebook = {};
            const noteDates = {}; // "nb/note.md" -> timestamp
            const notebookLastModified = {}; // nb -> max timestamp

            await Promise.all(notebooks.map(async nb => {
                const items = await listContents(nb);
                const notes = items
                    .filter(item => item.type === 'file' && item.name.endsWith('.md'))
                    .map(item => {
                        fileShas[`${nb}/${item.name}`] = item.sha;
                        return item.name;
                    });

                // Fetch commit date for each note in parallel
                await Promise.all(notes.map(async noteName => {
                    const mtime = await getNoteLastModified(nb, noteName);
                    noteDates[`${nb}/${noteName}`] = mtime;
                }));

                // Sort notes in this notebook by last modified descending, then parsed date, then alphabetically
                notes.sort((a, b) => {
                    const timeA = noteDates[`${nb}/${a}`] || 0;
                    const timeB = noteDates[`${nb}/${b}`] || 0;
                    if (timeA !== timeB) return timeB - timeA;
                    
                    const dateA = parseNoteNameDate(a);
                    const dateB = parseNoteNameDate(b);
                    if (dateA !== null && dateB !== null) return dateB - dateA;
                    if (dateA !== null) return -1;
                    if (dateB !== null) return 1;
                    
                    return a.localeCompare(b);
                });

                notesByNotebook[nb] = notes;

                // Track the latest modified note time for this notebook
                const maxTime = notes.length > 0 ? (noteDates[`${nb}/${notes[0]}`] || 0) : 0;
                notebookLastModified[nb] = maxTime;
            }));

            // Sort notebooks by their latest note's modified time, then parsed date, then alphabetically
            notebooks.sort((a, b) => {
                const timeA = notebookLastModified[a] || 0;
                const timeB = notebookLastModified[b] || 0;
                if (timeA !== timeB) return timeB - timeA;
                
                const newestA = notesByNotebook[a] && notesByNotebook[a][0];
                const newestB = notesByNotebook[b] && notesByNotebook[b][0];
                
                const dateA = newestA ? parseNoteNameDate(newestA) : null;
                const dateB = newestB ? parseNoteNameDate(newestB) : null;
                if (dateA !== null && dateB !== null) return dateB - dateA;
                if (dateA !== null) return -1;
                if (dateB !== null) return 1;
                
                return a.localeCompare(b);
            });

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

        for (const nb of notebooks) {
            const notes = notesByNotebook[nb] || [];

            // Empty notebooks are listed too. Skipping them hid a notebook the
            // moment it was created, and left no way to reach its delete action.
            const $header = document.createElement('div');
            $header.className = 'list-section-header';
            $header.innerHTML = `<span class="list-section-name">${esc(nb)}</span>`;
            $header.appendChild(makeMoreButton(`Actions for ${nb}`, () => showActionSheet(nb, [
                { label: 'New note in this notebook', action: () => newNote(nb) },
                { label: 'Delete notebook', danger: true, action: () => deleteNotebook(nb) },
            ])));
            $list.appendChild($header);

            if (notes.length === 0) {
                $list.insertAdjacentHTML('beforeend', '<div class="list-empty-section">No notes yet.</div>');
                continue;
            }

            for (const note of notes) {
                $list.appendChild(makeNoteRow(nb, note));
            }
        }

        if (notebooks.length === 0) {
            $list.innerHTML = '<div class="list-empty">No notebooks yet. Tap + to create one.</div>';
        }
    }

    function makeMoreButton(label, onClick) {
        const $btn = document.createElement('button');
        $btn.type = 'button';
        $btn.className = 'row-more';
        $btn.setAttribute('aria-label', label);
        $btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
        $btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return $btn;
    }

    function makeNoteRow(nb, note) {
        const $row = document.createElement('div');
        $row.className = 'note-row';
        $row.innerHTML = `<span class="note-row-name">${esc(note.replace(/\.md$/, ''))}</span>`;
        $row.appendChild(makeMoreButton(`Actions for ${note.replace(/\.md$/, '')}`, () =>
            showActionSheet(note.replace(/\.md$/, ''), [
                { label: 'Open', action: () => openNoteEdit(nb, note) },
                { label: 'Delete note', danger: true, action: () => deleteNote(nb, note) },
            ])));
        $row.insertAdjacentHTML('beforeend', '<svg class="note-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>');
        $row.addEventListener('click', () => openNoteEdit(nb, note));
        return $row;
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
                `;
                $row.appendChild(makeMoreButton(`Actions for ${result.title}`, () =>
                    showActionSheet(result.title, [
                        { label: 'Open', action: () => openNoteEdit(result.notebook, result.note) },
                        { label: 'Delete note', danger: true, action: () => deleteNote(result.notebook, result.note) },
                    ])));
                $row.insertAdjacentHTML('beforeend', '<svg class="note-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>');
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
        stopAllDictation();
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
            window.dispatchEvent(new CustomEvent('everfree:note-changed', { detail: { notebook, note } }));
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

    // ── Voice Input ─────────────────────────────────────────
    function setMicState(id, active) {
        const btn = $(id);
        if (!btn) return;
        btn.classList.toggle('is-listening', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.title = active ? 'Stop dictation' : 'Dictate';
    }

    function stopDictation(controller) {
        if (controller && controller.active) controller.stop();
    }

    function stopAllDictation() {
        stopDictation(captureDictation);
        stopDictation(noteDictation);
    }

    function insertIntoTextarea(textarea, text) {
        const spoken = String(text || '').trim();
        if (!textarea || !spoken || textarea.disabled) return;
        const suffix = spoken + ' ';
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + suffix + textarea.value.slice(end);
        const cursor = start + suffix.length;
        textarea.selectionStart = cursor;
        textarea.selectionEnd = cursor;
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function setupDictationButton({ buttonId, textareaId, onFinal, onError }) {
        const btn = $(buttonId);
        if (!btn) return null;
        if (typeof window.createDictation !== 'function' || !window.voiceInputSupported) {
            btn.disabled = true;
            btn.title = 'Voice input is not supported in this browser';
            btn.setAttribute('aria-disabled', 'true');
            return null;
        }

        const controller = window.createDictation({
            onFinal(text) {
                insertIntoTextarea($(textareaId), text);
                if (onFinal) onFinal();
            },
            onState(active) {
                setMicState(buttonId, active);
            },
            onError(error) {
                setMicState(buttonId, false);
                if (onError) onError(error);
            },
        });

        if (!controller) {
            btn.disabled = true;
            btn.title = 'Voice input is not supported in this browser';
            btn.setAttribute('aria-disabled', 'true');
            return null;
        }

        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => {
            if ($(textareaId)?.disabled) return;
            if (buttonId === 'btn-capture-mic') stopDictation(noteDictation);
            if (buttonId === 'btn-note-mic') stopDictation(captureDictation);
            controller.toggle();
        });
        return controller;
    }

    function setupVoiceInput() {
        captureDictation = setupDictationButton({
            buttonId: 'btn-capture-mic',
            textareaId: 'capture-area',
            onFinal() {
                $('btn-save').disabled = $('capture-area').value.trim() === '';
            },
            onError(error) {
                showToast(error === 'not-allowed' ? 'Microphone permission denied' : 'Voice input stopped', 'error');
            },
        });

        noteDictation = setupDictationButton({
            buttonId: 'btn-note-mic',
            textareaId: 'note-edit-area',
            onError(error) {
                showToast(error === 'not-allowed' ? 'Microphone permission denied' : 'Voice input stopped', 'error');
            },
        });
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

    // ── Sheets ───────────────────────────────────────────────
    // Three bottom sheets share one overlay, so opening any of them closes the
    // others rather than stacking a second sheet behind the first.
    const SHEETS = ['target-drawer', 'action-sheet', 'prompt-sheet'];

    function openSheet(id) {
        for (const sheet of SHEETS) $(sheet).classList.toggle('hidden', sheet !== id);
        $('drawer-overlay').classList.remove('hidden');
    }

    function closeSheets() {
        for (const sheet of SHEETS) $(sheet).classList.add('hidden');
        $('drawer-overlay').classList.add('hidden');
        promptConfirm = null;
    }

    function openTargetDrawer() {
        renderTargetList();
        openSheet('target-drawer');
    }

    function closeTargetDrawer() {
        closeSheets();
    }

    function showActionSheet(title, items) {
        $('action-sheet-title').textContent = title;
        const $list = $('action-sheet-list');
        $list.innerHTML = '';
        for (const item of items) {
            const $row = document.createElement('button');
            $row.type = 'button';
            $row.className = 'action-row' + (item.danger ? ' action-row-danger' : '');
            $row.textContent = item.label;
            $row.addEventListener('click', () => {
                closeSheets();
                item.action();
            });
            $list.appendChild($row);
        }
        openSheet('action-sheet');
    }

    let promptConfirm = null;

    // A bottom sheet rather than window.prompt(): iOS Safari renders the native
    // dialog above the keyboard and gives no control over the input's type or
    // autocapitalisation, and it cannot carry the notebook picker a new note needs.
    function showPromptSheet(opts) {
        $('prompt-sheet-title').textContent = opts.title;
        $('prompt-label').textContent = opts.label || 'Name';
        $('btn-prompt-confirm').textContent = opts.confirmLabel || 'Create';
        const $input = $('prompt-input');
        $input.value = opts.value || '';
        $input.placeholder = opts.placeholder || '';
        $('prompt-error').classList.add('hidden');

        const $field = $('prompt-select-field');
        const $select = $('prompt-select');
        if (opts.select && opts.select.length) {
            $select.innerHTML = '';
            for (const name of opts.select) {
                const $option = document.createElement('option');
                $option.value = name;
                $option.textContent = name;
                $select.appendChild($option);
            }
            $select.value = opts.selectValue || opts.select[0];
            $field.hidden = false;
        } else {
            $field.hidden = true;
        }

        promptConfirm = opts.onConfirm;
        openSheet('prompt-sheet');
        setTimeout(() => $input.focus(), 80);
    }

    function showPromptError(message) {
        const $error = $('prompt-error');
        $error.textContent = message;
        $error.classList.remove('hidden');
    }

    async function submitPrompt() {
        if (!promptConfirm) return;
        const value = $('prompt-input').value.trim();
        if (!value) { showPromptError('Enter a name.'); return; }

        const $btn = $('btn-prompt-confirm');
        const label = $btn.textContent;
        $btn.disabled = true;
        $btn.textContent = 'Working…';
        try {
            await promptConfirm(value, $('prompt-select').value);
            closeSheets();
        } catch (err) {
            showPromptError(err.message);
        } finally {
            $btn.disabled = false;
            $btn.textContent = label;
        }
    }

    // ── Create / delete ──────────────────────────────────────
    function newNotebook() {
        showPromptSheet({
            title: 'New notebook',
            label: 'Notebook name',
            placeholder: 'Ideas',
            onConfirm: async (raw) => {
                const name = raw.replace(/\/+$/, '');
                // A leading dot creates a notebook that loadAllContent() filters
                // straight back out, so the user would see nothing at all.
                if (name.startsWith('.')) throw new Error('Notebook names cannot start with a dot.');
                if (/[\/\\]/.test(name)) throw new Error('Notebook names cannot contain slashes.');
                if (notebooks.some(nb => nb.toLowerCase() === name.toLowerCase())) {
                    throw new Error(`A notebook called "${name}" already exists.`);
                }

                // Git has no empty directories, so a new notebook needs a file in it.
                await putFile(`${name}/.gitkeep`, '', `Create notebook ${name}`);
                notebooks.unshift(name);
                notesByNotebook[name] = [];
                await renderNoteList($('browse-search').value);
                showToast('Notebook created ✓');
            },
        });
    }

    function newNote(preferredNotebook) {
        if (!notebooks.length) {
            showToast('Create a notebook first', 'error');
            newNotebook();
            return;
        }
        showPromptSheet({
            title: 'New note',
            label: 'Note name',
            placeholder: 'Meeting notes',
            select: notebooks,
            selectValue: preferredNotebook || notebooks[0],
            onConfirm: async (raw, notebook) => {
                const name = raw.replace(/\.md$/i, '');
                if (/[\/\\]/.test(name)) throw new Error('Note names cannot contain slashes.');
                const note = `${name}.md`;
                if ((notesByNotebook[notebook] || []).some(n => n.toLowerCase() === note.toLowerCase())) {
                    throw new Error(`"${name}" already exists in ${notebook}.`);
                }

                await putFile(`${notebook}/${note}`, `# ${name}\n\n`, `Create note ${notebook}/${note}`);
                notesByNotebook[notebook] = [note, ...(notesByNotebook[notebook] || [])];
                await renderNoteList($('browse-search').value);
                openNoteEdit(notebook, note);
            },
        });
    }

    async function deleteNote(notebook, note) {
        const base = note.replace(/\.md$/, '');
        if (!confirm(`Delete "${base}"? It stays recoverable in your Git history.`)) return;
        try {
            await deleteFile(`${notebook}/${note}`, `Delete ${notebook}/${note}`);
            notesByNotebook[notebook] = (notesByNotebook[notebook] || []).filter(n => n !== note);
            releaseCaptureTarget(notebook, note);
            if (editingNotebook === notebook && editingNote === note) {
                editingNotebook = null;
                editingNote = null;
                showView('app');
            }
            await renderNoteList($('browse-search').value);
            showToast('Deleted ✓');
        } catch (err) {
            showToast('Delete failed: ' + err.message, 'error');
        }
    }

    async function deleteNotebook(notebook) {
        const count = (notesByNotebook[notebook] || []).length;
        const what = count === 1 ? '1 note' : `${count} notes`;
        if (!confirm(`Delete notebook "${notebook}" and ${what}? It stays recoverable in your Git history.`)) return;
        try {
            await deleteFolder(notebook, `Delete notebook ${notebook}`);
            for (const note of notesByNotebook[notebook] || []) releaseCaptureTarget(notebook, note);
            if (editingNotebook === notebook) {
                editingNotebook = null;
                editingNote = null;
                showView('app');
            }
            notebooks = notebooks.filter(nb => nb !== notebook);
            delete notesByNotebook[notebook];
            await renderNoteList($('browse-search').value);
            showToast('Notebook deleted ✓');
        } catch (err) {
            showToast('Delete failed: ' + err.message, 'error');
        }
    }

    // Capture would otherwise keep appending to a note that no longer exists,
    // and every save would fail on a 404 the user cannot explain.
    function releaseCaptureTarget(notebook, note) {
        if (captureTarget.type !== 'note') return;
        if (captureTarget.notebook !== notebook || captureTarget.note !== note) return;
        captureTarget = { type: 'scratch' };
        updateTargetLabel();
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

    // ── Tab Switching ────────────────────────────────────────
    function switchTab(name) {
        if (name !== 'capture') stopDictation(captureDictation);
        if (name !== 'browse') stopDictation(noteDictation);
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
        tokenExpiresAt = 0;
        // sessionStorage is cleared too — see web/app.js signOut().
        for (const key of [AUTH_TOKEN_KEY, AUTH_USER_KEY, AUTH_REPO_KEY, AUTH_EXPIRES_KEY]) {
            authStore.removeItem(key);
            sessionStorage.removeItem(key);
        }
        if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; }
        // The assistant's API keys live in localStorage too (ADR 0001) — see
        // web/app.js signOut(). assistant.js is shared, so mobile stores the
        // same two entries and has to clear them here as well.
        for (const key of ASSISTANT_KEYS) {
            localStorage.removeItem(key);
            sessionStorage.removeItem(key);
        }
        allNotesLoaded = false; notebooks = []; notesByNotebook = {}; fileShas = {}; noteContentCache = {}; noteModifiedCache = {};
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
    // The closing CTA repeats the sign-in button at the bottom of the landing copy.
    const btnSigninFinal = $('btn-signin-final');
    if (btnSigninFinal) btnSigninFinal.addEventListener('click', startDeviceFlow);
    $('btn-retry').addEventListener('click', () => {
        $('si-error').classList.add('hidden');
        $('si-idle').classList.remove('hidden');
    });

    $('btn-save').addEventListener('click', saveCapture);
    $('capture-area').addEventListener('input', () => {
        $('btn-save').disabled = $('capture-area').value.trim() === '';
    });

    $('btn-target').addEventListener('click', openTargetDrawer);
    $('btn-close-drawer').addEventListener('click', closeSheets);
    $('btn-close-action-sheet').addEventListener('click', closeSheets);
    $('btn-close-prompt-sheet').addEventListener('click', closeSheets);
    $('drawer-overlay').addEventListener('click', closeSheets);

    $('btn-browse-add').addEventListener('click', () => showActionSheet('New', [
        { label: 'New note', action: () => newNote() },
        { label: 'New notebook', action: () => newNotebook() },
    ]));
    $('btn-prompt-confirm').addEventListener('click', submitPrompt);
    $('prompt-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
    });

    $('browse-search').addEventListener('input', e => {
        clearTimeout(browseSearchTimer);
        browseSearchTimer = setTimeout(() => renderNoteList(e.target.value), 250);
    });

    $('btn-back-browse').addEventListener('click', () => {
        stopDictation(noteDictation);
        showView('app');
    });
    $('btn-save-note').addEventListener('click', saveNoteEdit);

    $('btn-signout').addEventListener('click', signOut);

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // ── Init ─────────────────────────────────────────────────
    window.EverFreeNoteContext = {
        getNote() {
            if (!editingNotebook || !editingNote) return null;
            return {
                notebook: editingNotebook,
                note: editingNote,
                content: $('note-edit-area').value,
            };
        },
        getSelection() {
            const textarea = $('note-edit-area');
            return textarea.selectionStart !== textarea.selectionEnd
                ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) : '';
        },
    };

    setupVoiceInput();
    if (token && tokenExpiresAt && tokenExpiresAt <= Date.now()) {
        signOut();
    } else if (token && user && repoFull) {
        showView('loading');
        $('loading-text').textContent = 'Loading your notes…';
        enterApp().catch(err => {
            showView('signin');
            showSigninError(err.message);
        });
    } else if (token && user) {
        showView('loading');
        autoConnectRepo().catch(err => {
            showView('signin');
            showSigninError(err.message);
        });
    } else {
        showView('signin');
    }
})();
