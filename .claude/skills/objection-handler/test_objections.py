import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_objections_test", os.path.join(HERE, "objections.py"))
O = importlib.util.module_from_spec(spec)
spec.loader.exec_module(O)
EXAMPLE = os.path.join(HERE, "..", "market-researcher", "whale.example.json")


def example():
    with open(EXAMPLE, encoding="utf-8") as fh:
        return json.load(fh)


class Match(unittest.TestCase):
    def test_each_objection(self):
        for text, key in (("It looks great, but it's too expensive for us right now.", "price"),
                          ("So it isn't built yet?", "not-built"),
                          ("What if you never ship it?", "trust"),
                          ("Why would we pay up front?", "up-front"),
                          ("We're in our busy season, come back later.", "timing"),
                          ("Let me sleep on it.", "think"),
                          ("I'd have to run this by our CFO.", "authority"),
                          ("We already have a collections service.", "vendor"),
                          ("Do you have any case studies?", "proof")):
            self.assertEqual(O.match(text)["key"], key, text)

    def test_a_no_beats_everything_and_gets_no_answer(self):
        for text in ("Too expensive, not interested.", "We're all set, thanks.", "Please stop emailing me."):
            card = O.match(text)
            self.assertEqual(card["key"], "no", text)
            self.assertIsNone(card["say"])

    def test_unknown_gets_a_question_not_a_guess(self):
        card = O.match("The weather is nice today.")
        self.assertEqual(card["key"], "none")
        self.assertIsNone(card["say"])

    def test_answers_come_from_your_own_terms(self):
        d = example()
        card = O.match("So it isn't built yet?", d, "north-pier")
        self.assertIn("not finished yet", card["say"])
        self.assertIn("within 30 days", card["say"])
        self.assertIn("every dollar back", card["say"])
        self.assertEqual(card["missing"], [])
        self.assertIn("$6,400 a month", O.match("That's too expensive.", d, "north-pier")["say"])

    def test_without_a_board_it_asks_instead_of_inventing(self):
        card = O.match("So it isn't built yet?")
        self.assertIn("[fill:", card["say"])
        self.assertTrue(card["missing"])

    def test_no_proof_is_ever_made_up(self):
        say = O.load_cards()["proof"]["say"].lower()
        self.assertIn("one of the first", say)
        self.assertNotIn("customers love", say)


if __name__ == "__main__":
    unittest.main()
