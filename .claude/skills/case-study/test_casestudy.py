import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_casestudy_test", os.path.join(HERE, "casestudy.py"))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)
B = C.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def delivered():
    with open(EXAMPLE, encoding="utf-8") as fh:
        d = json.load(fh)
    deal = B.find(d["deals"], "north-pier")
    deal.update(stage="delivered", delivered_on="2026-12-01")
    return d


class CaseStudy(unittest.TestCase):
    ARGS = ("Paid $6,400 a month", "Cancelled the service", "North Pier's own numbers")

    def setUp(self):
        self.d = delivered()

    def test_proof_comes_after_delivery(self):
        with self.assertRaises(B.BoardError):
            C.draft(self.d, "saltmarsh", *self.ARGS)

    def test_needs_before_after_and_where_the_numbers_came_from(self):
        with self.assertRaises(B.BoardError):
            C.draft(self.d, "north-pier", "before", "after", "")

    def test_a_quote_needs_a_real_name(self):
        with self.assertRaises(B.BoardError):
            C.draft(self.d, "north-pier", *self.ARGS, quote="Great stuff")

    def test_stays_a_draft_until_approved(self):
        C.draft(self.d, "north-pier", *self.ARGS, quote="We stopped thinking about it.", quote_by="Renee Alvarez, CFO")
        self.assertEqual(C.problems(self.d, "north-pier"), ["not approved by the customer in writing"])
        with self.assertRaises(B.BoardError):
            C.approve(self.d, "north-pier", "Not interested.", "2027-02-10")
        C.approve(self.d, "north-pier", "Approved, go ahead.", "2027-02-10")
        self.assertEqual(C.problems(self.d, "north-pier"), [])
        self.assertEqual(B.validate(self.d)[0], [])

    def test_they_approved_the_words_not_the_idea(self):
        C.draft(self.d, "north-pier", *self.ARGS)
        C.approve(self.d, "north-pier", "Approved.", "2027-02-10")
        C.study_for(self.d, "north-pier")["after"] = "Saved a million dollars"
        self.assertIn("the text changed after they approved it: ask again", C.problems(self.d, "north-pier"))
        C.draft(self.d, "north-pier", *self.ARGS)
        self.assertIn("not approved by the customer in writing", C.problems(self.d, "north-pier"))

    def test_no_draft(self):
        self.assertEqual(C.problems(self.d, "saltmarsh"), ["no draft yet"])


if __name__ == "__main__":
    unittest.main()
