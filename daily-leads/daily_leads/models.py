from __future__ import annotations

from dataclasses import dataclass, field

from .config import City
from .normalize import dedupe_domain


@dataclass
class Lead:
    name: str
    phone: str  # E.164
    website: str
    address: str
    city: str
    state: str
    postal_code: str
    rating: float | None
    reviews: int
    maps_url: str
    place_id: str
    trades: list[str]
    market: City  # the city we searched, used for tags

    # Filled in by enrichment (public website pages only).
    pages_fetched: int = 0
    owner_name: str = ""
    spanish_signal: bool = False
    lead_platforms: list[str] = field(default_factory=list)
    emergency_service: bool = False
    has_contact_form: bool = False
    email: str = ""
    email_source: str = ""  # "website" or "hunter"
    evidence: dict[str, str] = field(default_factory=dict)
    enrich_error: str = ""

    score: int = 0

    # Written by Claude.
    call_note: str = ""
    dm_text: str = ""
    missed_call_text: str = ""
    outreach_error: str = ""

    @property
    def trade(self) -> str:
        return self.trades[0]

    @property
    def domain(self) -> str:
        return dedupe_domain(self.website)

    def keys(self) -> set[str]:
        """Identifiers that mark the same business across runs."""
        keys = {"phone:" + self.phone}
        if self.domain:
            keys.add("domain:" + self.domain)
        if self.place_id:
            keys.add("place:" + self.place_id)
        return keys
