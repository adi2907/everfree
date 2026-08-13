"""
EverFree — the note index behind agent access.

EverFree is the disk, not the mind. This module owns the derived, rebuildable
artifacts that make the disk usable by a program: a full-text index for
deterministic ranked search, a content revision for compare-and-swap writes,
and a strict parser for the two-segment note paths every EverFree client
assumes.

Nothing here interprets a note. There is no extraction, no embedding, no
consolidation — a caller gets back the bytes that are on disk and decides for
itself what they mean.

The index deliberately lives outside the notes repository. It is derived from
the Markdown files and can be thrown away at any time, so committing it would
add per-keystroke churn to a repository whose merge behaviour we care about a
great deal, in exchange for nothing.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import sys
import threading
import unicodedata
from pathlib import Path

logger_name = "everfree.memory"

# ── Note paths ───────────────────────────────────────────────
# Every EverFree client assumes exactly `<notebook>/<note>.md`. The desktop UI
# lists top-level directories as notebooks and the `.md` files directly inside
# them as notes, so a note written to a deeper path exists on disk and in git
# but is invisible in every client. Reject it at the door rather than accept a
# write nothing can display.
#
# This constrains *notes* only. `assets/` subdirectories inside a notebook are
# a legitimate part of the layout and are simply never notes.
_NOTE_PATH_RE = re.compile(r"^(?P<notebook>[^/\\]+)/(?P<note>[^/\\]+\.md)$")
_RESERVED_SEGMENTS = {"", ".", "..", ".git"}


class NotePathError(ValueError):
    """A path is not a valid `<notebook>/<note>.md` note path."""


def parse_note_path(path: str) -> tuple[str, str]:
    """Split an agent-supplied path into `(notebook, note)`.

    Raises `NotePathError` for anything that is not exactly two segments ending
    in `.md`. This is the only place agent-supplied paths become filesystem
    paths, so it is the only place the geometry has to be enforced.
    """
    if not isinstance(path, str):
        raise NotePathError("Path must be a string")
    candidate = path.strip().lstrip("/")
    match = _NOTE_PATH_RE.match(candidate)
    if not match:
        raise NotePathError(
            f"Invalid note path {path!r}. Notes are exactly "
            "'<notebook>/<note>.md' — no nested directories."
        )
    notebook = match.group("notebook").strip()
    note = match.group("note").strip()
    for segment in (notebook, note):
        if segment in _RESERVED_SEGMENTS or segment.startswith(".."):
            raise NotePathError(f"Invalid note path {path!r}")
    if note == ".md":
        raise NotePathError(f"Invalid note path {path!r}")
    return notebook, note


def note_path_of(notebook: str, note: str) -> str:
    return f"{notebook}/{note}"


# ── Revisions ────────────────────────────────────────────────
def revision_of_bytes(data: bytes) -> str:
    """A stable fingerprint of the exact bytes on disk.

    Deliberately not a git blob hash: a revision has to describe the working
    tree, including edits that are not committed yet, which is precisely the
    state a compare-and-swap write needs to detect.
    """
    return hashlib.sha256(data).hexdigest()[:16]


def revision_of_file(path: Path) -> str | None:
    try:
        return revision_of_bytes(path.read_bytes())
    except OSError:
        return None


# ── Index location ───────────────────────────────────────────
def default_index_dir() -> Path:
    override = os.environ.get("EVERFREE_INDEX_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "EverFree"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "everfree"


def index_path_for(notes_dir: Path) -> Path:
    """One index file per notes directory.

    Keying on the notes directory keeps a test sandbox from colliding with the
    real index, and keeps two checkouts on the same machine independent.
    """
    key = hashlib.sha256(str(Path(notes_dir).resolve()).encode("utf-8")).hexdigest()[:12]
    return default_index_dir() / f"index-{key}.db"


# ── Query parsing ────────────────────────────────────────────
_TOKEN_RE = re.compile(r"[\w']+", re.UNICODE)


def fts_match_expression(query: str) -> str:
    """Turn a human query into an FTS5 MATCH expression.

    Every term is quoted so punctuation a user typed can never be read as FTS5
    syntax, and the final term gets a prefix wildcard so search stays useful
    while someone is still typing the word.
    """
    tokens = _TOKEN_RE.findall(unicodedata.normalize("NFKC", query))
    if not tokens:
        return ""
    quoted = [f'"{token}"' for token in tokens[:-1]]
    quoted.append(f'"{tokens[-1]}"*')
    return " AND ".join(quoted)


def _title_of(note: str, body: str) -> str:
    """A note's display title: its first H1, else its file name.

    Mirrors getNoteTitle() in web/app.js so search results are titled the same
    way the clients title them.
    """
    for line in body.split("\n", 40)[:40]:
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip().rstrip("#").strip()
            if title:
                return title
    return note.removesuffix(".md")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS note_meta (
    path        TEXT PRIMARY KEY,
    notebook    TEXT NOT NULL,
    note        TEXT NOT NULL,
    title       TEXT NOT NULL,
    mtime       REAL NOT NULL,
    size        INTEGER NOT NULL,
    revision    TEXT NOT NULL,
    committed_at INTEGER
);
CREATE INDEX IF NOT EXISTS note_meta_notebook ON note_meta(notebook);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED,
    notebook,
    title,
    body,
    tokenize = "unicode61 remove_diacritics 2"
);
CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT);
"""


