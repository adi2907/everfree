"""
EverFree — the access contract coding agents talk to.

The operations here are the disk's, not the mind's: integrate the remote, hand
back exactly the bytes on disk, apply an append, refuse a write that raced.
Deciding what any of it means is the caller's job.

Two properties are the whole point of this module, and both only show up once
more than one machine is writing:

  Freshness.  A read that silently returns a note from before someone else's
  push is worse than a read that fails, because the agent has no way to tell.
  Every read-side operation passes through one coalesced barrier that fetches,
  integrates what it safely can, and reindexes before the read is served.

  Exactly-once append.  Appends from two machines land at the end of the same
  file, which is the one edit git conflicts on every single time. An append is
  therefore treated as an operation to replay rather than a commit to merge:
  on rejection we take the remote side of the file and re-apply the payload to
  it. An operation ID in the commit trailer covers the case where a push
  succeeded but the response was lost, so a retry cannot append twice.

Git logic lives in `server.app`; this module receives it as callables so it can
be exercised against real clones without importing the FastAPI application.
"""

from __future__ import annotations

import logging
import re
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from server import memory

logger = logging.getLogger("everfree.agent")

APPEND_TRAILER = "EverFree-Append-Id"
MAX_APPEND_ATTEMPTS = 4
# How long a freshness check is reused. An agent that opens five search results
# should cost one fetch, not five identical round trips.
DEFAULT_FRESHNESS_WINDOW = 5.0


class AgentConflict(Exception):
    """A read or write could not proceed without losing someone's work."""

    def __init__(self, message: str, *, paths: list[str] | None = None):
        super().__init__(message)
        self.message = message
        self.paths = paths or []


class AgentOffline(Exception):
    """The remote could not be reached, so freshness cannot be guaranteed."""


def new_operation_id() -> str:
    """An append's identity, stable across retries of the same call."""
    return f"{int(time.time())}-{secrets.token_hex(8)}"


@dataclass
class Freshness:
    """What the barrier could actually guarantee, stated rather than implied."""

    checked_remote: bool = False
    merged: bool = False
    offline: bool = False
    local_only: bool = False
    blocked_paths: list[str] = field(default_factory=list)
    detail: str = ""
    at: float = field(default_factory=time.time)

    @property
    def fresh(self) -> bool:
        """True only when local content is known to match the remote."""
        return (self.checked_remote and not self.blocked_paths) or self.local_only

    def as_dict(self) -> dict:
        return {
            "fresh": self.fresh,
            "checked_remote": self.checked_remote,
            "merged": self.merged,
            "offline": self.offline,
            "local_only": self.local_only,
            "blocked_paths": self.blocked_paths,
            "detail": self.detail,
            "at": self.at,
        }


STATUS_ARGS = ("status", "--porcelain", "-z")


def parse_porcelain(output: str) -> set[str]:
    """Repository-relative paths with uncommitted changes, from `--porcelain -z`.

    The `-z` form is not a convenience. Without it git C-quotes any path that
    is not plain ASCII, while `diff --name-only` is read with
    `core.quotepath=false` and returns the raw bytes. The two sets then never
    intersect for a note named in any non-Latin script, so an overlapping edit
    looks like no overlap at all and the caller merges straight over it. `-z`
    emits raw paths on both sides of the comparison.
    """
    dirty: set[str] = set()
    fields = output.split("\0")
    position = 0
    while position < len(fields):
        entry = fields[position]
        position += 1
        if len(entry) < 4:
            continue
        status, path = entry[:2], entry[3:]
        if path:
            dirty.add(path)
        # A rename or copy is followed by its source path as a separate field.
        if "R" in status or "C" in status:
            if position < len(fields):
                source = fields[position]
                position += 1
                if source:
                    dirty.add(source)
    return dirty


