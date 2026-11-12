import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_followup_test", os.path.join(HERE, "followup.py"))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)
B = F.B


def board(pitched="2026-10-26T09:04"):
    d = B.empty({"name": "Sam Rivera", "company": "Your Company", "address": "100 Main St, Austin, TX"})
    d["companies"].append({"id": "acme", "name": "Acme"})
    d["people"].append({"id": "pat", "company_id": "acme", "name": "Pat Doe", "decides": "signs", "email": "pat@acme.example", "email_source": "their site"})
    d["deals"].append({"id": "acme", "company_id": "acme", "person_id": "pat", "stage": "pitched", "amount": 0, "next_step": "x"})
    B.add_activity(d, date=pitched, deal_id="acme", person_id="pat", channel="email", type="pitch", direction="out", subject="s", text="t", approval="yes")
    return d


def day(s):
    return B.today_arg(s)


class Cadence(unittest.TestCase):
    def test_first_follow_up_after_two_days(self):
        d = board()
        self.assertEqual(F.state(d, d["deals"][0], day("2026-10-27"))["status"], "WAITING")
        self.assertEqual(F.state(d, d["deals"][0], day("2026-10-28"))["status"], "DUE")

    def test_a_weekend_moves_to_monday(self):
        d = board("2026-10-29T09:00")  # a Thursday: two days later is Saturday
        s = F.state(d, d["deals"][0], day("2026-10-31"))
        self.assertEqual((s["status"], s["on"]), ("WAITING", "2026-11-02"))

    def test_three_then_stop(self):
        d = board()
        for stamp in ("2026-10-28T09:00", "2026-10-30T09:00", "2026-11-03T09:00"):
            F.record(d, "acme", "note", "yes", stamp)
        s = F.state(d, d["deals"][0], day("2026-11-20"))
        self.assertEqual(s["status"], "STOPPED")
        with self.assertRaises(B.BoardError):
            F.draft(d, "acme", day("2026-11-20"))

    def test_nothing_after_thirty_days(self):
        d = board()
        self.assertEqual(F.state(d, d["deals"][0], day("2026-11-26"))["status"], "STOPPED")


class Rules(unittest.TestCase):
    def setUp(self):
        self.d = board()

    def test_never_a_fake_re(self):
        draft = F.draft(self.d, "acme", day("2026-10-28"))
        self.assertNotIn("subject", draft)
        self.assertIn("same thread", draft["thread"])
        self.assertIn("bumping", draft["body"])
        self.assertIn('Reply "stop"', draft["body"])

    def test_the_second_one_has_to_give_something(self):
        F.record(self.d, "acme", "note", "yes", "2026-10-28T09:00")
        with self.assertRaises(B.BoardError):
            F.draft(self.d, "acme", day("2026-10-30"))
        self.assertIn("a worked example", F.draft(self.d, "acme", day("2026-10-30"), hook="here is a worked example.")["body"])

    def test_record_needs_a_yes(self):
        with self.assertRaises(B.BoardError):
            F.record(self.d, "acme", "note", "sure", "2026-10-28T09:00")

    def test_record_refuses_when_nothing_is_due(self):
        with self.assertRaises(B.BoardError):
            F.record(self.d, "acme", "note", "yes", "2026-10-27T09:00")

    def test_a_reply_is_your_turn(self):
        self.assertEqual(F.reply(self.d, "acme", "Sure, send a time.", "2026-10-27T10:00"), "your turn")
        self.assertEqual(self.d["deals"][0]["stage"], "replied")
        self.assertEqual(F.state(self.d, self.d["deals"][0], day("2026-10-29"))["status"], "YOUR TURN")

    def test_a_no_stops_everything(self):
        self.assertEqual(F.reply(self.d, "acme", "We're all set, thanks.", "2026-10-27T10:00"), "stopped")
        deal = self.d["deals"][0]
        self.assertEqual(deal["stage"], "lost")
        self.assertEqual(deal["lost_reason"], "We're all set, thanks.")
        self.assertEqual(F.state(self.d, deal, day("2026-10-29"))["status"], "STOPPED")

    def test_an_unsubscribe_is_for_good(self):
        F.reply(self.d, "acme", "Please remove me from your list.", "2026-10-27T10:00")
        self.assertIn("pat@acme.example", self.d["suppression"])
        self.assertTrue(self.d["people"][0]["do_not_contact"])

    def test_a_booked_demo_ends_it(self):
        self.d["deals"][0]["stage"] = "demo-booked"
        self.assertEqual(F.state(self.d, self.d["deals"][0], day("2026-10-29"))["status"], "BOOKED")

    def test_an_offer_starts_its_own_count(self):
        F.reply(self.d, "acme", "Sure.", "2026-10-27T10:00")
        self.d["deals"][0]["stage"] = "offer-sent"
        B.add_activity(self.d, date="2026-11-02T10:00", deal_id="acme", person_id="pat", channel="email", type="offer", direction="out", approval="yes")
        s = F.state(self.d, self.d["deals"][0], day("2026-11-04"))
        self.assertEqual((s["status"], s["number"], s["kind"]), ("DUE", 1, "offer"))
        self.assertIn("the offer", F.draft(self.d, "acme", day("2026-11-04"))["body"])

    def test_due_text_groups(self):
        text = F.due_text(self.d, day("2026-10-28"))
        self.assertTrue(text.startswith("DUE NOW"))


if __name__ == "__main__":
    unittest.main()
