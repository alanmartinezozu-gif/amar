import pytest

from daily_leads.cache import Cache
from daily_leads.config import City
from daily_leads.source import FatalSourceError, collect_candidates, place_to_lead

from .conftest import FakeOutscraper, place


def roofers(n, start=0):
    return [place(f"Roofer {i}", f"713555{i:04d}", f"https://roofer{i}.com", 50) for i in range(start, start + n)]


def test_place_to_lead_maps_fields():
    lead, _ = place_to_lead(place("Bayou Roofing", "+1 713-555-0142", "https://bayou.com/?utm_source=gmb", 57),
                            "roofing", City("Houston", "TX"))
    assert (lead.phone, lead.website, lead.state, lead.postal_code) == (
        "+17135550142", "https://bayou.com/", "TX", "77002")
    assert lead.maps_url.startswith("https://www.google.com/maps/")


@pytest.mark.parametrize("override, reason", [
    ({"business_status": "CLOSED_PERMANENTLY"}, "closed"),
    ({"phone": None}, "no_phone"),
])
def test_place_skips(override, reason):
    p = {**place("X", "7135550142", "", 50), **override}
    assert place_to_lead(p, "roofing", City("Houston", "TX")) == (None, reason)


def test_review_range_and_dedupe(settings, tmp_path):
    places = [
        place("Too New", "7135550001", "https://new.com", 9),
        place("Just Right", "7135550002", "https://right.com", 10),
        place("Franchise", "7135550003", "https://big.com", 301),
        place("Right Again (2nd listing)", "7135550099", "https://www.right.com/katy", 40),
        place("Delivered Yesterday", "7135550004", "https://old.com", 80),
    ]
    client = FakeOutscraper({"roofing in Houston, TX": places})
    pool, stats = collect_candidates(client, Cache(tmp_path / "c.db", {}), settings, {"phone:+17135550004"})
    assert [l.name for l in pool] == ["Just Right"]
    assert stats.skipped["review_count_out_of_range"] == 2
    assert stats.skipped["duplicate_in_this_run"] == 1
    assert stats.skipped["delivered_on_previous_day"] == 1


def test_same_business_in_two_trades_is_merged(settings, tmp_path):
    settings.trades = ["roofing", "HVAC"]
    shared = place("Both Trades Co", "7135550005", "https://both.com", 50)
    client = FakeOutscraper({"roofing in Houston, TX": [shared], "HVAC in Houston, TX": [shared]})
    pool, _ = collect_candidates(client, Cache(tmp_path / "c.db", {}), settings, set())
    assert len(pool) == 1 and pool[0].trades == ["roofing", "HVAC"]


def test_pages_until_enough_and_cache_avoids_rebilling(settings, tmp_path):
    settings.leads_per_day = 20  # target pool = 60
    settings.sourcing.page_size = 40
    client = FakeOutscraper({"roofing in Houston, TX": roofers(100)})
    cache = Cache(tmp_path / "c.db", {"outscraper": 30})
    pool, stats = collect_candidates(client, cache, settings, set())
    assert len(pool) == 80 and stats.billed_requests == 2
    assert [c[1] for c in client.calls] == [0, 40]

    # Next day: the first 80 were delivered. Cached pages are reread for free,
    # and only the next page down is bought.
    delivered = set().union(*(l.keys() for l in pool))
    pool2, stats2 = collect_candidates(client, cache, settings, delivered)
    assert [c[1] for c in client.calls] == [0, 40, 80]
    assert stats2.billed_requests == 1 and len(pool2) == 20
    assert "roofing in Houston, TX" in stats2.exhausted


def test_bad_key_stops_the_run(settings, tmp_path):
    class Broken:
        def google_maps_search(self, *a, **kw):
            raise Exception("Response status code: 401")

    with pytest.raises(FatalSourceError):
        collect_candidates(Broken(), Cache(tmp_path / "c.db", {}), settings, set())


def test_one_failed_search_does_not_stop_others(settings, tmp_path):
    settings.cities = [City("Houston", "TX"), City("Dallas", "TX")]

    class Flaky(FakeOutscraper):
        def google_maps_search(self, query, **kw):
            if "Houston" in query:
                raise Exception("Response status code: 500")
            return super().google_maps_search(query, **kw)

    pool, stats = collect_candidates(Flaky({"roofing in Dallas, TX": roofers(3)}), Cache(tmp_path / "c.db", {}),
                                     settings, set())
    assert len(pool) == 3 and stats.failed == ["roofing in Houston, TX"]
