import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_launch_test", os.path.join(HERE, "launch.py"))
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)
B = L.B
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def example():
    with open(EXAMPLE, encoding="utf-8") as fh:
        return json.load(fh)


def day(s):
    return B.today_arg(s)


class Plan(unittest.TestCase):
    def test_runs_backwards_from_the_first_promise(self):
        rows = L.plan(example(), day("2026-11-05"))
        self.assertEqual(rows[0]["on"].isoformat(), "2026-11-08")
        ship = next(r for r in rows if r["step"] == "Ship to the first customer")
        self.assertEqual(ship["on"].isoformat(), "2026-12-03")
        self.assertIn("Ship to Copperline Haul", [r["step"] for r in rows])
        self.assertEqual(rows[-1]["on"].isoformat(), "2026-12-19")
        self.assertIn("Public launch", rows[-1]["step"])

    def test_a_date_already_gone_says_so(self):
        text = L.plan_text(example(), day("2026-11-10"))
        self.assertIn("date already passed", text)

    def test_nothing_to_plan_before_the_money(self):
        d = example()
        d["payments"] = []
        for deal in d["deals"]:
            if deal["stage"] == "paid":
                deal.update(stage="offer-sent", ships_by=None)
        with self.assertRaises(B.BoardError):
            L.plan(d, day("2026-11-05"))

    def test_status(self):
        text = L.status_text(example(), day("2026-12-04"))
        self.assertIn("Features: 0 of 4 built", text)
        self.assertIn("LATE", text)


class Gate(unittest.TestCase):
    def test_closed_until_it_is_really_ready(self):
        d = example()
        ok, reasons = L.gate(d, day("2026-11-05"))
        self.assertFalse(ok)
        self.assertIn("No customer has the product yet.", reasons)

    def test_late_customers_keep_it_closed(self):
        d = example()
        B.find(d["deals"], "north-pier")["stage"] = "delivered"
        ok, reasons = L.gate(d, day("2026-12-10"))
        self.assertFalse(ok)
        self.assertTrue(any("Saltmarsh Freight is late" in r for r in reasons))

    def test_opens_when_everyone_is_looked_after(self):
        d = example()
        for deal in d["deals"]:
            if deal["stage"] == "paid":
                deal["stage"] = "delivered"
        for r in d["requirements"]:
            r["done"] = True
        self.assertEqual(L.gate(d, day("2026-12-19")), (True, []))


if __name__ == "__main__":
    unittest.main()
