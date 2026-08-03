"""Contract tests for the deliberately small embedded assistant."""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch

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
        self.assertEqual(payload["tools"], [{"google_search": {}}])
        self.assertNotIn("api_key", payload)
        self.assertEqual(captured["model"]["id"], "gemini-3.5-flash-lite")

    def test_daily_quota_falls_back_to_gemma_without_search(self):
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
        fallback_payload = calls[1][0]
        self.assertNotIn("tools", fallback_payload)
        self.assertEqual(fallback_payload["systemInstruction"]["parts"][-1]["text"], assistant.FALLBACK_PROMPT)
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


if __name__ == "__main__":
    unittest.main()
