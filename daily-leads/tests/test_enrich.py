import pytest

from daily_leads.enrich import (
    best_email, detect_contact_form, detect_emergency, detect_platforms, detect_spanish,
    extract_emails, find_owner, find_subpages, parse_page,
)
from daily_leads.fetcher import Page

from .conftest import fixture


def pages(*items):
    """parse_page for (url, html) pairs."""
    return [parse_page(Page(url, url, 200, html)) for url, html in items]


def body(text: str) -> str:
    return f"<html><body>{text}</body></html>"


# --- owner name -----------------------------------------------------------

@pytest.mark.parametrize("html, expected", [
    ("<p>John Smith, Owner</p>", "John Smith"),
    ("<h3>Maria Gonzalez</h3><p>Founder &amp; President</p>", "Maria Gonzalez"),
    ("<p>Owner: Mike O'Brien</p>", "Mike O'Brien"),
    ("<p>Meet the owner, Dave Miller.</p>", "Dave Miller"),
    ("<p>The company was founded by Robert Lee Jackson in 1987.</p>", "Robert Lee Jackson"),
    ("<p>Tom Baker is the owner of Lone Star Roofing.</p>", "Tom Baker"),
    ("<p>Ask for owner Steve Harris.</p>", "Steve Harris"),
    ("<p>José Martínez, Owner of Lone Star Roofing</p>", "José Martínez"),
    ("<p>Mr. Rick Davis Jr.</p><p>Owner</p>", "Rick Davis Jr."),
    ("<p>Hi, I'm Mike, owner of Lone Star Roofing.</p>", "Mike"),
    ("<p>Juan Pérez - Dueño</p>", "Juan Pérez"),
    ("<p>Dueño: Juan Pérez</p>", "Juan Pérez"),
    ("<p>Fundada por Ana Torres en 2005.</p>", "Ana Torres"),
    ("<h4>JOHN SMITH</h4><span>OWNER</span>", "John Smith"),
])
def test_owner_found(html, expected):
    assert find_owner(pages(("https://x.com/about", body(html))), "Lone Star Roofing")[0] == expected


@pytest.mark.parametrize("html", [
    "<p>Family Owned and Operated since 1990.</p>",
    "<p>Veteran Owned Business</p>",
    "<p>Locally owned. Call the owner today!</p>",
    "<p>Owner Operated Roofing Company</p>",
    "<p>GAF Master Elite, Owner's Choice warranty</p>",
    "<p>Carrier President's Award winner</p>",
    "<p>Lone Star Roofing, owner of the best reviews in Houston</p>",
    "<p>Owned by the Garcia family.</p>",
    "<p>Contact Us - Owner Portal</p>",
    "<p>Owner Portal Login</p>",
    "<p>Proudly serving Katy, Sugar Land - Owner on every job</p>",
    "<p>Great job on our roof!</p><p>Jane Doe, Owner of Doe's Bakery</p>",
    "<p>Hi, I'm Zorblat, owner.</p>",
])
def test_owner_not_guessed(html):
    assert find_owner(pages(("https://x.com/about", body(html))), "Lone Star Roofing")[0] == ""


def test_owner_from_structured_data_and_team_card():
    ps = pages(("https://bayouroofing.com/", fixture("bayou_home.html")),
               ("https://bayouroofing.com/our-team/", fixture("bayou_team.html")))
    name, evidence = find_owner(ps, "Bayou Roofing Co.")
    assert name == "John A. Smith"
    assert "bayouroofing.com" in evidence


def test_owner_ignores_other_staff():
    ps = pages(("https://x.com/team", body("<p>Sales Manager: Lisa Wong</p><p>Office Manager, Amy Chu</p>")))
    assert find_owner(ps, "X Roofing")[0] == ""


# --- Spanish --------------------------------------------------------------

def test_spanish_phrase():
    ok, evidence = detect_spanish(pages(("https://a.com/", fixture("alamo_home.html"))))
    assert ok and "Se Habla Español" in evidence


@pytest.mark.parametrize("html", [
    "<p>Hablamos espanol</p>",
    "<p>We speak Spanish!</p>",
    "<p>Bilingual (English/Spanish) crew</p>",
    '<a href="/es/">Español</a>',
])
def test_spanish_variants(html):
    assert detect_spanish(pages(("https://a.com/", body(html))))[0]


