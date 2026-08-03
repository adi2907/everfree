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

        async def fake_events(api_key, payload, model, search=False):
            captured["api_key"] = api_key
            captured["payload"] = payload
            captured["model"] = model
            captured["search"] = search
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
        self.assertEqual(parts[1]["text"], assistant.CHAT_NOTE)
        self.assertIn("<current_note name=\"Work / Draft.md\">", parts[2]["text"])
        self.assertIn("# Current note\n\nThe draft.\n", parts[2]["text"])
        self.assertIn("<selected_text>\nselected words", parts[3]["text"])
        self.assertEqual(payload["contents"][-1]["parts"][0]["text"], prompt)
        # An ordinary turn carries no tools: the Gemini 3 family that answers
        # chat has a zero search-grounding allowance on the free tier.
        self.assertNotIn("tools", payload)
        self.assertNotIn("api_key", payload)
        self.assertFalse(captured["search"])
        self.assertEqual(captured["model"]["id"], "gemini-3.5-flash")

    def test_search_turns_ground_on_the_gemini_2_5_chain(self):
        captured = {}

        async def fake_events(api_key, payload, model, search=False):
            captured["payload"] = payload
            captured["model"] = model
            captured["search"] = search
            yield {"type": "delta", "text": "Grounded"}
            yield {"type": "done"}

        with patch.object(assistant, "_events", fake_events):
            response = self.client.post(
                "/api/assistant/chat",
                json={
                    "api_key": "test-key",
                    "prompt": "who won today",
                    "note": {"content": "A note"},
                    "search": True,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(captured["search"])
        self.assertEqual(captured["payload"]["tools"], [{"google_search": {}}])
        # Search must not run on the chat models, whose grounding quota is zero.
        self.assertEqual(captured["model"]["id"], "gemini-2.5-flash")
        self.assertEqual(
            captured["payload"]["systemInstruction"]["parts"][1]["text"],
            assistant.SEARCH_NOTE,
        )

    def test_daily_quota_walks_the_chain_then_reports_the_spent_mode(self):
        for search, expected_ids, scope in (
            (False, ["gemini-3.5-flash", "gemini-3.5-flash-lite"], "chat"),
            (True, ["gemini-2.5-flash", "gemini-2.5-flash-lite"], "search"),
        ):
            calls = []

            async def fake_events(api_key, payload, model, search=False):
                calls.append(model)
                raise assistant.DailyQuotaExceeded
                yield  # pragma: no cover - generator marker

            with self.subTest(search=search):
                with patch.object(assistant, "_events", fake_events):
                    response = self.client.post(
                        "/api/assistant/chat",
                        json={
                            "api_key": "test-key",
                            "prompt": "help",
                            "note": {"content": "A note"},
                            "search": search,
                        },
                    )

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual([model["id"] for model in calls], expected_ids)
                events = [json.loads(line) for line in response.text.splitlines()]
                self.assertEqual(events[-1]["type"], "error")
                # The client needs the mode: a spent search budget still leaves
                # ordinary chat usable, and the two must not be conflated.
                self.assertEqual(events[-1]["scope"], scope)

    def test_a_model_that_starts_answering_is_never_retried(self):
        """Falling through mid-stream would duplicate text already shown."""
        calls = []

        async def fake_events(api_key, payload, model, search=False):
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
        self.assertIn("/search", response.text)


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
            "chat_models": [{"id": "gemini-next", "name": "Gemini Next", "daily_requests": 500}],
            "search_models": [{"id": "gemini-next-search", "name": "Gemini Next Search", "daily_requests": 20}],
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
        self.assertEqual(assistant.SEARCH_MODELS[0]["name"], "Gemini Next Search")

    def test_malformed_or_incomplete_fetched_configs_are_rejected(self):
        deployed = self._deployed_config()
        rejected = [
            None,
            "not a config",
            {},
            {k: v for k, v in deployed.items() if k != "search_models"},
            {**deployed, "system_prompt": "   "},
            {**deployed, "chat_models": [{"id": "gemini-next"}]},            # no name
            {**deployed, "search_models": [{"name": "Gemini Next"}]},        # no id
            {**deployed, "chat_models": "gemini-next"},                      # not a list
            {**deployed, "chat_models": []},                                 # nothing to call
            {**deployed, "search_models": ["gemini-next"]},                  # not model dicts
        ]
        for bad in rejected:
            with self.subTest(config=bad):
                async def fetch(*_args, _bad=bad):
                    return _bad

                self.assertFalse(self._refresh_with(fetch))
                self._assert_bundled_config_in_use()

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
