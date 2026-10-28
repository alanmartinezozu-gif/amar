"""Offline tests for enrich.py and wyoming.py: every website is a canned page.

    python3 -m unittest discover -s prospecting
"""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich, wyoming  # noqa: E402

META_PIXEL = """<script>!function(f,b,e,v,n,t,s){n=f.fbq=function(){};t=b.createElement(e);
t.src=v}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '123456789012345');</script>"""

WEB = {
    # WordPress roofer: Meta Pixel, Contact Form 7 on /contact-us, owner on /about-us
    "http://summitroofing.example": ("http://summitroofing.example/", f"""<html><head>{META_PIXEL}</head>
        <body><nav><a href="/contact-us">Get a Free Estimate</a> <a href="/about-us">About Us</a>
        <a href="/blog">Blog</a> <a href="tel:3075550101">Call</a></nav>
        <form role="search" action="/"><input name="s" type="text"></form>
        <h1>Summit Roofing</h1><p>Family Owned and Operated Since 1998</p></body></html>"""),
    "http://summitroofing.example/contact-us": ("http://summitroofing.example/contact-us", """
        <form class="wpcf7-form" action="/contact-us#wpcf7"><input type="hidden" name="_wpcf7">
        <input name="your-name"><input type="email" name="your-email"><input type="tel" name="phone">
        <textarea name="your-message"></textarea><input type="submit"></form>"""),
    "http://summitroofing.example/about-us": ("http://summitroofing.example/about-us", """
        <h2>Meet the Team</h2><div class="card"><h3>Mike Johnson</h3><p>Owner</p></div>
        <div class="card"><h3>Sarah Lee</h3><p>Office Manager</p></div>"""),

    # Google Ads only inside a GTM container, form only through a Housecall Pro booking button
    "https://casperhvac.example": ("https://casperhvac.example/", """<head><script>
        (function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC1234');</script></head>
        <body><a href="https://book.housecallpro.com/book/Casper-HVAC/abc">Book online</a>
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"HVACBusiness",
        "name":"Casper HVAC","founder":{"@type":"Person","name":"Dale Whitaker"}}</script></body>"""),
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234": ("", """var data = {"resource":
        {"tags":[{"function":"__awct","vtp_conversionId":"987654321"}]}};"""),

    # No ads, only a newsletter signup; owner's name only on the Google listing
    "http://laramieplumbing.example": ("http://laramieplumbing.example/", """<body>
        <p>Owner Operated Business Serving Laramie</p>
        <form class="newsletter-signup"><input type="email" name="email"></form></body>"""),

    # Wix site: no form in the HTML, but Wix renders forms in the browser
    "http://wixbuilder.example": ("http://wixbuilder.example/", """<body>
        <img src="https://static.wixstatic.com/media/logo.png"><p>Free estimates</p></body>"""),
}


def fake_fetch(url, timeout=12):
    return WEB.get(url.rstrip("/"), ("", ""))


def kit_row(**kw):
    row = {"title": "", "category": "Roofing contractor", "address": "", "phone": "", "emails": "",
           "website": "", "review_rating": "4.800000", "review_count": "10", "link": "", "place_id": "",
           "owner": "", "complete_address": ""}
    row.update(kw)
    return row


class EnrichTest(unittest.TestCase):
    def setUp(self):
        self.real_fetch, enrich.fetch = enrich.fetch, fake_fetch
        enrich.tag_container.cache_clear()

    def tearDown(self):
        enrich.fetch = self.real_fetch

    def test_pixel_contact_form_and_owner_from_team_page(self):
        r = enrich.check_site("summitroofing.example", "Summit Roofing")
        self.assertEqual(r["runs_ads"], "likely")
        self.assertEqual(r["ad_signals"], "Meta Pixel")
        self.assertEqual(r["has_form"], "yes")
        self.assertEqual(r["form_details"], "Contact Form 7 on /contact-us")  # the search box is not a lead form
        self.assertEqual(r["owner_name"], "Mike Johnson")
        self.assertEqual(r["owner_source"], "website /about-us")
        self.assertIn("Mike Johnson Owner", r["owner_evidence"])

    def test_google_ads_inside_gtm_booking_widget_and_schema_founder(self):
        r = enrich.check_site("https://casperhvac.example", "Casper HVAC")
        self.assertEqual(r["runs_ads"], "likely")
        self.assertEqual(r["ad_signals"], "Google Ads tag (via GTM-ABC1234)")
        self.assertEqual(r["has_form"], "yes")
        self.assertEqual(r["form_details"], "Housecall Pro booking on homepage")
        self.assertEqual((r["owner_name"], r["owner_source"]), ("Dale Whitaker", "website schema"))

    def test_newsletter_is_not_a_lead_form_and_listing_owner_fallback(self):
        rows = [kit_row(title="Laramie Plumbing", website="http://laramieplumbing.example",
                        owner='{"id":"1","name":"Tom Becker","link":""}')]
        lead = enrich.enrich(rows)[0]
        self.assertEqual((lead["runs_ads"], lead["has_form"]), ("no signs", "no"))
        self.assertEqual((lead["owner_name"], lead["owner_source"]), ("Tom Becker", "Google Maps listing owner"))

    def test_js_site_builder_and_missing_sites_stay_unknown(self):
        self.assertEqual(enrich.check_site("http://wixbuilder.example")["has_form"], "unknown")
        dead = enrich.check_site("http://gone.example")
        self.assertEqual((dead["runs_ads"], dead["has_form"]), ("unknown", "unknown"))
        self.assertEqual(enrich.check_site("")["runs_ads"], "unknown")

    def test_unreadable_tag_container_is_a_maybe(self):
        WEB["http://gtmonly.example"] = ("http://gtmonly.example/", "<script>'GTM-ZZZ9999'</script>")
        try:
            r = enrich.check_site("http://gtmonly.example")
        finally:
            del WEB["http://gtmonly.example"]
        self.assertEqual(r["runs_ads"], "maybe")

    def test_ads_and_form_prospects_sort_first(self):
        rows = [kit_row(title="Laramie Plumbing", website="http://laramieplumbing.example", review_count="500"),
                kit_row(title="Summit Roofing", website="http://summitroofing.example")]
        self.assertEqual([l["name"] for l in enrich.enrich(rows)], ["Summit Roofing", "Laramie Plumbing"])


class OwnerNameTest(unittest.TestCase):
    def name(self, text, business=""):
        hit = enrich.owner_in_text(text, business)
        return hit[0] if hit else None

    def test_common_phrasings(self):
        self.assertEqual(self.name("Hi! Meet Jake O'Brien, owner of Peak Electric."), "Jake O'Brien")
        self.assertEqual(self.name("Owner: Maria Lopez | Cheyenne, WY"), "Maria Lopez")
        self.assertEqual(self.name("Founded in 2004 by Chris McAllister and his wife."), "Chris McAllister")
        self.assertEqual(self.name("Owned and operated by Ben Carter since 2010"), "Ben Carter")
        self.assertEqual(self.name("Gary Hall is the proud owner of Hall Concrete"), "Gary Hall")

    def test_rejects_slogans_and_company_names(self):
        self.assertIsNone(self.name("Locally Owned and Operated. Owner Operated Business Since 1998"))
        self.assertIsNone(self.name("Contact Summit Roofing Today. Owner Approved Quality"))
        self.assertIsNone(self.name("Big Horn Builders, owner", business="Big Horn Builders"))
        self.assertIsNone(self.name("Homeowners love our free estimates"))


class WyomingTest(unittest.TestCase):
    def test_keeps_wyoming_contractors_only(self):
        wy = '{"city":"Casper","state":"WY"}'
        cases = [
            (kit_row(complete_address=wy), True),
            (kit_row(complete_address='{"city":"Fort Collins","state":"CO"}'), False),
            (kit_row(address="123 Main St, Casper, WY 82601"), True),
            (kit_row(address="9 Elm St, Fort Collins, CO 80521"), False),
            (kit_row(phone="+1 307-555-0101"), True),  # service-area business, no address
            (kit_row(phone="+1 970-555-0101"), False),
        ]
        for row, expected in cases:
            self.assertEqual(wyoming.in_wyoming(row), expected, row)
        self.assertTrue(wyoming.NOT_CONTRACTORS.search("Roofing supply store"))
        self.assertFalse(wyoming.NOT_CONTRACTORS.search("Roofing contractor"))


if __name__ == "__main__":
    unittest.main()