def test_spanish_hreflang():
    assert detect_spanish(pages(("https://bayouroofing.com/", fixture("bayou_home.html"))))[0]


def test_spanish_written_page():
    assert detect_spanish(pages(("https://garza.com/", fixture("spanish_page.html"))))[0]


def test_translate_widget_is_not_spanish():
    assert not detect_spanish(pages(("https://desertairhvac.com/", fixture("desert_home.html"))))[0]


@pytest.mark.parametrize("html", [
    "<p>Spanish tile roof repair and clay tile replacement.</p>",
    "<p>Garcia &amp; Hernandez Roofing - owner Jose Garcia</p>",
    "<p>Los Angeles style homes. Mesa, Tempe, Chandler.</p>",
])
def test_spanish_never_from_names_or_roof_types(html):
    assert not detect_spanish(pages(("https://a.com/", body(html))))[0]


# --- platforms, emergency, forms -------------------------------------------

def test_platforms_from_text_and_badges():
    found, _ = detect_platforms(pages(("https://a.com/", fixture("alamo_home.html")),
                                      ("https://b.com/", fixture("bayou_home.html")),
                                      ("https://c.com/", fixture("desert_home.html"))))
    assert found == ["Angi", "HomeAdvisor", "Thumbtack", "Google Guaranteed"]


def test_no_platforms():
    html = body('<p>Angela\'s roofing angles</p><img src="/icons/thumbtack.svg" alt="Our location">')
    assert detect_platforms(pages(("https://a.com/", html)))[0] == []


@pytest.mark.parametrize("html, expected", [
    ("<p>24/7 Emergency Roof Repair</p>", True),
    ("<p>Available 24 hours a day</p>", True),
    ("<p>Emergency service available</p>", True),
    ("<p>Servicio de emergencia</p>", True),
    ("<p>We reply within 24 hours.</p>", False),
    ("<p>Roof replacement and repair.</p>", False),
])
def test_emergency(html, expected):
    assert detect_emergency(pages(("https://a.com/", body(html))))[0] is expected


def test_contact_form_detection():
    assert detect_contact_form(pages(("https://a.com/contact", fixture("alamo_contact.html"))))[0]
    assert detect_contact_form(pages(("https://b.com/", fixture("bayou_home.html"))))[0]  # HubSpot embed
    assert not detect_contact_form(pages(("https://c.com/", fixture("desert_home.html"))))[0]  # search only
    newsletter = ('<form><input type="hidden" name="form_name" value="newsletter">'
                  '<input type="email" name="email"><button>Subscribe</button></form>')
    assert not detect_contact_form(pages(("https://d.com/", body(newsletter))))[0]


# --- email ------------------------------------------------------------------

def test_cloudflare_email_decoded():
    emails = extract_emails(pages(("https://alamoroofpros.com/", fixture("alamo_home.html"))))
    assert emails == ["office@alamoroofpros.com"]


def test_web_designer_email_rejected():
    ps = pages(("https://desertairhvac.com/", fixture("desert_home.html")))
    emails = extract_emails(ps)
    assert "hello@pixelcraftdesign.com" in emails
    assert best_email(emails, "https://desertairhvac.com/", "") == "info@desertairhvac.com"


def test_email_prefers_owner_then_site_domain():
    emails = ["bayouroofing@gmail.com", "info@bayouroofing.com", "john@bayouroofing.com"]
    assert best_email(emails, "https://www.bayouroofing.com/", "John Smith") == "john@bayouroofing.com"
    assert best_email(emails, "https://www.bayouroofing.com/", "") == "info@bayouroofing.com"
    assert best_email(["crew@gmail.com"], "https://bayouroofing.com/", "") == "crew@gmail.com"


def test_junk_emails_dropped():
    html = body("<p>logo@2x.png user@example.com abc@sentry.wixpress.com real@roofco.com</p>")
    assert extract_emails(pages(("https://roofco.com/", html))) == ["real@roofco.com"]


# --- page discovery ---------------------------------------------------------

def test_find_subpages():
    home = Page("https://alamoroofpros.com/", "https://alamoroofpros.com/", 200, fixture("alamo_home.html"))
    parsed = parse_page(home)
    assert find_subpages(home, parsed.soup) == {
        "about": "https://alamoroofpros.com/about-us/",
        "contact": "https://alamoroofpros.com/contact/",
    }
