import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_presale_test", os.path.join(HERE, "presale.py"))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
B = S.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def example():
    with open(EXAMPLE, encoding="utf-8") as fh:
        return json.load(fh)


def before_payment():
    d = example()
    d["payments"] = []
    for deal in d["deals"]:
        if deal["stage"] == "paid":
            deal.update(stage="offer-sent", ships_by=None, paid_on=None)
    return d


class Terms(unittest.TestCase):
    def test_example_terms_pass(self):
        self.assertEqual(S.check_terms(example()), [])

    def test_nothing_can_be_left_out(self):
        for key in ("item", "ships_in_days", "refund_line", "not_built_line"):
            d = example()
            d["offer"][key] = None
            self.assertTrue(S.check_terms(d), key)

    def test_a_ship_date_has_a_limit(self):
        d = example()
        d["offer"]["ships_in_days"] = 365
        self.assertTrue(any("long time" in p for p in S.check_terms(d)))


class Link(unittest.TestCase):
    def setUp(self):
        self.d = before_payment()

    def test_the_buyer_sees_everything_before_paying(self):
        spec = S.link(self.d, "north-pier")
        self.assertEqual(spec["amount_display"], "$24,000.00")
        pl = spec["payment_link"]
        self.assertEqual(pl["line_items"][0]["price_data"]["unit_amount"], 2400000)
        message = pl["custom_text"]["submit"]["message"]
        self.assertIn("not finished", message)
        self.assertIn("every dollar back", message)
        self.assertIn("Ships within 30 days", pl["line_items"][0]["price_data"]["product_data"]["description"])
        self.assertEqual(pl["restrictions"]["completed_sessions"]["limit"], 1)

    def test_never_a_cold_ask(self):
        B.find(self.d["deals"], "north-pier")["stage"] = "pitched"
        with self.assertRaises(B.BoardError):
            S.link(self.d, "north-pier")

    def test_no_price_no_link(self):
        B.find(self.d["deals"], "north-pier")["amount"] = 0
        with self.assertRaises(B.BoardError):
            S.link(self.d, "north-pier")

    def test_terms_that_stripe_would_reject_are_caught_here(self):
        self.d["offer"]["refund_line"] = "x" * 600
        with self.assertRaises(B.BoardError):
            S.link(self.d, "north-pier")


class Record(unittest.TestCase):
    def setUp(self):
        self.d = before_payment()

    def test_a_test_payment_never_counts(self):
        with self.assertRaises(B.BoardError):
            S.record(self.d, "north-pier", 24000, "pi_x", "2026-11-03", live=False)
        self.assertEqual(self.d["payments"], [])

    def test_paid_sets_the_promise(self):
        deal = S.record(self.d, "north-pier", 24000, "pi_x", "2026-11-03", live=True)
        self.assertEqual(deal["stage"], "paid")
        self.assertEqual(deal["ships_by"], "2026-12-03")
        self.assertEqual(B.validate(self.d)[0], [])

    def test_same_payment_twice_and_wrong_amounts(self):
        S.record(self.d, "north-pier", 24000, "pi_x", "2026-11-03", live=True)
        with self.assertRaises(B.BoardError):
            S.record(self.d, "saltmarsh", 18000, "pi_x", "2026-11-04", live=True)
        with self.assertRaises(B.BoardError):
            S.record(self.d, "saltmarsh", 17000, "pi_y", "2026-11-04", live=True)
        with self.assertRaises(B.BoardError):
            S.record(self.d, "saltmarsh", 19000, "pi_y", "2026-11-04", live=True)

    def test_a_deposit_then_the_rest_keeps_the_first_promise(self):
        deal = S.record(self.d, "saltmarsh", 9000, "pi_a", "2026-11-04", live=True, deposit=True)
        self.assertEqual((deal["amount"], deal["ships_by"]), (18000, "2026-12-04"))
        S.record(self.d, "saltmarsh", 9000, "pi_b", "2026-11-20", live=True, deposit=True)
        self.assertEqual(deal["ships_by"], "2026-12-04")
        self.assertEqual(B.money_in(self.d), 18000)

    def test_no_money_from_a_lost_deal(self):
        B.find(self.d["deals"], "harrow-line")["amount"] = 1000
        with self.assertRaises(B.BoardError):
            S.record(self.d, "harrow-line", 1000, "pi_z", "2026-11-04", live=True)


class Validated(unittest.TestCase):
    def test_the_reels_ending(self):
        v = S.validated(example())
        self.assertTrue(v["validated"])
        text = S.validated_text(v)
        self.assertIn("VALIDATED  3 of 3", text)
        self.assertIn("$54,000.00", text)
        self.assertIn("Marketing spent: $0.00", text)

    def test_not_yet_says_not_yet(self):
        d = before_payment()
        S.record(d, "north-pier", 24000, "pi_x", "2026-11-03", live=True)
        v = S.validated(d)
        self.assertFalse(v["validated"])
        self.assertIn("Don't build yet", S.validated_text(v))

    def test_a_refund_takes_it_back(self):
        d = example()
        S.refund(d, "copperline", "re_x", "2026-12-20")
        self.assertFalse(S.validated(d)["validated"])
        self.assertEqual(B.find(d["deals"], "copperline")["stage"], "refunded")


class Promises(unittest.TestCase):
    def setUp(self):
        self.d = example()

    def test_due_flags_soon_and_late(self):
        rows = {r["deal"]: r["status"] for r in S.due(self.d, B.today_arg("2026-11-05"))}
        self.assertEqual(set(rows.values()), {"OK"})
        rows = {r["deal"]: r["status"] for r in S.due(self.d, B.today_arg("2026-12-04"))}
        self.assertEqual((rows["north-pier"], rows["saltmarsh"], rows["copperline"]), ("LATE", "SOON", "SOON"))
        self.assertIn("delay notice TODAY", S.due_text(self.d, B.today_arg("2026-12-04")))

    def test_the_delay_notice_offers_the_money_back(self):
        n = S.notice(self.d, "copperline", "2026-12-19", "The sync needs two more weeks.")
        self.assertEqual(n["to"], "billing@copperlinehaul.com")
        self.assertIn("refund the full $12,000.00", n["body"])
        self.assertIn("if I don't hear from you", n["body"])

    def test_only_they_can_move_the_date(self):
        with self.assertRaises(B.BoardError):
            S.new_date(self.d, "copperline", "2026-12-19", "No thanks", "2026-11-30")
        S.new_date(self.d, "copperline", "2026-12-19", "Yes that works.", "2026-11-30")
        self.assertEqual(B.find(self.d["deals"], "copperline")["ships_by"], "2026-12-19")
        self.assertEqual(B.validate(self.d)[0], [])

    def test_deliver(self):
        S.deliver(self.d, "north-pier", "2026-12-01")
        self.assertEqual(B.find(self.d["deals"], "north-pier")["stage"], "delivered")
        with self.assertRaises(B.BoardError):
            S.deliver(self.d, "north-pier", "2026-12-01")


if __name__ == "__main__":
    unittest.main()
