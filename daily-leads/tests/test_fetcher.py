import requests

from daily_leads.cache import Cache
from daily_leads.config import Crawler
from daily_leads.fetcher import Fetcher

from .conftest import FakeResponse, FakeWeb


def make(tmp_path, routes):
    web = FakeWeb(routes)
    cache = Cache(tmp_path / "c.sqlite3", {"page": 14})
    return Fetcher(web, cache, Crawler(delay_seconds=0)), web


def test_robots_disallow_is_respected(tmp_path):
    fetcher, web = make(tmp_path, {
        "https://a.com/robots.txt": FakeResponse(200, "User-agent: *\nDisallow: /contact\n",
                                                 {"Content-Type": "text/plain"}),
        "https://a.com/": FakeResponse(200, "<p>home</p>"),
        "https://a.com/contact": FakeResponse(200, "<p>secret</p>"),
    })
    assert fetcher.fetch("https://a.com/").ok
    page = fetcher.fetch("https://a.com/contact")
    assert not page.ok and "robots.txt" in page.error
    assert "https://a.com/contact" not in web.calls


def test_robots_rules_for_our_bot(tmp_path):
    fetcher, _ = make(tmp_path, {
        "https://a.com/robots.txt": FakeResponse(200, "User-agent: daily-leads\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
                                                 {"Content-Type": "text/plain"}),
        "https://a.com/": FakeResponse(200, "<p>home</p>"),
    })
    assert "robots.txt" in fetcher.fetch("https://a.com/").error


def test_unreachable_robots_means_keep_out(tmp_path):
    fetcher, web = make(tmp_path, {
        "https://down.com/robots.txt": FakeResponse(503, "busy"),
        "https://down.com/": FakeResponse(200, "<p>home</p>"),
    })
    assert not fetcher.fetch("https://down.com/").ok
    assert "https://down.com/" not in web.calls


def test_redirect_checks_robots_on_new_host(tmp_path):
    fetcher, web = make(tmp_path, {
        "http://a.com/": FakeResponse(301, "", {"Location": "https://www.a.com/"}),
        "https://www.a.com/robots.txt": FakeResponse(200, "User-agent: *\nDisallow: /\n", {"Content-Type": "text/plain"}),
        "https://www.a.com/": FakeResponse(200, "<p>home</p>"),
    })
    assert "robots.txt" in fetcher.fetch("http://a.com/").error
    assert "https://www.a.com/" not in web.calls


def test_pages_are_cached(tmp_path):
    fetcher, web = make(tmp_path, {"https://a.com/": FakeResponse(200, "<p>home</p>")})
    fetcher.fetch("https://a.com/")
    fetcher.fetch("https://a.com/")
    assert web.calls.count("https://a.com/") == 1


def test_errors_become_page_errors(tmp_path):
    fetcher, _ = make(tmp_path, {
        "https://slow.com/": requests.Timeout("timed out"),
        "https://pdf.com/": FakeResponse(200, "%PDF", {"Content-Type": "application/pdf"}),
        "https://err.com/": FakeResponse(500, "oops"),
    })
    assert "Timeout" in fetcher.fetch("https://slow.com/").error
    assert "not a web page" in fetcher.fetch("https://pdf.com/").error
    assert fetcher.fetch("https://err.com/").error == "HTTP 500"


def test_crawl_delay_is_honored(tmp_path, monkeypatch):
    slept = []
    monkeypatch.setattr("daily_leads.fetcher.time.sleep", lambda s: slept.append(s))
    fetcher, _ = make(tmp_path, {
        "https://a.com/robots.txt": FakeResponse(200, "User-agent: *\nCrawl-delay: 5\n", {"Content-Type": "text/plain"}),
        "https://a.com/": FakeResponse(200, "<p>home</p>"),
        "https://a.com/about": FakeResponse(200, "<p>about</p>"),
    })
    fetcher.fetch("https://a.com/")
    fetcher.fetch("https://a.com/about")
    assert slept and max(slept) > 4
