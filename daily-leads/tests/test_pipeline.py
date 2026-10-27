"""End-to-end run with every outside service faked."""

import csv

from daily_leads import history
from daily_leads.config import City
from daily_leads.export import GHL_COLUMNS
from daily_leads.models import Lead
from daily_leads.pipeline import Clients, run

from .conftest import FakeClaude, FakeOutscraper, FakeResponse, FakeWeb, fixture, place

QUERY = "roofing in Houston, TX"


def world():
    places = [
        place("Alamo Roof Pros", "(713) 555-0101", "https://alamoroofpros.com/", 57, rating=4.8),
        place("Bayou Roofing Co.", "(713) 555-0102", "https://bayouroofing.com/", 150, rating=4.6),
        place("Desert Air HVAC", "(713) 555-0103", "https://desertairhvac.com/", 15, rating=4.9),
        place("Facebook Only Roofing", "(713) 555-0104", "https://www.facebook.com/fbroofing", 30, rating=4.9),
        place("Broken Site Roofing", "(713) 555-0105", "https://brokenroof.com/", 25, rating=4.5),
        place("Mega Franchise", "(713) 555-0106", "https://mega.com/", 2400),
        place("Called Last Week", "(713) 555-0107", "https://lastweek.com/", 40),
        place("No Phone Roofing", "", "https://nophone.com/", 40),
    ]
    web = FakeWeb(
        routes={
            "https://alamoroofpros.com/": FakeResponse(200, fixture("alamo_home.html")),
            "https://alamoroofpros.com/about-us/": FakeResponse(200, fixture("alamo_about.html")),
            "https://alamoroofpros.com/contact/": FakeResponse(200, fixture("alamo_contact.html")),
            "https://bayouroofing.com/": FakeResponse(200, fixture("bayou_home.html")),
            "https://bayouroofing.com/our-team/": FakeResponse(200, fixture("bayou_team.html")),
            "https://desertairhvac.com/robots.txt": FakeResponse(
                200, "User-agent: *\nDisallow: /contact-us\n", {"Content-Type": "text/plain"}),
            "https://desertairhvac.com/": FakeResponse(200, fixture("desert_home.html")),
            "https://brokenroof.com/": FakeResponse(500, "error"),
        },
        hunter={"bayouroofing.com": [
            {"value": "info@bayouroofing.com", "type": "generic", "confidence": 92},
            {"value": "john@bayouroofing.com", "type": "personal", "confidence": 95, "first_name": "John",
             "position": "Owner"},
            {"value": "guess@bayouroofing.com", "type": "personal", "confidence": 20},
        ]},
    )
    return Clients(outscraper=FakeOutscraper({QUERY: places}), http=web, claude=FakeClaude())


def read_csv(path):
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


def seed_history(settings):
    old = Lead("Called Last Week", "+17135550107", "https://lastweek.com/", "", "Houston", "TX", "", 4.5, 40,
               "", "", ["roofing"], City("Houston", "TX"))
    history.record(settings.history_file, "2026-10-20", [old])


def test_full_run(settings):
    settings.leads_per_day = 4
    seed_history(settings)
    clients = world()
    result = run(settings, "2026-10-27", clients)

    header, rows = read_csv(result.csv_path)
    assert result.csv_path.name == "ghl_import_2026-10-27.csv"
    assert header == GHL_COLUMNS
    assert [r["Company Name"] for r in rows] == [
        "Alamo Roof Pros", "Bayou Roofing Co.", "Desert Air HVAC", "Facebook Only Roofing"]

    alamo, bayou, desert, fb = rows
    assert (alamo["First Name"], alamo["Last Name"]) == ("Carlos", "Ramirez")
    assert alamo["Phone"] == "+17135550101"
    assert alamo["Email"] == "office@alamoroofpros.com"
    assert alamo["Tags"] == "prospect,roofing,houston,spanish"
    assert (alamo["Lead Score"], alamo["Spanish Signal"], alamo["Lead Platforms"]) == ("10", "yes", "HomeAdvisor")
    assert alamo["DM Text"].startswith("Hola Carlos, ¿")
    assert alamo["Missed Call Text"] and alamo["Call Note"]
    assert alamo["Google Maps URL"].startswith("https://www.google.com/maps/")

    assert (bayou["First Name"], bayou["Last Name"]) == ("John", "Smith")
    assert bayou["Email"] == "john@bayouroofing.com"  # from Hunter: the site has none
    assert (bayou["Lead Score"], bayou["Spanish Signal"]) == ("8", "yes")
    assert bayou["Lead Platforms"] == "Angi, Thumbtack"

    assert (desert["First Name"], desert["Spanish Signal"], desert["Lead Score"]) == ("", "no", "2")
    assert desert["Email"] == "info@desertairhvac.com"
    assert desert["Tags"] == "prospect,roofing,houston"
    assert desert["DM Text"].startswith("Hey, who calls")

    assert fb["Website"] == "https://www.facebook.com/fbroofing" and fb["Lead Score"] == "1"

    web = clients.http
    assert "https://desertairhvac.com/contact-us" not in web.calls  # robots.txt said no
    assert not any("facebook.com" in c for c in web.calls)
    assert [c for c in web.calls if c.startswith("hunter:")] == ["hunter:bayouroofing.com"]

    summary = result.summary_path.read_text()
    assert "**4 leads**" in summary
    assert "| With owner name | 2 (50%) |" in summary
    assert "| Spanish signal | 2 (50%) |" in summary
    assert "| roofing | 4 |" in summary and "| Houston, TX | 4 |" in summary
    assert "| 10 | 1 |" in summary and "| 8 | 1 |" in summary
    assert "already delivered on a previous day: 1" in summary
    assert "review count outside range: 1" in summary

    rows = history._read(settings.history_file)
    assert sorted(r["date"] for r in rows) == ["2026-10-20"] + ["2026-10-27"] * 4


def test_same_day_rerun_is_free_and_identical(settings):
    settings.leads_per_day = 4
    clients = world()
    first = run(settings, "2026-10-27", clients)
    claude_calls, web_calls, maps_calls = len(clients.claude.calls), len(clients.http.calls), len(clients.outscraper.calls)

    second = run(settings, "2026-10-27", clients)
    assert read_csv(first.csv_path) == read_csv(second.csv_path)
    assert len(clients.claude.calls) == claude_calls
    assert len(clients.outscraper.calls) == maps_calls
    # Pages, robots.txt, Hunter and even today's failed site all come from cache.
    assert clients.http.calls[web_calls:] == []
    assert len(history._read(settings.history_file)) == 4


def test_next_day_never_repeats_a_business(settings):
    settings.leads_per_day = 4
    clients = world()
    day1 = run(settings, "2026-10-27", clients)
    day2 = run(settings, "2026-10-28", clients)
    names1 = {r["Company Name"] for r in read_csv(day1.csv_path)[1]}
    names2 = {r["Company Name"] for r in read_csv(day2.csv_path)[1]}
    assert names2 == {"Broken Site Roofing", "Called Last Week"} and not names1 & names2
    assert "Only 2 of 4 leads found" in day2.summary_path.read_text()


def test_dry_run_leaves_history_alone(settings):
    run(settings, "2026-10-27", world(), record_history=False)
    assert not settings.history_file.exists()
