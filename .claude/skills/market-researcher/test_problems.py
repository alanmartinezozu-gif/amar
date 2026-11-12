import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_problems_test", os.path.join(HERE, "problems.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
B = P.B


class Problems(unittest.TestCase):
    def setUp(self):
        self.d = B.empty({"name": "A"})

    def test_a_number_needs_a_source_or_a_marked_estimate(self):
        with self.assertRaises(B.BoardError):
            P.add(self.d, "Chasing late invoices", "Freight", 6400)
        with self.assertRaises(B.BoardError):
            P.add(self.d, "Chasing late invoices", "Freight", 6400, estimate=True)
        row = P.add(self.d, "Chasing late invoices", "Freight", 6400, source="https://example.com/pricing")
        self.assertEqual(row["id"], "chasing-late-invoices")
        self.assertEqual(B.validate(self.d)[0], [])

    def test_nobody_pays_is_not_this_kind_of_problem(self):
        with self.assertRaises(B.BoardError):
            P.add(self.d, "Nice to have", "Everyone", 0, source="x")

    def test_sourced_ranks_above_estimated_even_when_smaller(self):
        P.add(self.d, "Big guess", "A", 9000, estimate=True, basis="back of an envelope")
        P.add(self.d, "Small fact", "B", 2000, source="their price page")
        self.assertEqual([p["id"] for p in P.ranked(self.d)], ["small-fact", "big-guess"])
        text = P.rank_text(self.d)
        self.assertIn("estimate: back of an envelope", text)

    def test_small_problems_are_flagged(self):
        P.add(self.d, "Tiny", "C", 200, source="x")
        self.assertIn("probably not a whale", P.rank_text(self.d))

    def test_pick_is_exclusive(self):
        P.add(self.d, "One", "A", 2000, source="x")
        P.add(self.d, "Two", "B", 3000, source="x")
        P.pick(self.d, "one")
        P.pick(self.d, "two")
        self.assertEqual([p["id"] for p in self.d["problems"] if p["picked"]], ["two"])


if __name__ == "__main__":
    unittest.main()
