# Cold-start measurement harness for `web/app.js`

`web/app.js` has no unit-test coverage, so these scripts exist to make claims
about its load performance checkable rather than anecdotal. They drive the real
`web/index.html` + `app.js` in headless Chromium against a modelled GitHub API.

Requires `playwright` resolvable from the repo root and its Chromium browser
installed (`npx playwright install chromium`).

## What is modelled, and what that means

`mock-github.js` is a **model**, not a replay of api.github.com. Two properties
are simulated deliberately, because they are what governs cold start:

- **Per-endpoint latency** (`LATENCY_MS`), from `curl` timings against
  api.github.com. `commits?path=` is the expensive one — GitHub walks git
  history for that path, so it can't be served from a cheap cache.
- **A concurrency ceiling of 100.** GitHub applies a secondary rate limit near
  100 concurrent requests per token. Firing 600 requests in parallel does not
  cost one round trip, and in reality some come back `403`.

Absolute milliseconds are therefore only meaningful *relative to each other*.
Request counts are exact. The model is generous to the original implementation:
it queues past 100 concurrent instead of failing, whereas real GitHub would
start rejecting.

Two API facts the mock encodes, both verified against the live API — get these
wrong and the whole approach collapses:

- `GET /git/trees` returns no timestamps. Modified times cannot come from it.
- `GET /commits?per_page=N` returns **no `files` array**. Only
  `GET /commits/{sha}` carries one, so mapping commits to touched paths costs
  one request per commit.

## Scripts

| Script | Purpose |
| --- | --- |
| `measure.js` | Time-to-paint, time-to-visible-titles, request counts |
| `dump-order.js` | Dumps the rendered sidebar order, for diffing implementations |
| `smoke.js` | Functional checks: render, open a note, warm-cache behaviour |

```bash
# Standard matrix (54 / 252 / 600 notes), median of 3 runs
node tests/perf/measure.js --scales --repeat 3 --label before

# Same, but each measured run starts with a previous run's localStorage
node tests/perf/measure.js --scales --repeat 3 --warm --label after-warm

# Ordering. --shuffle scrambles commit dates so filename order and edit order
# disagree; without it a fixture can pass an ordering check by accident,
# because "Note 001" is both alphabetically first and most recently edited.
node tests/perf/dump-order.js --notebooks 5 --notes 16 --shuffle > after.json

node tests/perf/smoke.js
```

To measure a baseline, stash the working changes first
(`git stash push web/app.js`), run, then `git stash pop` — the harness always
loads whatever is currently in `web/`.

## Metrics

- `time_to_paint_ms` — navigation start to the first note card in the DOM. The
  number that matches "the app is blank".
- `time_to_visible_settle_ms` — until every card **in the viewport** shows its
  real H1 title. Offscreen cards are loaded lazily and may never resolve, by
  design, so a whole-list metric would hang rather than measure anything.
- `requests_to_paint` — GitHub calls issued before that first paint. This is
  the number that used to scale with the note count.

## Third-party assets

`measure.js` stubs the Toast UI CDN and Google Fonts so the numbers isolate
GitHub API cost. That cost is real but separate: `toastui-editor-all.min.js` is
~158 KB gzipped and `toastui-editor.min.css` ~108 KB, both render-blocking from
a third origin, and the CDN sends no `cache-control` header.
