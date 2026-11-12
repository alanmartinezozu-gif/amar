import copy
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_board_test", os.path.join(HERE, "board.py"))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)
EXAMPLE = os.path.join(HERE, "whale.example.json")


def example():
    with open(EXAMPLE, encoding="utf-8") as fh:
        return json.load(fh)


class Yes(unittest.TestCase):
    def test_only_a_plain_yes_counts(self):
        for ok in ("yes", "Yes", "y", "yes, send it"):
            self.assertTrue(B.parse_yes(ok)[0], ok)
        for no in ("", "ok", "sure", "go ahead", "yes to all", "yes, send them all", "yes?", "yes but change the first line", "no"):
            self.assertFalse(B.parse_yes(no)[0], no)


class Example(unittest.TestCase):
    def test_example_is_valid_and_tells_the_reels_story(self):
        d = example()
        errors, _ = B.validate(d)
        self.assertEqual(errors, [])
        self.assertEqual(B.money_in(d), 54000)
        self.assertEqual(len(B.paying_customers(d)), 3)
        self.assertEqual(d["marketing_spent"], 0)
        self.assertEqual(B.find(d["deals"], "north-pier")["ships_by"], "2026-12-03")

    def test_board_text(self):
        text = B.board_text(example(), B.today_arg("2026-11-05"))
        self.assertIn("Paying customers: 3 of 3", text)
        self.assertIn("$54,000.00", text)
        self.assertIn("LOST (1", text)
        self.assertIn("why: We're all set", text)


class Rules(unittest.TestCase):
    def setUp(self):
        self.d = example()

    def errors(self):
        return " ".join(B.validate(self.d)[0])

    def test_a_sent_email_needs_a_recorded_yes(self):
        next(a for a in self.d["activities"] if a["type"] == "pitch")["approval"] = None
        self.assertIn("no recorded approval", self.errors())

    def test_paid_needs_a_payment_and_a_ship_date(self):
        self.d["payments"] = [p for p in self.d["payments"] if p["deal_id"] != "north-pier"]
        self.assertIn("no payment on record", self.errors())
        self.d = example()
        B.find(self.d["deals"], "north-pier")["ships_by"] = None
        self.assertIn("no promised ship date", self.errors())

    def test_numbers_and_emails_need_a_source(self):
        p = self.d["problems"][0]
        p.update(source=None, estimate=False)
        self.assertIn("no source", self.errors())
        self.d = example()
        B.find(self.d["people"], "renee-alvarez")["email_source"] = None
        self.assertIn("never guess an address", self.errors())
        self.d = example()
        B.find(self.d["companies"], "north-pier")["spend_source"] = None
        self.assertIn("spend figure with no source", self.errors())

    def test_move_refuses_paid_without_money(self):
        self.d["payments"] = []
        with self.assertRaises(B.BoardError):
            B.move(self.d, "north-pier", "paid")

    def test_lost_needs_a_reason_and_clears_the_next_step(self):
        d = B.find(self.d["deals"], "north-pier")
        with self.assertRaises(B.BoardError):
            B.move(self.d, "north-pier", "lost")
        B.move(self.d, "north-pier", "lost", "bad timing", "2026-11-05")
        self.assertIsNone(d["next_step"])

    def test_refunded_money_stops_counting(self):
        p = next(p for p in self.d["payments"] if p["deal_id"] == "copperline")
        p["refunded_on"] = "2026-12-20"
        self.assertEqual(B.money_in(self.d), 42000)
        self.assertNotIn("copperline", B.paying_customers(self.d))

    def test_save_refuses_an_invalid_board(self):
        broken = copy.deepcopy(self.d)
        broken["deals"][0]["stage"] = "nonsense"
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "whale", "whale.json")
            with self.assertRaises(B.BoardError):
                B.save(broken, path)
            self.assertFalse(os.path.exists(path))


class Cli(unittest.TestCase):
    def test_init_never_overwrites_and_file_goes_anywhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "whale.json")
            base = ["init", "--name", "A", "--company", "B", "--email", "a@b.example", "--address", "1 Main St", "--file", path]
            self.assertEqual(B.main(base), 0)
            self.assertEqual(B.main(base), 1)
            self.assertEqual(B.main(["--file", path, "validate"]), 0)

    def test_no_means_no(self):
        for text in ("Not interested.", "We're all set, thanks.", "Please remove me from your list.", "no thanks"):
            self.assertTrue(B.NO_RE.search(text), text)
        for text in ("Interesting. Can you show me tomorrow?", "It's too expensive for us."):
            self.assertFalse(B.NO_RE.search(text), text)


if __name__ == "__main__":
    unittest.main()
