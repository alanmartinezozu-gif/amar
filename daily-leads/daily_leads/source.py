"""Step 1: find businesses on Google Maps through Outscraper."""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field

from .cache import Cache
from .config import City, Settings
from .models import Lead
from .normalize import clean_website, state_abbrev, to_e164

log = logging.getLogger(__name__)


class FatalSourceError(Exception):
    """Outscraper rejected the key or the account is out of credit."""


@dataclass
class SourceStats:
    places_seen: int = 0
    skipped: Counter = field(default_factory=Counter)
    accepted: int = 0
    exhausted: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    billed_requests: int = 0
    billed_places: int = 0


@dataclass
class _Query:
    trade: str
    city: City
    next_skip: int = 0
    pages: int = 0
    done: bool = False

    @property
    def text(self) -> str:
        return self.city.query(self.trade)


def fetch_places(client, cache: Cache, query: str, skip: int, limit: int) -> tuple[list[dict], bool]:
    """One page of results, from cache when possible. Returns (places, billed)."""
    key = f"{query}|skip={skip}|limit={limit}"
    cached = cache.get("outscraper", key)
    if cached is not None:
        return cached, False
    try:
        result = client.google_maps_search(query, limit=limit, skip=skip, language="en", region="US")
    except Exception as e:  # the SDK raises bare Exception("Response status code: 401")
        if any(code in str(e) for code in ("status code: 401", "status code: 402", "status code: 403")):
            raise FatalSourceError(f"Outscraper refused the request ({e}). Check OUTSCRAPER_API_KEY and your balance.") from e
        raise
    places = result[0] if result and isinstance(result[0], list) else (result or [])
    places = [p for p in places if isinstance(p, dict)]
    cache.set("outscraper", key, places)
    return places, True


def place_to_lead(place: dict, trade: str, city: City) -> tuple[Lead | None, str]:
    """Lead from an Outscraper place, or (None, reason it was skipped)."""
    status = (place.get("business_status") or "OPERATIONAL").upper()
    if status != "OPERATIONAL":
        return None, "closed"
    phone = to_e164(place.get("phone"))
    if not phone:
        return None, "no_phone"
    name = (place.get("name") or "").strip()
    if not name:
        return None, "no_name"
    place_id = (place.get("place_id") or "").strip()
    maps_url = (place.get("location_link") or "").strip()
    if not maps_url and place_id:
        maps_url = f"https://www.google.com/maps/place/?q=place_id:{place_id}"
    address = (place.get("street") or "").strip()
    if not address and place.get("full_address"):
        address = str(place["full_address"]).split(",")[0].strip()
    try:
        reviews = int(place.get("reviews") or 0)
    except (TypeError, ValueError):
        reviews = 0
    try:
        rating = float(place["rating"]) if place.get("rating") is not None else None
    except (TypeError, ValueError):
        rating = None
    lead = Lead(
        name=name,
        phone=phone,
        website=clean_website(place.get("site")),
        address=address,
        city=(place.get("city") or city.name).strip(),
        state=state_abbrev(place.get("us_state") or place.get("state")) or city.state,
        postal_code=str(place.get("postal_code") or "").strip(),
        rating=rating,
        reviews=reviews,
        maps_url=maps_url,
        place_id=place_id,
        trades=[trade],
        market=city,
    )
    return lead, ""


def collect_candidates(client, cache: Cache, settings: Settings, delivered: set[str]) -> tuple[list[Lead], SourceStats]:
    """Page through every trade x city search until we have enough fresh candidates.

    Searches are visited round-robin so every city and trade gets a share.
    Pages already in the cache cost nothing, so on later days the run reads
    the old pages for free and only pays for the next page down.
    """
    target = max(settings.leads_per_day, round(settings.leads_per_day * settings.sourcing.candidate_multiplier))
    size = settings.sourcing.page_size
    queries = [_Query(trade, city) for city in settings.cities for trade in settings.trades]
    stats = SourceStats()
    pool: list[Lead] = []
    by_key: dict[str, Lead] = {}

    while len(pool) < target and any(not q.done for q in queries):
        for q in queries:
            if q.done:
                continue
            try:
                places, billed = fetch_places(client, cache, q.text, q.next_skip, size)
            except FatalSourceError:
                raise
            except Exception as e:
                log.error('Outscraper search "%s" (skip %d) failed: %s', q.text, q.next_skip, e)
                stats.failed.append(q.text)
                q.done = True
                continue
            if billed:
                stats.billed_requests += 1
                stats.billed_places += len(places)
            q.pages += 1
            q.next_skip += size
            if len(places) < size:
                q.done = True
                stats.exhausted.append(q.text)
            elif q.pages >= settings.sourcing.max_pages_per_query:
                q.done = True

            for place in places:
                stats.places_seen += 1
                lead, reason = place_to_lead(place, q.trade, q.city)
                if lead is None:
                    stats.skipped[reason] += 1
                    continue
                if not settings.min_reviews <= lead.reviews <= settings.max_reviews:
                    stats.skipped["review_count_out_of_range"] += 1
                    continue
                keys = lead.keys()
                if keys & delivered:
                    stats.skipped["delivered_on_previous_day"] += 1
                    continue
                seen = next((by_key[k] for k in keys if k in by_key), None)
                if seen is not None:
                    if q.trade not in seen.trades:
                        seen.trades.append(q.trade)
                    stats.skipped["duplicate_in_this_run"] += 1
                    continue
                for k in keys:
                    by_key[k] = lead
                pool.append(lead)
                stats.accepted += 1
            log.info('Searched "%s" page %d: %d places (%s), pool now %d',
                     q.text, q.pages, len(places), "billed" if billed else "cached", len(pool))
    return pool, stats
