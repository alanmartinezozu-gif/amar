"""Offline fakes for Outscraper, websites, Hunter and Claude."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import requests

from daily_leads.config import City, Crawler, Settings
from daily_leads.outreach import OutreachCopy

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeResponse:
    def __init__(self, status=200, body="", headers=None, json_data=None):
        self.status_code = status
        self.headers = {"Content-Type": "text/html; charset=utf-8", **(headers or {})}
        self._body = body.encode("utf-8") if isinstance(body, str) else body
        self._json = json_data
        self.encoding = "utf-8"

    @property
    def text(self):
        return self._body.decode("utf-8")

    def iter_content(self, size):
        for i in range(0, len(self._body), size):
            yield self._body[i:i + size]

    def json(self):
        return self._json if self._json is not None else json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def close(self):
        pass


class FakeWeb:
    """requests.Session stand-in. routes: url -> FakeResponse | Exception."""

    def __init__(self, routes=None, hunter=None):
        self.routes = dict(routes or {})
        self.hunter = hunter or {}
        self.calls: list[str] = []

    def get(self, url, params=None, headers=None, timeout=None, allow_redirects=True, stream=False):
        if url.startswith("https://api.hunter.io/"):
            self.calls.append(f"hunter:{params['domain']}")
            assert headers.get("X-API-KEY"), "Hunter key must go in a header"
            return FakeResponse(200, json_data={"data": {"emails": self.hunter.get(params["domain"], [])}})
        self.calls.append(url)
        route = self.routes.get(url)
        if route is None and urlsplit(url).path == "/robots.txt":
            return FakeResponse(404, "")
        if route is None:
            return FakeResponse(404, "<html><body>Not found</body></html>")
        if isinstance(route, Exception):
            raise route
        return route


class FakeOutscraper:
    """Serves places per query in pages, like google_maps_search(skip=, limit=)."""

    def __init__(self, places_by_query: dict[str, list[dict]]):
        self.places_by_query = places_by_query
        self.calls: list[tuple[str, int, int]] = []

    def google_maps_search(self, query, limit=20, skip=0, language="en", region=None, **kw):
        self.calls.append((query, skip, limit))
        return [self.places_by_query.get(query, [])[skip:skip + limit]]


class FakeClaude:
    """client.beta.messages.parse stand-in that writes rule-abiding copy."""

    def __init__(self, bad_first: int = 0, refuse: bool = False):
        self.bad_first = bad_first
        self.refuse = refuse
        self.calls: list[dict] = []
        self.beta = self
        self.messages = self

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        prompt = kwargs["messages"][0]["content"]
        facts = json.loads(prompt[prompt.index("{"):prompt.rindex("}") + 1])

        class R:
            stop_details = None

        r = R()
        if self.refuse:
            r.stop_reason, r.parsed_output = "refusal", None
            return r
        r.stop_reason = "end_turn"
        name = facts["owner_first_name"]
        if facts["spanish_signal"]:
            dm = (f"Hola{' ' + name if name else ''}, ¿quién le regresa la llamada a sus clientes cuando usted "
                  f"está en un trabajo? Yo hago que cada cliente reciba llamada en 60 segundos. ¿Le enseño en 15 minutos?")
            missed = ("Le acabo de llamar, seguro estaba en un trabajo. Eso es justo lo que resuelvo: cada cliente "
                      "recibe llamada en 60 segundos y queda agendado. ¿Cuándo le queda bien platicar?")
        else:
            dm = (f"Hey{' ' + name if name else ''}, who calls your customers back when you're up on a job? "
                  "I make sure every lead gets a call in 60 seconds and booked. Worth a quick 15-min look?")
            missed = ("Just tried calling - you were probably on a job. That's exactly what I fix: every lead "
                      "called back in 60 seconds and booked on your calendar. When's a good time to talk?")
        if len(self.calls) <= self.bad_first:
            dm = "Who calls your leads back? Our AI does it in 60 seconds. See www.example.com"
        r.parsed_output = OutreachCopy(
            call_note=f"{facts['google_review_count']} Google reviews; mention fast callbacks.",
            dm_text=dm,
            missed_call_text=missed,
        )
        return r


def place(name, phone, site, reviews, city="Houston", state="Texas", zip_code="77002", rating=4.7, **extra):
    slug = re.sub(r"\W+", "", name.lower())
    return {
        "name": name, "phone": phone, "site": site, "reviews": reviews, "rating": rating,
        "street": f"{len(name)} Main St", "city": city, "us_state": state, "postal_code": zip_code,
        "full_address": f"{len(name)} Main St, {city}, TX {zip_code}",
        "place_id": f"ChIJ{slug}", "location_link": f"https://www.google.com/maps/place/?q=place_id:ChIJ{slug}",
        "business_status": "OPERATIONAL", **extra,
    }


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        trades=["roofing"],
        cities=[City("Houston", "TX")],
        leads_per_day=10,
        crawler=Crawler(delay_seconds=0, timeout_seconds=1, concurrency=4),
        base_dir=tmp_path,
        history_file=tmp_path / "leads_history.csv",
        output_dir=tmp_path / "output",
        log_dir=tmp_path / "logs",
        outscraper_api_key="test",
        hunter_api_key="test",
        anthropic_api_key="test",
    )
