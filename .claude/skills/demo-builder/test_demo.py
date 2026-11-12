import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_demo_test", os.path.join(HERE, "demo.py"))
D = importlib.util.module_from_spec(spec)
spec.loader.exec_module(D)
EXAMPLE = D.load_spec(os.path.join(HERE, "demo.example.json"))


class Demo(unittest.TestCase):
    def test_example_is_the_reels_demo(self):
        self.assertEqual(D.check(EXAMPLE), [])
        self.assertEqual(D.total(EXAMPLE), 48210)

    def test_every_page_says_it_is_a_demo(self):
        page = D.build(EXAMPLE)
        self.assertIn(D.BANNER, page)
        self.assertIn("Chase all", page)
        self.assertIn("Fennel &amp; Co. Produce", page)

    def test_runs_with_no_network(self):
        page = D.build(EXAMPLE)
        self.assertNotIn("http://", page)
        self.assertNotIn("https://", page)
        self.assertNotIn("<link", page)
        self.assertNotIn("src=", page)

    def test_spec_text_cannot_break_out_of_the_page(self):
        spec = dict(EXAMPLE, title="<script>alert(1)</script>", statuses=["</script><script>alert(2)</script>"])
        page = D.build(spec)
        self.assertNotIn("<script>alert", page)

    def test_real_data_is_refused(self):
        spec = dict(EXAMPLE, sample_data=False)
        self.assertTrue(any("sample_data" in p for p in D.check(spec)))
        with self.assertRaises(D.DemoError):
            D.build(spec)

    def test_bad_specs(self):
        self.assertTrue(D.check(dict(EXAMPLE, rows=EXAMPLE["rows"][:1])))
        self.assertTrue(D.check(dict(EXAMPLE, statuses=[])))
        self.assertTrue(D.check(dict(EXAMPLE, accent="red;}body{display:none")))
        row = dict(EXAMPLE["rows"][0], amount="lots")
        self.assertTrue(D.check(dict(EXAMPLE, rows=[row] + EXAMPLE["rows"][1:])))


if __name__ == "__main__":
    unittest.main()
