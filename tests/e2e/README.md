# Sign-in and setup, end to end

Scripts directly in this directory are **hermetic**: fixtures and a local
server, nothing leaves the machine. Anything under `live/` talks to **the real
internet and to production** — real `github.com`, the live
`everfree.vercel.app`, the real EverFree OAuth App. That is the whole reason
for the subdirectory, so keep the split when adding scripts.

| Script | Network | Covers |
| --- | --- | --- |
| `device-flow.js` | none (fixtures) | what the web and mobile clients do with every answer the poll can give |
| `desktop-setup.js` | none (local server) | where the Evernote import is in the wizard, and whether it stays reachable |
| `notes-crud.js` | none (fixtures) | creating, renaming and deleting notes and notebooks in the web and mobile clients |
| `desktop-notes-crud.js` | none (local server) | the same, in the desktop app |
| `live/device-flow.js` | **real GitHub + production** | a code is issued and the poll is answered, right now, in production |

## Create, rename and delete

The feature has three implementations — the web and mobile clients commit to
GitHub, the desktop app writes to a directory and lets the sync worker push —
so it has two scripts rather than one.

`notes-crud.js` drives the real `web/` and `web/mobile/` UIs against the
write-aware model in `tests/perf/mock-github.js`, and asserts against the repo
the model holds afterwards, not against what the page renders. A client that
paints an optimistic row it never committed fails there.

The model lags directory listings behind writes, because GitHub does: a
contents listing is served from a cache, and an authenticated response also
carries `cache-control: private, max-age=60`, so a listing fetched right after a
write can come back without it. A client that rebuilds its state from that
listing throws away what it just created — which is why the web checks assert
the new note is *in the sidebar*, not only in the repo. Committing it is the
easy half.

Deleting a notebook is the case worth a harness. The Contents API has no
recursive delete, so both browser clients build a single tree through the Git
Data API instead. The mock stages trees and commits and applies them only when
the ref moves, which is the real API's defining property and the one a client
can most easily get wrong. Both scripts also check that a sibling notebook
survives, since a prefix match on the wrong boundary would take `Notebook 010`
out along with `Notebook 01`.

Renaming goes through the same tree write, adding paths as well as dropping
them. The mock resolves an added entry's `sha` against a blob the repo already
holds or one just uploaded, and refuses any other — a move carries no content
of its own. A moved blob keeps its sha, as Git does, so a client whose caches
did not follow the file to its new path fails on the next write rather than
silently passing.

Renaming a *note* also rewrites its `#` heading, since that is what the web
client titles a note by, and a heading left behind would show the old name on
every client that reads it. That makes the rename a content write too, so the
scripts assert the committed body, the title on screen, and — for the two
clients that keep the note open — that the editor picked up the new body. An
editor left on the old heading would put the old title straight back on the
next save. Renaming a *notebook* moves files and nothing else, so there is a
check that the notes come through byte for byte.

`desktop-notes-crud.js` loads the UI from `/static/index.html` rather than `/`.
`/` serves the setup wizard until a GitHub token is in the OS keyring, and a
test must not put one there; `/static` is the same file the app itself loads,
and every API call under test still reaches the real server.

## The step that cannot be automated

GitHub's Device Flow ends at `github.com/login/device`, where a person types
the code and presses Authorize. That page *is* the consent — there is no API
for it, and automating it would defeat its purpose. So the coverage is split
either side of it: `live/device-flow.js` proves everything up to the consent
against the real service, and `device-flow.js` injects the token GitHub would
have returned and proves everything after it. The only untested link is
GitHub's own page.

## Running them

```bash
npx playwright install chromium      # once

node tests/e2e/device-flow.js                                   # web + mobile
node tests/e2e/desktop-setup.js                                 # setup wizard
node tests/e2e/notes-crud.js                                    # web + mobile
EVERFREE_PYTHON=.venv/bin/python node tests/e2e/desktop-notes-crud.js

node tests/e2e/live/device-flow.js                              # production
node tests/e2e/live/device-flow.js --desktop http://127.0.0.1:52321
```

`playwright` must resolve from the repo root, as it must for `tests/perf`.
`desktop-setup.js` starts its own server, so it needs a Python with the app's
requirements: `EVERFREE_PYTHON=.venv/bin/python node tests/e2e/desktop-setup.js`.

Add `--headed` to any of them to watch.

## What they touch

The hermetic four touch nothing: the fixtures never leave the machine, and both
server-backed scripts run against a temporary `HOME` and a temporary notes
directory, so they cannot see the developer's notes or credentials. That
temporary `HOME` is also why `desktop-notes-crud.js` cannot sign in — the OS
keyring is the developer's own, and a test has no business writing a token to
it.

`live/device-flow.js` reaches the network but never writes: no repository is
created, no note is committed, and it never obtains a token — it stops where a
human would have to authorize. It does leave a handful of unused device codes
pending on the OAuth App, which expire in 15 minutes and authorize nothing.
Point it elsewhere with `EVERFREE_SITE`.

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `EVERFREE_SITE` | `https://everfree.vercel.app` | `live/device-flow.js` |
| `EVERFREE_GITHUB_CLIENT_ID` | the public EverFree client ID | `live/device-flow.js` |
| `EVERFREE_PYTHON` | `python3` | `desktop-setup.js`, `desktop-notes-crud.js` |
| `EVERFREE_TEST_PORT` | `52398` / `52399` | `desktop-setup.js`, `desktop-notes-crud.js` |

The Evernote import has its own suite in `tests/test_evernote_import.py`: it
runs the real pipeline with only the Evernote OAuth handshake and the note
download faked, so a pass means Markdown actually reached the notes directory.
