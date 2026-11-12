import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_hunter_test", os.path.join(HERE, "hunter.py"))
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)
B = H.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def fresh():
    """The example, wound back to before North Pier was pitched."""
    with open(EXAMPLE, encoding="utf-8") as fh:
        d = json.load(fh)
    for key in ("activities", "payments", "requirements"):
        d[key] = []
    for deal in d["deals"]:
        deal.update(stage="found", ships_by=None, paid_on=None, lost_reason=None)
    return d


class Hunter(unittest.TestCase):
    def setUp(self):
        self.d = fresh()

    def test_who_decides_comes_in_order(self):
        order = [p["name"] for p in H.people_at(self.d, "north-pier")]
        self.assertEqual(order, ["Renee Alvarez", "Tom Whitlock", "Priya Nair"])
        self.assertIn("signs the check", H.who_text(self.d, "north-pier"))

    def test_the_pitch_is_the_one_in_the_reel(self):
        p = H.draft(self.d, "north-pier", demo="https://yourproduct.example/demo")
        self.assertEqual(p["to"], "renee@northpierlogistics.com")
        self.assertIn("North Pier pays about $6,400 a month to chase late invoices.", p["body"])
        self.assertIn("Can I show you in 2 minutes?", p["body"])
        self.assertEqual(p["missing"], [])

    def test_every_pitch_carries_the_legal_footer(self):
        body = H.draft(self.d, "north-pier")["body"]
        self.assertIn(self.d["me"]["address"], body)
        self.assertIn('Reply "stop"', body)

    def test_a_missing_demo_link_is_asked_for_not_invented(self):
        self.assertEqual(H.draft(self.d, "north-pier")["missing"], ["link to the demo"])

    def test_without_their_own_number_it_uses_the_market_one(self):
        B.find(self.d["companies"], "north-pier").update(spend_month=None, spend_source=None)
        body = H.draft(self.d, "north-pier", demo="x")["body"]
        self.assertIn("Freight companies often pay about $6,400 a month", body)
        self.assertNotIn("North Pier pays", body)

    def test_record_needs_an_explicit_yes(self):
        for reply in ("ok", "sure", "yes to all"):
            with self.assertRaises(B.BoardError):
                H.record(self.d, "north-pier", "body", "subject", reply, "2026-10-26T09:04")
        self.assertEqual(self.d["activities"], [])
        H.record(self.d, "north-pier", "body", "subject", "yes", "2026-10-26T09:04")
        self.assertEqual(B.find(self.d["deals"], "north-pier")["stage"], "pitched")
        self.assertEqual(self.d["activities"][0]["approval"], "yes")

    def test_never_twice(self):
        H.record(self.d, "north-pier", "body", "subject", "yes", "2026-10-26T09:04")
        with self.assertRaises(B.BoardError):
            H.draft(self.d, "north-pier", demo="x")

    def test_do_not_contact_and_suppression(self):
        B.find(self.d["people"], "renee-alvarez")["do_not_contact"] = True
        with self.assertRaises(B.BoardError):
            H.draft(self.d, "north-pier", demo="x")
        self.d = fresh()
        self.d["suppression"].append("RENEE@northpierlogistics.com")
        with self.assertRaises(B.BoardError):
            H.record(self.d, "north-pier", "body", "subject", "yes", "2026-10-26T09:04")

    def test_no_email_means_no_guessing(self):
        with self.assertRaises(B.BoardError):
            H.draft(self.d, "north-pier", demo="x", person_id="tom-whitlock")

    def test_one_person_at_a_company_at_a_time(self):
        H.record(self.d, "north-pier", "body", "subject", "yes", "2026-10-26T09:04")
        self.d["deals"].append({"id": "north-pier-2", "company_id": "north-pier", "person_id": "tom-whitlock", "stage": "found", "amount": 0, "next_step": "x"})
        B.find(self.d["people"], "tom-whitlock").update(email="tom@northpierlogistics.com", email_source="their site")
        with self.assertRaises(B.BoardError):
            H.draft(self.d, "north-pier-2", demo="x")

    def test_daily_limit(self):
        H.MAX_PITCHES_A_DAY, keep = 1, H.MAX_PITCHES_A_DAY
        try:
            H.record(self.d, "north-pier", "body", "subject", "yes", "2026-10-26T09:04")
            with self.assertRaises(B.BoardError):
                H.record(self.d, "saltmarsh", "body", "subject", "yes", "2026-10-26T09:10")
        finally:
            H.MAX_PITCHES_A_DAY = keep


if __name__ == "__main__":
    unittest.main()
