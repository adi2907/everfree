"""Contract tests for the deliberately small embedded assistant."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from server import assistant
from server.app import app


class AssistantTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_request_keeps_contexts_separate_and_prompt_exact(self):
        captured = {}

        async def fake_events(api_key, payload, model):
            captured["api_key"] = api_key
            captured["payload"] = payload
            captured["model"] = model
            yield {"type": "delta", "text": "Done"}
            yield {"type": "done"}

        prompt = "  complete this paragraph\n"
        with patch.object(assistant, "_events", fake_events):
            response = self.client.post(
                "/api/assistant/chat",
                json={
                    "api_key": "test-key",
                    "note": {
                        "notebook": "Work",
                        "note": "Draft.md",
                        "content": "# Current note\n\nThe draft.\n",
                    },
                    "selection": {"text": "selected words"},
                    "history": [
                        {"role": "user", "content": "Earlier question"},
                        {"role": "assistant", "content": "Earlier answer"},
                    ],
                    "prompt": prompt,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = captured["payload"]
        parts = payload["systemInstruction"]["parts"]
        self.assertEqual(parts[0]["text"], assistant.SYSTEM_PROMPT)
        self.assertIn("<current_note name=\"Work / Draft.md\">", parts[1]["text"])
        self.assertIn("# Current note\n\nThe draft.\n", parts[1]["text"])
        self.assertIn("<selected_text>\nselected words", parts[2]["text"])
        self.assertEqual(parts[3]["text"], assistant.CHAT_NOTE)
        self.assertEqual(payload["contents"][-1]["parts"][0]["text"], prompt)
        # An ordinary turn has no tools at all: nothing it can call reaches
        # beyond the note, the selection, and the conversation.
        self.assertNotIn("tools", payload)
        self.assertNotIn("api_key", payload)
        self.assertEqual(captured["model"]["id"], "gemini-3.5-flash")

    def test_daily_quota_walks_the_chain_then_reports_a_spent_budget(self):
        calls = []

        async def fake_events(api_key, payload, model):
            calls.append(model)
            raise assistant.DailyQuotaExceeded
            yield  # pragma: no cover - generator marker

        with patch.object(assistant, "_events", fake_events):
            response = self.client.post(
                "/api/assistant/chat",
                json={"api_key": "test-key", "prompt": "help", "note": {"content": "A note"}},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([model["id"] for model in calls], [
            "gemini-3.5-flash",
            "gemini-3.5-flash-lite",
        ])
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]["type"], "error")
        # The client remembers this for the rest of the day rather than letting
        # the user spend another turn rediscovering it.
        self.assertTrue(events[-1]["quota_spent"])

    def test_a_model_that_starts_answering_is_never_retried(self):
        """Falling through mid-stream would duplicate text already shown."""
        calls = []

        async def fake_events(api_key, payload, model):
            calls.append(model)
            yield {"type": "delta", "text": "Partial"}
            raise assistant.DailyQuotaExceeded

        with patch.object(assistant, "_events", fake_events):
            response = self.client.post(
                "/api/assistant/chat",
                json={"api_key": "test-key", "prompt": "help", "note": {"content": "A note"}},
            )

        self.assertEqual(response.status_code, 200, response.text)
        # No second attempt, so the shown text is never restarted or doubled.
        self.assertEqual(len(calls), 1)
        deltas = [
            json.loads(line) for line in response.text.splitlines()
            if json.loads(line)["type"] == "delta"
        ]
        self.assertEqual(len(deltas), 1)

    def test_quota_errors_distinguish_daily_temporary_and_opaque_429s(self):
        daily = '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}'
        minute = '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}'
        opaque = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'
        self.assertEqual(assistant._quota_kind(429, daily), "daily")
        self.assertEqual(assistant._quota_kind(429, minute), "temporary")
        self.assertEqual(assistant._quota_kind(429, opaque), "unknown")
        self.assertIsNone(assistant._quota_kind(400, daily))

    def test_google_errors_are_human_readable_and_not_raw_truncated_json(self):
        raw = json.dumps({"error": {"message": "A detailed explanation " * 30}})
        detail = assistant._google_error_detail(400, raw)
        self.assertIn("A detailed explanation", detail)
        self.assertGreater(len(detail), 240)
        self.assertNotIn("Gemini HTTP", detail)
        temporary = assistant._google_error_detail(
            429,
            '{"error":{"message":"Please retry in 42s"}}',
        )
        self.assertEqual(
            temporary,
            "Gemini is temporarily rate-limited. Wait a moment and try again.",
        )

    def test_search_goes_to_openrouter_with_the_note_as_context(self):
        captured = {}

        async def fake_search(api_key, payload, model):
            captured["api_key"] = api_key
            captured["payload"] = payload
            yield {"type": "sources", "sources": [{"url": "https://example.com", "title": "Example"}]}
            yield {"type": "delta", "text": "Answer"}
            yield {"type": "done"}

        with patch.object(assistant, "_search_events", fake_search):
            response = self.client.post(
                "/api/assistant/chat",
                json={
                    "api_key": "gemini-key",
                    "search_key": "openrouter-key",
                    "search": True,
                    "note": {"note": "Draft.md", "content": "Automation reshapes the workforce."},
                    "selection": {"text": ""},
                    "prompt": "find vanished professions",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        # The search key is the only one that travels to OpenRouter; the Gemini
        # key must not leak across providers.
        self.assertEqual(captured["api_key"], "openrouter-key")
        payload = captured["payload"]
        self.assertNotIn("gemini-key", json.dumps(payload))
        self.assertEqual(payload["model"], "nvidia/nemotron-3-ultra-550b-a55b:free")
        self.assertEqual(payload["plugins"], [{"id": "web", "max_results": 8}])
        self.assertTrue(payload["stream"])
        system = payload["messages"][0]
        self.assertEqual(system["role"], "system")
        # The note rides along as context and the turn is told it can search.
        self.assertIn("Automation reshapes the workforce.", system["content"])
        self.assertIn(assistant.SEARCH_NOTE, system["content"])
        self.assertNotIn(assistant.CHAT_NOTE, system["content"])
        self.assertEqual(payload["messages"][-1], {"role": "user", "content": "find vanished professions"})
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[0]["type"], "sources")
        self.assertEqual(events[0]["sources"][0]["url"], "https://example.com")

    def test_search_without_an_openrouter_key_is_refused_before_any_request(self):
        called = []

        async def fake_search(api_key, payload, model):
            called.append(model)
            yield {"type": "done"}

        with patch.object(assistant, "_search_events", fake_search):
            response = self.client.post(
                "/api/assistant/chat",
                json={"api_key": "gemini-key", "search": True, "prompt": "find things"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("OpenRouter", response.json()["detail"])
        # A Gemini key must not silently stand in for the missing one.
        self.assertEqual(called, [])

    def test_search_falls_through_a_rate_limited_model_then_reports_it(self):
        calls = []

        async def fake_search(api_key, payload, model):
            calls.append(model)
            raise assistant.SearchUnavailable
            yield  # pragma: no cover - generator marker

        with patch.object(assistant, "_search_events", fake_search):
            response = self.client.post(
                "/api/assistant/chat",
                json={"search_key": "openrouter-key", "search": True, "prompt": "find things"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([model["id"] for model in calls], [
            "nvidia/nemotron-3-ultra-550b-a55b:free",
            "nvidia/nemotron-3-super-120b-a12b:free",
        ])
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]["type"], "error")
        # A rate-limited search is temporary, so it must not be recorded as a
        # spent daily budget the way an exhausted Gemini chain is.
        self.assertNotIn("quota_spent", events[-1])

    def test_openrouter_errors_name_the_cause(self):
        self.assertIn("rejected the key", assistant._openrouter_error_detail(401, "{}"))
        self.assertIn("out of credit", assistant._openrouter_error_detail(402, "{}"))
        detail = assistant._openrouter_error_detail(
            500, '{"error":{"message":"upstream exploded"}}'
        )
        self.assertIn("upstream exploded", detail)

    def test_chat_requires_a_key_and_message(self):
        missing_key = self.client.post(
            "/api/assistant/chat", json={"prompt": "hello"}
        )
        self.assertEqual(missing_key.status_code, 400)
        blank = self.client.post(
            "/api/assistant/chat", json={"api_key": "key", "prompt": "  "}
        )
        self.assertEqual(blank.status_code, 400)

    def test_shared_assistant_script_is_served(self):
        response = self.client.get("/static/assistant.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("cache-control"), "no-cache")
        self.assertIn("EverFreeNoteContext", response.text)
        self.assertIn("Using Gemini 3.5 Flash", response.text)
        self.assertIn("500 Gemini 3.5 Flash-Lite requests per day", response.text)
        # /search is offered in the UI and gated on its own stored key.
        self.assertIn("/search", response.text)
        self.assertIn("everfree-openrouter-key", response.text)
        self.assertIn("ef-ai-sources", response.text)

    def test_sign_out_clears_the_search_key_with_the_chat_key(self):
        """A key left behind after sign-out would outlive the session. ADR 0001."""
        web = Path(assistant.__file__).resolve().parent.parent / "web"
        for client in ("app.js", Path("mobile") / "app.js"):
            with self.subTest(client=str(client)):
                source = (web / client).read_text(encoding="utf-8")
                self.assertIn("everfree-openrouter-key", source)


class ConfigRefreshTests(unittest.TestCase):
    """The desktop app's bundled config is frozen at build time, so it refreshes
    from the web deployment in the background. A bad or missing fetch must leave
    the bundled config in place."""

    def setUp(self):
        self.bundled = {
            "chat_models": assistant.CHAT_MODELS,
            "search_models": assistant.SEARCH_MODELS,
            "system_prompt": assistant.SYSTEM_PROMPT,
            "config": assistant.CONFIG,
        }
        cache = Path(tempfile.mkdtemp()) / "cache.json"
        patcher = patch.object(assistant, "CONFIG_CACHE_FILE", cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cache = cache
        self.addCleanup(self._restore_bundled)

    def _restore_bundled(self):
        assistant.CHAT_MODELS = self.bundled["chat_models"]
        assistant.SEARCH_MODELS = self.bundled["search_models"]
        assistant.SYSTEM_PROMPT = self.bundled["system_prompt"]
        assistant.CONFIG = self.bundled["config"]

    def _assert_bundled_config_in_use(self):
        self.assertEqual(assistant.SYSTEM_PROMPT, self.bundled["system_prompt"])
        self.assertEqual(assistant.CHAT_MODELS, self.bundled["chat_models"])
        self.assertEqual(assistant.SEARCH_MODELS, self.bundled["search_models"])

    @staticmethod
    def _deployed_config():
        return {
            "chat_models": [
                {"id": "gemini-next", "name": "Gemini Next", "daily_requests": 500},
                {"id": "gemini-next-lite", "name": "Gemini Next Lite", "daily_requests": 500},
            ],
            "search_models": [{"id": "vendor/search-next:free", "name": "Search Next"}],
            "system_prompt": "You are the deployed assistant.",
        }

    def _refresh_with(self, fetch):
        with patch.object(assistant, "_fetch_config", fetch):
            return asyncio.run(assistant.refresh_config())

    def test_bundled_config_is_kept_when_the_fetch_fails(self):
        async def offline(*_args):
            raise httpx.ConnectError("offline")

        self.assertFalse(self._refresh_with(offline))
        self._assert_bundled_config_in_use()

    def test_valid_fetched_config_replaces_the_bundled_one(self):
        deployed = self._deployed_config()

        async def fetch(*_args):
            return deployed

        self.assertTrue(self._refresh_with(fetch))
        self.assertEqual(assistant.SYSTEM_PROMPT, "You are the deployed assistant.")
        self.assertEqual(assistant.CHAT_MODELS[0]["id"], "gemini-next")
        self.assertEqual(assistant.CHAT_MODELS[1]["name"], "Gemini Next Lite")

    def test_malformed_or_incomplete_fetched_configs_are_rejected(self):
        deployed = self._deployed_config()
        rejected = [
            None,
            "not a config",
            {},
            {k: v for k, v in deployed.items() if k != "chat_models"},
            {**deployed, "system_prompt": "   "},
            {**deployed, "chat_models": [{"id": "gemini-next"}]},            # no name
            {**deployed, "chat_models": [{"name": "Gemini Next"}]},          # no id
            {**deployed, "chat_models": "gemini-next"},                      # not a list
            {**deployed, "chat_models": []},                                 # nothing to call
            {**deployed, "chat_models": ["gemini-next"]},                    # not model dicts
            {k: v for k, v in deployed.items() if k != "search_models"},      # /search unroutable
            {**deployed, "search_models": []},                               # nothing to call
            {**deployed, "search_models": [{"id": "vendor/search-next:free"}]},  # no name
        ]
        for bad in rejected:
            with self.subTest(config=bad):
                async def fetch(*_args, _bad=bad):
                    return _bad

                self.assertFalse(self._refresh_with(fetch))
                self._assert_bundled_config_in_use()

    def test_a_deployed_config_predating_search_cannot_disable_search(self):
        """The deployment can lag the app, and the refresh must survive the gap.

        A config served before /search existed carries no `search_models`. Taking
        it would leave the running code with nothing to route a search to, so it
        is rejected outright and the bundled config stays. This is the shape that
        was live at the time /search was built.
        """
        predates_search = {
            "chat_models": [{"id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash", "daily_requests": 500}],
            "system_prompt": "You are the deployed assistant.",
        }

        async def fetch(*_args):
            return predates_search

        self.assertFalse(self._refresh_with(fetch))
        self._assert_bundled_config_in_use()
        # Nothing was cached either, so the next start does not resurrect it.
        self.assertFalse(self.cache.exists())
        # And a search turn still builds against the bundled models.
        payload = assistant._search_payload(
            {"content": "note"}, {}, [], "find things", assistant.SEARCH_MODELS[0],
        )
        self.assertEqual(payload["model"], assistant.SEARCH_MODELS[0]["id"])

    def test_omitted_turn_notes_still_instruct_the_model_to_cite(self):
        """The notes are optional, so their defaults carry the whole instruction.

        A config with search models but no `search_note` is legitimate. Falling
        back to a note that merely announces search would quietly stop the answer
        citing anything, leaving the sources the client renders unmatched by the
        prose.
        """
        deployed = self._deployed_config()
        no_notes = {k: v for k, v in deployed.items() if k not in {"chat_note", "search_note"}}

        async def fetch(*_args):
            return no_notes

        self.assertTrue(self._refresh_with(fetch))
        self.assertIn("cite", assistant.SEARCH_NOTE.lower())
        self.assertIn("never claim", assistant.CHAT_NOTE.lower())
        self.assertEqual(assistant.SEARCH_MAX_RESULTS, 8)
        blocks = assistant._context_blocks({"content": "note"}, {}, True)
        self.assertIn("cite", blocks[-1].lower())

    def test_oversized_or_unparseable_downloads_are_discarded(self):
        oversized = httpx.Response(200, content=b"x" * (assistant.CONFIG_MAX_BYTES + 1))
        not_json = httpx.Response(200, content=b"<!doctype html>")
        missing = httpx.Response(404, content=b"")
        for response in (oversized, not_json, missing):
            with self.subTest(status=response.status_code):
                async def get(*_args, _response=response, **_kwargs):
                    return _response

                with patch.object(httpx.AsyncClient, "get", get):
                    self.assertIsNone(asyncio.run(assistant._fetch_config()))

    def test_last_good_config_is_reused_when_an_offline_restart_cannot_fetch(self):
        deployed = self._deployed_config()

        async def fetch(*_args):
            return deployed

        self._refresh_with(fetch)
        self._restore_bundled()

        async def offline(*_args):
            raise httpx.ConnectError("offline")

        self.assertTrue(self._refresh_with(offline))
        self.assertEqual(assistant.SYSTEM_PROMPT, "You are the deployed assistant.")

    def test_cache_is_dropped_when_the_app_ships_a_new_bundled_config(self):
        deployed = self._deployed_config()

        async def fetch(*_args):
            return deployed

        self._refresh_with(fetch)
        self._restore_bundled()

        async def offline(*_args):
            raise httpx.ConnectError("offline")

        with patch.object(assistant, "BUNDLED_CONFIG_TEXT", '{"rebuilt": true}'):
            self.assertFalse(self._refresh_with(offline))
        self._assert_bundled_config_in_use()

    def test_config_url_is_a_fixed_https_constant(self):
        self.assertTrue(assistant.CONFIG_URL.startswith("https://"))
        source = Path(assistant.__file__).read_text(encoding="utf-8")
        self.assertNotIn("EVERFREE_ASSISTANT_CONFIG_URL", source)
        self.assertNotIn("os.environ.get(\"EVERFREE_CONFIG", source)

    def test_startup_is_not_blocked_by_a_slow_fetch(self):
        started = threading.Event()

        async def slow(*_args):
            started.set()
            await asyncio.sleep(30)
            raise AssertionError("startup waited for the fetch")

        with patch.object(assistant, "_is_desktop_build", lambda: True), \
                patch.object(assistant, "_fetch_config", slow):
            begin = time.monotonic()
            with TestClient(app):
                elapsed = time.monotonic() - begin
                # The refresh is running, but startup did not wait for it.
                self.assertTrue(started.wait(5))
        self.assertLess(elapsed, 5)
        self._assert_bundled_config_in_use()

    def test_refresh_is_skipped_outside_the_packaged_app(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RESOURCEPATH", None)
            self.assertFalse(assistant._is_desktop_build())
            self.assertIsNone(assistant.start_config_refresh())


if __name__ == "__main__":
    unittest.main()