class AgentRepo:
    """Freshness, revisions and exactly-once append over the notes repository."""

    def __init__(
        self,
        *,
        notes_dir: Path,
        index: memory.NoteIndex,
        git,
        repo_lock,
        is_git_repo,
        branch: str,
        classify_failure,
        is_network_error,
        request_sync,
        atomic_write_text,
    ):
        self._notes_dir = Path(notes_dir)
        self._index = index
        self._git = git
        self._repo_lock = repo_lock
        self._is_git_repo = is_git_repo
        self._branch = branch
        self._classify_failure = classify_failure
        self._is_network_error = is_network_error
        self._request_sync = request_sync
        self._atomic_write_text = atomic_write_text

        self._fresh_lock = threading.RLock()
        self._last_freshness: Freshness | None = None

    # ── Paths ────────────────────────────────────────────────
    @property
    def notes_dir(self) -> Path:
        return self._notes_dir

    def resolve(self, path: str) -> tuple[str, str, Path]:
        """Validate an agent path and return `(notebook, note, absolute path)`."""
        notebook, note = memory.parse_note_path(path)
        resolved = (self._notes_dir / notebook / note).resolve()
        base = self._notes_dir.resolve()
        if not (resolved == base or base in resolved.parents):
            raise memory.NotePathError(f"Invalid note path {path!r}")
        return notebook, note, resolved

    # ── Freshness barrier ────────────────────────────────────
    def ensure_fresh(
        self,
        *,
        max_age: float = DEFAULT_FRESHNESS_WINDOW,
        force: bool = False,
    ) -> Freshness:
        """Integrate the remote, then reindex, before a read is served.

        Fetching before `read_note` alone is not enough: if the *search* index
        is stale the agent never learns a note exists and never asks to read
        it. So list, search, recent and read all pass through here.

        A dirty note only blocks the paths it actually touches. An unsynced
        edit to `Personal/Foo.md` must not stop `Work/Bar.md` arriving — that
        was the old `_sync_cycle` behaviour and it made staleness unbounded.
        """
        with self._fresh_lock:
            cached = self._last_freshness
            if (
                not force
                and cached is not None
                and cached.fresh
                and (time.time() - cached.at) < max_age
            ):
                return cached

            result = self._barrier()
            self._last_freshness = result
            return result

    def _barrier(self) -> Freshness:
        if not self._is_git_repo():
            self._index.refresh()
            return Freshness(local_only=True, detail="Not a git repository")

        fetched, stderr = self._try_network_git("fetch", "origin", self._branch)
        if not fetched:
            self._refresh_index()
            return Freshness(
                offline=self._is_network_error(stderr),
                detail=stderr[:200] or "Fetch failed",
            )

        merged = False
        blocked: list[str] = []
        detail = ""
        with self._repo_lock:
            incoming = self._incoming_paths()
            if incoming:
                dirty = self._dirty_paths()
                overlap = sorted(incoming & dirty)
                if overlap:
                    # Merging here would either clobber an unsaved edit or stop
                    # on a conflict the agent cannot resolve. Report it instead.
                    blocked = overlap
                    detail = (
                        "Local edits overlap incoming changes; "
                        "save or sync in EverFree to resolve."
                    )
                else:
                    merge = self._git("merge", "--no-edit", "FETCH_HEAD", check=False)
                    if merge.returncode == 0:
                        merged = True
                    else:
                        conflicted = sorted(self._unmerged_paths())
                        self._git("merge", "--abort", check=False)
                        # A merge git declined to even start leaves nothing
                        # unmerged. Reporting no blocked paths there would make
                        # `fresh` true off an integration that did not happen,
                        # which is the one lie this barrier exists to prevent —
                        # so name the paths that failed to arrive instead.
                        blocked = conflicted or sorted(incoming)
                        detail = (
                            "Merge conflict; resolve in EverFree."
                            if conflicted else
                            "Could not integrate remote changes; "
                            "save or sync in EverFree to resolve."
                        )

        self._refresh_index()
        return Freshness(
            checked_remote=True,
            merged=merged,
            blocked_paths=blocked,
            detail=detail,
        )

    def require_fresh(
        self,
        *,
        strict: bool,
        max_age: float = DEFAULT_FRESHNESS_WINDOW,
        force: bool = False,
    ) -> Freshness:
        """Barrier for a read, failing loudly when strictness was asked for.

        Absolute freshness is impossible offline. A strict read says so rather
        than returning local content and calling it current; a non-strict read
        returns the content along with the freshness record, so the caller can
        still see that it was not verified.
        """
        state = self.ensure_fresh(max_age=max_age, force=force)
        if strict and not state.fresh:
            if state.blocked_paths:
                raise AgentConflict(state.detail or "Local edits conflict with the remote",
                                    paths=state.blocked_paths)
            raise AgentOffline(state.detail or "Cannot reach the remote")
        return state

    def _try_network_git(self, *args: str) -> tuple[bool, str]:
        """Run a network git command without letting it raise.

        `_git` refuses fetch and push when the repository has no origin or no
        usable credential. That is a normal state — a local-only install, or a
        user who has not connected GitHub yet — and a write must still land on
        disk when it happens. Callers get a failed result and degrade to
        "committed locally, queued for sync".
        """
        try:
            result = self._git(*args, check=False)
        except Exception as exc:
            return False, str(exc)[:200]
        return result.returncode == 0, (result.stderr or "").strip()

    def _incoming_paths(self) -> set[str]:
        """Paths the remote changed since our merge base — what a merge lands."""
        result = self._git(
            "-c", "core.quotepath=false",
            "diff", "--name-only", "HEAD...FETCH_HEAD", check=False,
        )
        if result.returncode != 0:
            return set()
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}

    def _dirty_paths(self) -> set[str]:
        """Paths with uncommitted changes, including unsaved editor edits."""
        return parse_porcelain(self._git(*STATUS_ARGS, check=False).stdout)

    def _unmerged_paths(self) -> set[str]:
        result = self._git(
            "-c", "core.quotepath=false",
            "diff", "--name-only", "--diff-filter=U", check=False,
        )
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}

    # ── Index refresh ────────────────────────────────────────
    def _refresh_index(self) -> None:
        """Reindex, recomputing commit times only when HEAD actually moved."""
        commit_times = None
        head = self._head_sha()
        if head and head != self._index.get_state("commit_times_head"):
            commit_times = self._commit_times()
        try:
            self._index.refresh(commit_times)
        except Exception:
            logger.exception("Index refresh failed")
            return
        if commit_times is not None and head:
            self._index.set_state("commit_times_head", head)

    def _head_sha(self) -> str | None:
        result = self._git("rev-parse", "HEAD", check=False)
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None

    def _commit_times(self) -> dict[str, int]:
        """Last commit time per note path, newest first wins.

        Local mtime cannot answer "what changed most recently anywhere" — a
        clone or a checkout stamps files with the time this machine received
        them, so on a second Mac every note looks equally new.
        """
        result = self._git(
            "-c", "core.quotepath=false",
            "log", "--format=%x00%ct", "--name-only", check=False,
        )
        if result.returncode != 0:
            return {}
        times: dict[str, int] = {}
        for block in result.stdout.split("\x00"):
            lines = [line for line in block.splitlines() if line.strip()]
            if not lines:
                continue
            try:
                when = int(lines[0].strip())
            except ValueError:
                continue
            for path in lines[1:]:
                path = path.strip()
                if path and path.endswith(".md") and path not in times:
                    times[path] = when
        return times

    def refresh_index(self) -> None:
        """Reindex from disk without touching the network."""
        self._refresh_index()

    # ── Revisions ────────────────────────────────────────────
    def revision(self, absolute: Path) -> str | None:
        return memory.revision_of_file(absolute)

    # ── Delivering a non-append mutation ─────────────────────
    def deliver(self, paths: list[str], message: str) -> dict:
        """Commit the given paths and push, retrying once across a merge.

        Only the paths an agent actually touched are committed. Sweeping the
        working tree with `git add -A` here would fold whatever draft the user
        has open in the editor into a commit they did not ask for.

        Unlike an append, these mutations do not collide at end-of-file, so an
        ordinary merge is a correct resolution when the remote has moved.
        """
        if not self._is_git_repo():
            self.refresh_index()
            return {"pushed": False, "delivered": True, "detail": "Local only"}

        with self._repo_lock:
            committed = self._commit_paths(paths, message)

        if not committed:
            self.refresh_index()
            return {"pushed": False, "delivered": True, "detail": "Nothing to commit"}

        # Past this point the change is on disk and committed, so nothing here
        # raises. Reporting a failure that reads as "your write did not happen"
        # would be false — the write happened, it just has not reached the
        # remote. Refusals belong before the write, not after it.
        for attempt in range(2):
            pushed, stderr = self._try_network_git("push", "origin", self._branch)
            if pushed:
                self.refresh_index()
                return {"pushed": True, "delivered": True, "detail": ""}

            terminal = self._classify_failure(stderr)
            if terminal:
                self.refresh_index()
                return {"pushed": False, "delivered": False,
                        "detail": terminal[1], "paths": list(paths)}
            if self._is_network_error(stderr):
                self._request_sync()
                self.refresh_index()
                return {"pushed": False, "delivered": True,
                        "detail": "Offline — committed locally and queued for sync"}
            if attempt == 0:
                fetched, _ = self._try_network_git("fetch", "origin", self._branch)
                if not fetched:
                    break
                with self._repo_lock:
                    merge = self._git("merge", "--no-edit", "FETCH_HEAD", check=False)
                    if merge.returncode != 0:
                        conflicted = sorted(self._unmerged_paths())
                        self._git("merge", "--abort", check=False)
                        self.refresh_index()
                        return {
                            "pushed": False,
                            "delivered": False,
                            "detail": (
                                "Written and committed locally, but the remote "
                                "conflicts; resolve in EverFree to deliver it."
                            ),
                            "paths": conflicted or list(paths),
                        }

        self._request_sync()
        self.refresh_index()
        return {"pushed": False, "delivered": True, "detail": "Queued for sync"}

    def _commit_paths(self, paths: list[str], message: str) -> bool:
        staged = False
        for rel in paths:
            add = self._git("add", "--", rel, check=False)
            if add.returncode == 0:
                staged = True
        if not staged:
            return False
        result = self._git("commit", "-m", message, "--", *paths, check=False)
        if result.returncode == 0:
            return True
        combined = f"{result.stdout or ''}{result.stderr or ''}".lower()
        if "nothing to commit" in combined or "no changes added" in combined:
            return False
        logger.info("Agent commit reported: %s", combined.strip()[:200])
        return False

    # ── Append ───────────────────────────────────────────────
    def append(
        self,
        path: str,
        text: str,
        *,
        operation_id: str | None = None,
        separator: str = "\n",
    ) -> dict:
        """Append `text` to a note, exactly once, across machines.

        The payload is replayed rather than merged: if the push is rejected we
        take the remote's version of the file and apply the payload to *that*,
        which is the only resolution that cannot lose either side's append.
        """
        notebook, note, absolute = self.resolve(path)
        rel = memory.note_path_of(notebook, note)
        if not absolute.parent.is_dir():
            raise AgentConflict(f"Notebook {notebook!r} does not exist")
        payload = text if text.endswith("\n") else text + "\n"
        operation_id = operation_id or new_operation_id()

        if not self._is_git_repo():
            # Local-only install: no remote to race with.
            with self._repo_lock:
                self._apply_payload(absolute, payload, separator)
            self._refresh_index()
            return self._append_result(rel, absolute, operation_id, pushed=False,
                                       detail="Local only")

        last_detail = ""
        for attempt in range(MAX_APPEND_ATTEMPTS):
            fetch_ok, fetch_error = self._try_network_git(
                "fetch", "origin", self._branch
            )

            with self._repo_lock:
                self._integrate_and_apply(
                    rel, absolute, payload, separator, operation_id,
                    fetch_ok=fetch_ok,
                )

            if not fetch_ok:
                # No remote, no credential, or no network. The text is on disk
                # and committed, so this is a completed write waiting to be
                # replicated — not a failure to report back to the agent.
                self._request_sync()
                self._refresh_index()
                return self._append_result(
                    rel, absolute, operation_id, pushed=False,
                    detail=fetch_error or "Queued for sync",
                )

            pushed, stderr = self._try_network_git("push", "origin", self._branch)
            if pushed:
                self._refresh_index()
                return self._append_result(rel, absolute, operation_id, pushed=True)

            last_detail = stderr[:200]
            terminal = self._classify_failure(stderr)
            if terminal:
                # The payload and its trailer are already in HEAD, so raising
                # here would report a write that did happen as one that did
                # not. Same rule as `deliver`: after the commit, report.
                self._refresh_index()
                return self._append_result(
                    rel, absolute, operation_id, pushed=False,
                    detail=terminal[1], delivered=False,
                )
            if self._is_network_error(stderr):
                self._request_sync()
                self._refresh_index()
                return self._append_result(rel, absolute, operation_id, pushed=False,
                                           detail="Offline — queued for sync")
            # Rejected because the remote moved: fetch again and replay.
            logger.info("Append push rejected (attempt %d), replaying", attempt + 1)

        # Same rule as `deliver`: the payload is committed by now, so an
        # exception claiming the append did not happen would be a lie.
        self._refresh_index()
        return self._append_result(
            rel, absolute, operation_id, pushed=False,
            detail=(
                f"Committed locally but not delivered after "
                f"{MAX_APPEND_ATTEMPTS} attempts: {last_detail}"
            ),
            delivered=False,
        )

    def _integrate_and_apply(
        self,
        rel: str,
        absolute: Path,
        payload: str,
        separator: str,
        operation_id: str,
        *,
        fetch_ok: bool,
    ) -> None:
        """Make HEAD contain the payload exactly once, on top of the remote."""
        trailer = f"{APPEND_TRAILER}: {operation_id}"
        have_local = self._history_has(operation_id, "HEAD")
        have_remote = self._history_has(operation_id, "FETCH_HEAD") if fetch_ok else False
        took_theirs = False

        if fetch_ok and self._merge_needed():
            # Anything with unsaved edits that the merge would also touch has
            # to stop us here. Rebuilding the target from the remote is only
            # safe for content git already has a copy of; bytes the user has
            # not saved exist nowhere else, so overwriting them destroys them
            # outright — locally and, once the replay is pushed, remotely too.
            overlap = sorted(self._incoming_paths() & self._dirty_paths())
            if overlap:
                raise AgentConflict(
                    "Cannot append while these notes have unsaved edits that "
                    "conflict with the remote; save or sync in EverFree first",
                    paths=overlap,
                )

            merge = self._git("merge", "--no-edit", "FETCH_HEAD", check=False)
            if merge.returncode != 0:
                unmerged = self._unmerged_paths()
                if not unmerged:
                    # Git declined to start the merge and changed nothing. The
                    # working tree is not ours to "resolve" by discarding it.
                    self._git("merge", "--abort", check=False)
                    raise AgentConflict(
                        "Cannot append: the remote could not be integrated. "
                        "Save or sync in EverFree, then retry.",
                        paths=[rel],
                    )
                if unmerged - {rel}:
                    self._git("merge", "--abort", check=False)
                    raise AgentConflict(
                        "Cannot append while other notes are conflicted",
                        paths=sorted(unmerged - {rel}),
                    )
                # Our side of the target is a committed append, so git still
                # holds it. Rebuild from the remote's copy and replay the
                # payload below, and neither side's text is lost.
                self._write_remote_version(rel, absolute)
                self._git("add", "--", rel, check=False)
                self._git("commit", "--no-edit", check=False)
                took_theirs = True

        if took_theirs:
            # The file is now the remote's copy verbatim.
            payload_present = have_remote
        else:
            payload_present = have_local or have_remote

        if payload_present:
            return

        self._apply_payload(absolute, payload, separator)
        self._git("add", "--", rel, check=False)
        # Commit only this path. `git add -A` here would sweep whatever drafts
        # the user happens to have open into an agent's commit.
        committed = self._git(
            "commit", "-m", f"EverFree: append to {rel}\n\n{trailer}",
            "--", rel, check=False,
        )
        if committed.returncode != 0 and "nothing to commit" not in (
            committed.stdout or ""
        ).lower():
            logger.info("Append commit reported: %s",
                        (committed.stderr or committed.stdout or "").strip()[:200])

    def _apply_payload(self, absolute: Path, payload: str, separator: str) -> None:
        try:
            existing = absolute.read_text(encoding="utf-8")
        except FileNotFoundError:
            existing = ""
        except OSError as exc:
            raise AgentConflict(f"Cannot read note: {exc}") from exc
        if existing and not existing.endswith("\n"):
            existing += "\n"
        # `separator` is what goes *between* entries once the previous one is
        # newline-terminated, so the default leaves exactly one blank line.
        joiner = separator if existing else ""
        self._atomic_write_text(absolute, f"{existing}{joiner}{payload}")

    def _write_remote_version(self, rel: str, absolute: Path) -> None:
        shown = self._git("show", f"FETCH_HEAD:{rel}", check=False)
        # A note the remote deleted resolves to empty, and the payload below
        # recreates it — an append should not lose the text it was given.
        self._atomic_write_text(absolute, shown.stdout if shown.returncode == 0 else "")

    def _merge_needed(self) -> bool:
        result = self._git("merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD", check=False)
        return result.returncode != 0

    def _history_has(self, operation_id: str, ref: str) -> bool:
        result = self._git(
            "log", ref, "--grep", f"{APPEND_TRAILER}: {operation_id}",
            "--fixed-strings", "--format=%H", "-1", check=False,
        )
        return result.returncode == 0 and bool(result.stdout.strip())

    def _append_result(
        self, rel: str, absolute: Path, operation_id: str,
        *, pushed: bool, detail: str = "", delivered: bool = True,
    ) -> dict:
        return {
            "path": rel,
            "operation_id": operation_id,
            "revision": self.revision(absolute),
            "pushed": pushed,
            "delivered": delivered,
            "detail": detail,
        }
