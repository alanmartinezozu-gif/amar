import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_offer_test", os.path.join(HERE, "offer.py"))
O = importlib.util.module_from_spec(spec)
spec.loader.exec_module(O)
B = O.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def fresh():
    with open(EXAMPLE, encoding="utf-8") as fh:
        d = json.load(fh)
    d["requirements"] = []
    return d


class Draft(unittest.TestCase):
    def setUp(self):
        self.d = fresh()

    def test_it_says_everything_and_passes_its_own_lint(self):
        text = O.draft(self.d, "north-pier", gets=["Every late invoice chased automatically"])
        self.assertIn("$6,400 a month", text)
        self.assertIn("$76,800 a year", text)
        self.assertIn("$24,000.00, paid up front", text)
        self.assertIn("Ships within 30 days", text)
        self.assertIn("not finished", text)
        self.assertIn("every dollar back", text)
        self.assertEqual(O.lint(text), [])

    def test_what_they_get_is_never_made_up(self):
        self.assertIn("fill this in: what they get, from what they told you", O.lint(O.draft(self.d, "north-pier")))

    def test_needs_terms_and_a_price(self):
        self.d["offer"] = {}
        with self.assertRaises(B.BoardError):
            O.draft(self.d, "north-pier")
        self.d = fresh()
        B.find(self.d["deals"], "harrow-line")["amount"] = 0
        with self.assertRaises(B.BoardError):
            O.draft(self.d, "harrow-line")


class Lint(unittest.TestCase):
    GOOD = "$24,000. Ships within 30 days. It is not finished yet. You get every dollar back if we miss the date."

    def test_good(self):
        self.assertEqual(O.lint(self.GOOD), [])

    def test_missing_pieces(self):
        for bad, why in (("Ships within 30 days. Not finished. Money back.", "no price"), ("$24,000. Not finished. Money back.", "no ship date"),
                         ("$24,000. Ships in 30 days. Money back.", "not finished"), ("$24,000. Ships in 30 days. Not finished.", "money back")):
            self.assertTrue(any(why in p for p in O.lint(bad)), bad)

    def test_fake_urgency_and_big_claims(self):
        for bad in ("Act now!", "Only 3 spots left", "Limited time", "Guaranteed results", "Trusted by thousands of companies", "The #1 tool", "Risk-free"):
            self.assertTrue(any("cut" in p for p in O.lint(self.GOOD + " " + bad)), bad)


class Record(unittest.TestCase):
    def setUp(self):
        self.d = fresh()
        B.find(self.d["deals"], "north-pier")["stage"] = "demo-booked"

    def test_needs_a_yes_and_a_clean_offer(self):
        with self.assertRaises(B.BoardError):
            O.record(self.d, "north-pier", Lint.GOOD, "sure", "2026-11-02T10:15")
        with self.assertRaises(B.BoardError):
            O.record(self.d, "north-pier", "Act now!", "yes", "2026-11-02T10:15")
        O.record(self.d, "north-pier", Lint.GOOD, "yes", "2026-11-02T10:15")
        self.assertEqual(B.find(self.d["deals"], "north-pier")["stage"], "offer-sent")


if __name__ == "__main__":
    unittest.main()
