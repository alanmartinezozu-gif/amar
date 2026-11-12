import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_reqs_test", os.path.join(HERE, "reqs.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
B = R.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def example():
    with open(EXAMPLE, encoding="utf-8") as fh:
        return json.load(fh)


class Reqs(unittest.TestCase):
    def setUp(self):
        self.d = example()

    def test_the_reels_four_rows(self):
        rows = [(r["ask"], r["feature"]) for r in self.d["requirements"] if r["deal_id"] == "north-pier"]
        self.assertEqual(rows, [("Text the customer first, then email", "Text + email sequence"),
                                ("Sync with QuickBooks", "QuickBooks sync"),
                                ("Escalate after 30 days", "Auto-escalation at 30 days"),
                                ("Weekly report to the CFO", "Monday CFO report")])

    def test_features_merge_across_customers_with_the_money_behind_them(self):
        build = R.build_list(self.d)["build"]
        sync = next(f for f in build if f["feature"] == "QuickBooks sync")
        self.assertEqual(sorted(sync["paying"]), ["north-pier", "saltmarsh"])
        self.assertEqual(sync["money"], 42000)
        self.assertEqual(build[-1]["feature"], "Monday CFO report")

    def test_every_line_traces_to_who_asked(self):
        text = R.build_text(self.d)
        self.assertIn('Saltmarsh Freight: "It has to work with QuickBooks"', text)
        self.assertIn("Not confirmed by the customer yet: Copperline Haul, Saltmarsh Freight", text)

    def test_someone_who_has_not_paid_waits(self):
        R.add(self.d, "harrow-line", "A mobile app", "Mobile app")
        lists = R.build_list(self.d)
        self.assertNotIn("Mobile app", [f["feature"] for f in lists["build"]])
        self.assertIn("Mobile app", [f["feature"] for f in lists["later"]])

    def test_the_same_ask_twice_is_one_ask(self):
        n = len(self.d["requirements"])
        R.add(self.d, "north-pier", "Sync with QuickBooks", "QuickBooks two-way sync")
        self.assertEqual(len(self.d["requirements"]), n)

    def test_confirm_needs_a_real_confirmation(self):
        for said in ("", "Not interested."):
            with self.assertRaises(B.BoardError):
                R.confirm(self.d, "saltmarsh", said, "2026-11-05")
        R.confirm(self.d, "saltmarsh", "Looks right to me.", "2026-11-05")
        self.assertNotIn("Saltmarsh Freight,", R.build_text(self.d).split("Not confirmed")[-1])
        self.assertEqual(B.validate(self.d)[0], [])

    def test_done_covers_everyone_who_asked(self):
        rows = R.done(self.d, "QuickBooks sync", "2026-11-20")
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["done"] for r in rows))
        self.assertIn("- [x] **QuickBooks sync**", R.build_text(self.d))
        with self.assertRaises(B.BoardError):
            R.done(self.d, "Nothing like this", "2026-11-20")

    def test_empty_board(self):
        self.assertIn("Nothing yet", R.build_text(B.empty()))


if __name__ == "__main__":
    unittest.main()
