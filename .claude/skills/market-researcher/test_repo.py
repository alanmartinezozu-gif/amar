import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = ["market-researcher", "demo-builder", "whale-hunter", "pre-sale", "requirements", "offer-builder",
          "pricing", "follow-up", "objection-handler", "case-study", "launch-planner"]
ABOUT = "11 Claude skills that get you paying customers before you launch. Research, demo, pitch, pre-sale. Free."
# skills that can send, create or charge something on the user's behalf carry the consent rule
SENDS = ["whale-hunter", "pre-sale", "offer-builder", "follow-up", "objection-handler"]
ASKS = SENDS + ["requirements", "case-study"]


def frontmatter(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return (m.group(1) if m else ""), text


def every_text_file():
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "whale")]
        for f in files:
            if f.endswith((".md", ".py", ".json", ".csv", ".txt")) or f == "LICENSE":
                yield os.path.join(base, f)


class Repo(unittest.TestCase):
    def test_root_matches_the_reel(self):
        root = sorted(d for d in os.listdir(ROOT) if d not in (".git", ".gitignore", ".DS_Store", "whale", "__pycache__"))
        self.assertEqual(root, sorted([".claude-plugin", "LICENSE", "README.md"] + SKILLS))

    def test_frontmatter_name_and_description(self):
        for s in SKILLS:
            fm, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            self.assertIn("name: %s\n" % s, fm + "\n", s)
            self.assertRegex(fm, r"description: ", s)
            self.assertGreater(len(fm), 300, "%s description is too thin" % s)
            self.assertGreater(len(text.splitlines()), 60, s)
            self.assertIn("${CLAUDE_SKILL_DIR}", text, s)
            self.assertIn("## Consent and truth", text, s)

    def test_every_tool_named_in_a_skill_exists(self):
        for s in SKILLS:
            _, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            for script in set(re.findall(r"\$\{CLAUDE_SKILL_DIR\}/([\w./-]+\.py)", text)):
                self.assertTrue(os.path.exists(os.path.normpath(os.path.join(ROOT, s, script))), "%s/%s" % (s, script))

    def test_skills_only_point_at_skills_that_exist(self):
        builtin = {"plugin"}
        for path in [os.path.join(ROOT, s, "SKILL.md") for s in SKILLS]:
            _, text = frontmatter(path)
            for name in re.findall(r"(?<![\w/.-])/([a-z]+(?:-[a-z]+)+|pricing|requirements)\b", text):
                self.assertIn(name, set(SKILLS) | builtin, "%s points at /%s" % (path, name))

    def test_sending_skills_ask_first(self):
        for s in ASKS:
            _, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            self.assertIn("reply yes or no", " ".join(text.lower().split()), s)
        for s in SENDS:
            _, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            self.assertRegex(" ".join(text.lower().split()), r"never (send|sends)", s)

    def test_plugin_manifests(self):
        with open(os.path.join(ROOT, ".claude-plugin", "plugin.json")) as fh:
            plugin = json.load(fh)
        self.assertEqual(plugin["name"], "whale-skill")
        self.assertEqual(plugin["description"], ABOUT)
        self.assertEqual(plugin["skills"], "./")
        with open(os.path.join(ROOT, ".claude-plugin", "marketplace.json")) as fh:
            market = json.load(fh)
        self.assertEqual(market["name"], "whale-skill")
        self.assertEqual(market["plugins"][0]["name"], "whale-skill")

    def test_readme_carries_the_reel_copy(self):
        with open(os.path.join(ROOT, "README.md"), encoding="utf-8") as fh:
            readme = " ".join(fh.read().split())
        self.assertTrue(readme.startswith("# The Whale skill"))
        for line in ("Eleven Claude skills that get you paying customers before you launch.",
                     "problems businesses already pay thousands to solve",
                     "gets customers to pay up front and uses their requirements to build the exact product",
                     "https://github.com/Jakeschincariol/whale-skill install skill",
                     "/plugin marketplace add Jakeschincariol/whale-skill",
                     "/plugin install whale-skill@whale-skill",
                     "## Fine print"):
            self.assertIn(line, readme)
        for s in SKILLS:
            self.assertIn("`%s`" % s, readme, s)

    def test_the_reels_numbers_add_up(self):
        with open(os.path.join(ROOT, "market-researcher", "whale.example.json"), encoding="utf-8") as fh:
            board = json.load(fh)
        self.assertIn("fictional", board["_about"])
        self.assertEqual(sorted(p["amount"] for p in board["payments"]), [12000, 18000, 24000])
        with open(os.path.join(ROOT, "demo-builder", "demo.example.json"), encoding="utf-8") as fh:
            demo = json.load(fh)
        total = sum(float(r["amount"].replace("$", "").replace(",", "")) for r in demo["rows"])
        self.assertEqual(total, 48210)

    def test_no_em_dashes_and_no_personal_email(self):
        for path in every_text_file():
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            rel = os.path.relpath(path, ROOT)
            self.assertNotIn("—", text, rel)
            self.assertNotIn("jakeschincariol" + "@" + "gmail.com", text, rel)

    def test_no_real_card_numbers(self):
        card = re.compile(r"\b(?:\d[ -]?){13,19}\b")
        for path in every_text_file():
            with open(path, encoding="utf-8", errors="replace") as fh:
                for found in card.findall(fh.read()):
                    digits = re.sub(r"\D", "", found)
                    self.assertTrue(digits.startswith("4242424242424242") or not self.luhn(digits), "%s: %s" % (path, found))

    @staticmethod
    def luhn(digits):
        total = 0
        for i, ch in enumerate(reversed(digits)):
            n = int(ch)
            if i % 2:
                n = n * 2 - 9 if n > 4 else n * 2
            total += n
        return total % 10 == 0


if __name__ == "__main__":
    unittest.main()
