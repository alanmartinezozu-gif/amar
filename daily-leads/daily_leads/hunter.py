"""Hunter.io domain search: the fallback when a site lists no email."""

from __future__ import annotations

import logging
import re

import requests

from .cache import Cache

log = logging.getLogger(__name__)

URL = "https://api.hunter.io/v2/domain-search"
OWNER_ROLE = re.compile(r"owner|founder|president|ceo|principal", re.I)


class HunterAuthError(Exception):
    pass


def domain_search(session: requests.Session, cache: Cache, api_key: str, domain: str) -> list[dict]:
    cached = cache.get("hunter", domain)
    if cached is not None:
        return cached
    resp = session.get(URL, params={"domain": domain, "limit": 10}, headers={"X-API-KEY": api_key}, timeout=20)
    if resp.status_code == 401:
        raise HunterAuthError("Hunter rejected HUNTER_API_KEY (401)")
    if resp.status_code == 429:
        raise HunterAuthError("Hunter rate limit or monthly quota reached (429)")
    resp.raise_for_status()
    emails = (resp.json().get("data") or {}).get("emails") or []
    cache.set("hunter", domain, emails)
    return emails


def pick_email(emails: list[dict], owner_name: str, min_confidence: int) -> str:
    """Owner's address if Hunter has it, else the most confident business address."""
    first = owner_name.split()[0].lower() if owner_name else ""

    def rank(e: dict):
        is_owner = bool(OWNER_ROLE.search(e.get("position") or "")) or (e.get("seniority") == "executive")
        name_match = bool(first) and first == (e.get("first_name") or "").lower()
        return (is_owner or name_match, e.get("type") == "generic", e.get("confidence") or 0)

    usable = [
        e for e in emails
        if e.get("value") and (e.get("confidence") or 0) >= min_confidence
        and ((e.get("verification") or {}).get("status") or "") != "invalid"
    ]
    return max(usable, key=rank)["value"].lower() if usable else ""