class NoteIndex:
    """A full-text index over `<notebook>/<note>.md`, kept in step with disk.

    Updates are incremental: a scan compares `(mtime, size)` per path and only
    re-reads what changed, so refreshing before a read costs a directory walk
    rather than a corpus read.
    """

    def __init__(self, notes_dir: Path, db_path: Path | None = None):
        self.notes_dir = Path(notes_dir)
        self.db_path = Path(db_path) if db_path else index_path_for(self.notes_dir)
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None

    # ── Connection ───────────────────────────────────────────
    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        # Autocommit, so `refresh` can own an explicit transaction rather than
        # fight the driver's implicit one.
        conn.isolation_level = None
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        try:
            conn.executescript(_SCHEMA)
        except sqlite3.OperationalError as exc:
            # The desktop app ships its own Python. A build whose sqlite lacks
            # FTS5 would otherwise fail deep inside a query with something
            # unreadable, so name the cause here.
            conn.close()
            raise RuntimeError(
                "This Python's sqlite3 was built without FTS5, which the "
                f"EverFree note index requires ({exc})."
            ) from exc
        conn.commit()
        self._conn = conn
        return conn

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # ── State ────────────────────────────────────────────────
    def get_state(self, key: str) -> str | None:
        with self._lock:
            row = self._connect().execute(
                "SELECT value FROM index_state WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def set_state(self, key: str, value: str) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "INSERT INTO index_state(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            conn.commit()

    # ── Refresh ──────────────────────────────────────────────
    def scan_disk(self) -> dict[str, tuple[float, int]]:
        """`{path: (mtime, size)}` for every note, two levels only."""
        found: dict[str, tuple[float, int]] = {}
        if not self.notes_dir.exists():
            return found
        try:
            notebooks = [d for d in self.notes_dir.iterdir() if d.is_dir()]
        except OSError:
            return found
        for notebook in notebooks:
            if notebook.name.startswith("."):
                continue
            try:
                entries = list(notebook.iterdir())
            except OSError:
                continue
            for entry in entries:
                if not entry.is_file() or entry.suffix != ".md":
                    continue
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                found[note_path_of(notebook.name, entry.name)] = (stat.st_mtime, stat.st_size)
        return found

    def refresh(self, commit_times: dict[str, int] | None = None) -> dict[str, int]:
        """Bring the index in step with disk. Returns a counts summary.

        The whole update runs in one transaction so a reader can never observe
        a half-applied refresh — an agent that searches during a sync gets the
        state before or the state after, never a corpus missing a note it just
        wrote.
        """
        with self._lock:
            conn = self._connect()
            on_disk = self.scan_disk()
            indexed = {
                row["path"]: (row["mtime"], row["size"])
                for row in conn.execute("SELECT path, mtime, size FROM note_meta")
            }

            changed = [
                path for path, stamp in on_disk.items()
                if indexed.get(path) != stamp
            ]
            removed = [path for path in indexed if path not in on_disk]

            counts = {"indexed": 0, "removed": len(removed), "total": len(on_disk)}
            conn.execute("BEGIN")
            try:
                for path in removed:
                    conn.execute("DELETE FROM note_meta WHERE path = ?", (path,))
                    conn.execute("DELETE FROM notes_fts WHERE path = ?", (path,))

                for path in changed:
                    notebook, note = path.split("/", 1)
                    file_path = self.notes_dir / notebook / note
                    try:
                        data = file_path.read_bytes()
                    except OSError:
                        continue
                    body = data.decode("utf-8", errors="replace")
                    mtime, size = on_disk[path]
                    title = _title_of(note, body)
                    conn.execute("DELETE FROM notes_fts WHERE path = ?", (path,))
                    conn.execute(
                        "INSERT INTO notes_fts(path, notebook, title, body) VALUES(?, ?, ?, ?)",
                        (path, notebook, title, body),
                    )
                    conn.execute(
                        "INSERT INTO note_meta(path, notebook, note, title, mtime, size, revision, committed_at) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(path) DO UPDATE SET "
                        "notebook=excluded.notebook, note=excluded.note, title=excluded.title, "
                        "mtime=excluded.mtime, size=excluded.size, revision=excluded.revision",
                        (path, notebook, note, title, mtime, size,
                         revision_of_bytes(data), None),
                    )
                    counts["indexed"] += 1

                if commit_times:
                    for path, when in commit_times.items():
                        conn.execute(
                            "UPDATE note_meta SET committed_at = ? WHERE path = ?",
                            (when, path),
                        )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return counts

    # ── Reads ────────────────────────────────────────────────
    def search(self, query: str, limit: int = 20) -> list[dict]:
        """Ranked search. Deterministic: same corpus and query, same answer.

        BM25 does the relevance work; a small tier on top of it keeps the
        behaviour people already expect from the editor, where a note whose
        title is what you typed sorts above one that merely mentions it.
        """
        query = (query or "").strip()
        if not query:
            return []
        expression = fts_match_expression(query)
        if not expression:
            return []
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT path, notebook, title,
                           snippet(notes_fts, 3, '', '', '…', 24) AS snippet,
                           bm25(notes_fts, 0.0, 2.0, 8.0, 1.0) AS relevance
                    FROM notes_fts
                    WHERE notes_fts MATCH ?
                    ORDER BY relevance
                    LIMIT ?
                    """,
                    (expression, max(1, min(limit, 200)) * 3),
                ).fetchall()
            except sqlite3.OperationalError:
                # A query FTS5 refuses to parse is a caller problem, not a
                # server error: report nothing rather than a 500.
                return []
            meta = {
                row["path"]: row
                for row in conn.execute(
                    "SELECT path, note, mtime, committed_at FROM note_meta"
                )
            }

        lowered = query.lower()
        results = []
        for row in rows:
            info = meta.get(row["path"])
            if info is None:
                continue
            title = row["title"] or ""
            lower_title = title.lower()
            if lower_title == lowered:
                tier, score = 0, 100
            elif lower_title.startswith(lowered):
                tier, score = 1, 80
            elif lowered in lower_title:
                tier, score = 2, 60
            elif lowered in (row["notebook"] or "").lower():
                tier, score = 3, 40
            else:
                tier, score = 4, 20
            results.append({
                "path": row["path"],
                "notebook": row["notebook"],
                "note": info["note"],
                "title": title,
                "snippet": " ".join((row["snippet"] or "").split()),
                "score": score,
                "_tier": tier,
                "_relevance": row["relevance"],
                "_recency": info["committed_at"] or info["mtime"] or 0,
            })

        results.sort(key=lambda r: (r["_tier"], r["_relevance"], -r["_recency"]))
        for result in results:
            for key in ("_tier", "_relevance", "_recency"):
                result.pop(key, None)
        return results[:limit]

    def recent(self, limit: int = 20, notebook: str | None = None) -> list[dict]:
        """Notes most recently changed by any machine.

        Ordered by commit time rather than local mtime. A fresh clone writes
        every file at clone time, so mtime describes when this Mac happened to
        receive a note, not when anyone last changed it — a distinction that
        only shows up on the second machine, which is exactly where an agent
        would be misled by it.
        """
        sql = (
            "SELECT path, notebook, note, title, revision, mtime, committed_at "
            "FROM note_meta "
        )
        params: list = []
        if notebook:
            sql += "WHERE notebook = ? "
            params.append(notebook)
        # Commit times have one-second resolution, so two writes in the same
        # second tie. Local mtime breaks the tie rather than leaving the order
        # up to whatever the query planner happens to return.
        sql += "ORDER BY COALESCE(committed_at, mtime) DESC, mtime DESC, path LIMIT ?"
        params.append(max(1, min(limit, 200)))
        with self._lock:
            rows = self._connect().execute(sql, params).fetchall()
        return [
            {
                "path": row["path"],
                "notebook": row["notebook"],
                "note": row["note"],
                "title": row["title"],
                "revision": row["revision"],
                "changed_at": row["committed_at"] or row["mtime"],
            }
            for row in rows
        ]

    def list_notes(self, notebook: str | None = None) -> list[dict]:
        sql = "SELECT path, notebook, note, title, revision FROM note_meta "
        params: list = []
        if notebook:
            sql += "WHERE notebook = ? "
            params.append(notebook)
        sql += "ORDER BY notebook, note"
        with self._lock:
            rows = self._connect().execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def notebooks(self) -> list[str]:
        with self._lock:
            rows = self._connect().execute(
                "SELECT DISTINCT notebook FROM note_meta ORDER BY notebook"
            ).fetchall()
        return [row["notebook"] for row in rows]

    def count(self) -> int:
        with self._lock:
            row = self._connect().execute("SELECT COUNT(*) AS n FROM note_meta").fetchone()
        return int(row["n"]) if row else 0
