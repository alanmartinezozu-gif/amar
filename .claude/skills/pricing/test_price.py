import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_price_test", os.path.join(HERE, "price.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
B = P.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


class Price(unittest.TestCase):
    def test_options_come_from_what_they_pay(self):
        rows = P.options(6400)
        self.assertEqual([r["price"] for r in rows], [19000, 26000, 38000])
        self.assertEqual(rows[0]["keep"], 76800 - 19000)

    def test_the_reels_price(self):
        c = P.check(6400, 24000)
        self.assertEqual((c["year"], c["keep"]), (76800, 52800))
        text = P.check_text(c)
        self.assertIn("31% of that", text)
        self.assertIn("A fair place to start", text)

    def test_verdicts(self):
        self.assertIn("as much as", P.check(1000, 12000)["verdict"])
        self.assertIn("High", P.check(1000, 9000)["verdict"])
        self.assertIn("Very low", P.check(1000, 500)["verdict"])

    def test_no_number_no_price(self):
        with self.assertRaises(B.BoardError):
            P.options(0)

    def test_small_prices_round_smaller(self):
        self.assertEqual(P.round_price(1234), 1200)
        self.assertEqual(P.round_price(25600), 26000)

    def test_a_paid_price_does_not_change(self):
        with open(EXAMPLE, encoding="utf-8") as fh:
            d = json.load(fh)
        with self.assertRaises(B.BoardError):
            P.set_price(d, "north-pier", 30000)
        P.set_price(d, "harrow-line", 5000)
        self.assertEqual(B.find(d["deals"], "harrow-line")["amount"], 5000)
        with self.assertRaises(B.BoardError):
            P.set_price(d, "harrow-line", 0)


if __name__ == "__main__":
    unittest.main()
