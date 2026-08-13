"""AGENTS.md and CLAUDE.md must not drift apart.

Both files are read as authority by different tools, and they had already
diverged once: AGENTS.md still required web tokens to live in tab-scoped
`sessionStorage` long after CLAUDE.md recorded the deliberate move to
`localStorage`. An agent that read the wrong file would have "fixed" a decision
the project had made on purpose.

Keeping the invariants in a delimited block that has to match byte for byte
makes that failure impossible rather than merely unlikely.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BEGIN = "<!-- BEGIN SHARED INVARIANTS -->"
END = "<!-- END SHARED INVARIANTS -->"


def _shared_section(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        raise AssertionError(f"{path.name} is missing the shared invariants block")
    return text.split(BEGIN, 1)[1].split(END, 1)[0]


class SharedInvariantsTests(unittest.TestCase):
    def setUp(self):
        self.agents = ROOT / "AGENTS.md"
        self.claude = ROOT / "CLAUDE.md"

    def test_both_files_carry_the_same_invariants(self):
        self.assertEqual(
            _shared_section(self.agents),
            _shared_section(self.claude),
            "AGENTS.md and CLAUDE.md invariants have drifted — update both.",
        )

    def test_the_shared_section_is_not_empty(self):
        self.assertGreater(len(_shared_section(self.agents).strip()), 500)

    def test_neither_file_still_requires_sessionstorage_for_tokens(self):
        """The rule that actually drifted, pinned so it cannot come back."""
        for path in (self.agents, self.claude):
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r"sessionStorage", text):
                context = text[max(0, match.start() - 300):match.end() + 300]
                self.assertIn(
                    "5759c38", context,
                    f"{path.name} mentions sessionStorage outside the note "
                    "explaining why it was reversed",
                )

    def test_referenced_documents_exist(self):
        section = _shared_section(self.agents)
        for target in re.findall(r"\]\((docs/[^)]+)\)", section):
            with self.subTest(target=target):
                self.assertTrue((ROOT / target).is_file(), f"{target} is missing")


if __name__ == "__main__":
    unittest.main()
