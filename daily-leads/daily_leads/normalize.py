"""Turn messy listing data into clean, comparable values."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "puerto rico": "PR",
}

# Pages that belong to a platform, not the business: we don't crawl them.
SOCIAL_HOSTS = {
    "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com",
    "tiktok.com", "youtube.com", "yelp.com", "nextdoor.com", "angi.com",
    "angieslist.com", "homeadvisor.com", "thumbtack.com", "bbb.org", "houzz.com",
    "linktr.ee", "g.page", "goo.gl", "google.com", "maps.app.goo.gl",
}

# Site builders where many unrelated businesses share one host, so the host
# can't identify a business for dedupe. We still crawl them.
SHARED_HOSTS = {
    "business.site", "wixsite.com", "godaddysites.com", "square.site", "weebly.com",
    "sites.google.com", "wordpress.com", "webflow.io", "squarespace.com",
    "mystrikingly.com", "carrd.co", "yolasite.com", "jimdosite.com", "site123.me",
    "ueniweb.com", "hibu.com", "my.canva.site", "netlify.app", "vercel.app",
}

TRACKING_PARAMS = re.compile(r"^(utm_\w+|gclid|fbclid|msclkid|y_source|_ga|mc_\w+|hsa_\w+)$", re.I)


def to_e164(raw: object) -> str:
    """US/Canada number -> +1XXXXXXXXXX, or "" if it isn't one."""
    if not raw:
        return ""
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10 or digits[0] in "01" or digits[3] in "01":
        return ""
    return "+1" + digits


def state_abbrev(value: object) -> str:
    text = str(value or "").strip()
    if len(text) == 2 and text.isalpha():
        return text.upper()
    return US_STATES.get(text.lower(), "")


def host_of(url: str) -> str:
    """Lowercase hostname without a leading www., or ""."""
    if not url:
        return ""
    if "//" not in url:
        url = "http://" + url
    try:
        host = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _on(host: str, suffixes: set[str]) -> bool:
    return any(host == s or host.endswith("." + s) for s in suffixes)


def is_social(url: str) -> bool:
    host = host_of(url)
    return bool(host) and _on(host, SOCIAL_HOSTS)


def dedupe_domain(url: str) -> str:
    """The website's host when it identifies one business, else ""."""
    host = host_of(url)
    if not host or _on(host, SOCIAL_HOSTS) or _on(host, SHARED_HOSTS):
        return ""
    return host


def same_site(a: str, b: str) -> bool:
    return bool(host_of(a)) and host_of(a) == host_of(b)


def clean_website(url: object) -> str:
    """Add a scheme, drop tracking parameters and fragments."""
    text = str(url or "").strip()
    if not text:
        return ""
    if "//" not in text:
        text = "http://" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return ""
    if not parts.hostname:
        return ""
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                       if not TRACKING_PARAMS.match(k)])
    path = parts.path or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))
