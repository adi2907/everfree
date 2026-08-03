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
        self.assertEqual(payload["contents"][-1]["parts"][0]["text"], prompt)
        # No tools at all: grounding is rejected on a key without billing, and
        # sending it made every request 429 into the Gemma fallback.
        self.assertNotIn("tools", payload)
        self.assertNotIn("api_key", payload)
        self.assertEqual(captured["model"]["id"], "gemini-3.5-flash-lite")

    def test_daily_quota_falls_back_to_gemma(self):
        calls = []

        async def fake_events(api_key, payload, model):
            calls.append((payload, model))
            if model["id"] == assistant.PRIMARY_MODEL["id"]:
                raise assistant.DailyQuotaExceeded
            yield {
                "type": "model",
                "id": model["id"],
                "name": model["name"],
                "fallback": True,
            }
            yield {"type": "delta", "text": "Fallback answer"}
            yield {"type": "done"}

        with patch.object(assistant, "_events", fake_events):
            response = self.client.post(
                "/api/assistant/chat",
                json={"api_key": "test-key", "prompt": "help", "note": {"content": "A note"}},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([model["id"] for _, model in calls], [
            "gemini-3.5-flash-lite",
            "gemma-4-31b-it",
        ])
        # Both models get the identical payload; nothing is model-specific now.
        self.assertEqual(calls[0][0], calls[1][0])
        self.assertNotIn("tools", calls[1][0])
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[0]["type"], "model")
        self.assertTrue(events[0]["fallback"])
        self.assertEqual(events[1], {"type": "delta", "text": "Fallback answer"})

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
        self.assertIn("Using Gemini 3.5 Flash-Lite", response.text)
        self.assertIn("14,400 Gemma 4 31B requests per day", response.text)


class ConfigRefreshTests(unittest.TestCase):
    """The desktop app's bundled config is frozen at build time, so it refreshes
    from the web deployment in the background. A bad or missing fetch must leave
    the bundled config in place."""

    def setUp(self):
        self.bundled = {
            "primary_model": assistant.PRIMARY_MODEL,
            "fallback_model": assistant.FALLBACK_MODEL,
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
        assistant.PRIMARY_MODEL = self.bundled["primary_model"]
        assistant.FALLBACK_MODEL = self.bundled["fallback_model"]
        assistant.SYSTEM_PROMPT = self.bundled["system_prompt"]
        assistant.CONFIG = self.bundled["config"]

    def _assert_bundled_config_in_use(self):
        self.assertEqual(assistant.SYSTEM_PROMPT, self.bundled["system_prompt"])
        self.assertEqual(assistant.PRIMARY_MODEL, self.bundled["primary_model"])
        self.assertEqual(assistant.FALLBACK_MODEL, self.bundled["fallback_model"])

    @staticmethod
    def _deployed_config():
        return {
            "primary_model": {"id": "gemini-next", "name": "Gemini Next", "daily_requests": 500},
            "fallback_model": {"id": "gemma-next", "name": "Gemma Next", "daily_requests": 14400},
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
        self.assertEqual(assistant.PRIMARY_MODEL["id"], "gemini-next")
        self.assertEqual(assistant.FALLBACK_MODEL["name"], "Gemma Next")

    def test_malformed_or_incomplete_fetched_configs_are_rejected(self):
        deployed = self._deployed_config()
        rejected = [
            None,
            "not a config",
            {},
            {k: v for k, v in deployed.items() if k != "fallback_model"},
            {**deployed, "system_prompt": "   "},
            {**deployed, "primary_model": {"id": "gemini-next"}},          # no name
            {**deployed, "fallback_model": {"name": "Gemma Next"}},        # no id
            {**deployed, "primary_model": "gemini-next"},
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
