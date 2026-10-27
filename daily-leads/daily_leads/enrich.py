"""Step 3: read signals from a lead's public website (home, about, contact)."""

from __future__ import annotations

import json
import logging
import re
import unicodedata
import warnings
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

from bs4 import BeautifulSoup, MarkupResemblesLocatorWarning, XMLParsedAsHTMLWarning

from .fetcher import Fetcher, Page
from .models import Lead
from .normalize import dedupe_domain, host_of, is_social, same_site

log = logging.getLogger(__name__)

# Odd pages (XHTML, near-empty bodies) are still worth reading; don't nag about them.
warnings.filterwarnings("ignore", category=MarkupResemblesLocatorWarning)
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

# ---------------------------------------------------------------------------
# Page discovery
# ---------------------------------------------------------------------------

ABOUT_RE = re.compile(r"about|our[-_ ]?story|our[-_ ]?company|who[-_ ]?we[-_ ]?are|meet[-_ ]?the|our[-_ ]?team|"
                      r"nosotros|quienes[-_ ]?somos|acerca", re.I)
CONTACT_RE = re.compile(r"contact|contacto|cont[aá]ctenos|get[-_ ]?a[-_ ]?quote|free[-_ ]?estimate|"
                        r"request[-_ ]?(?:a[-_ ]?)?(?:quote|estimate|service)|schedule", re.I)
SKIP_EXT_RE = re.compile(r"\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$", re.I)
FALLBACK_PATHS = {"about": "/about-us", "contact": "/contact-us"}


def _same_site_links(page: Page, soup: BeautifulSoup):
    base = page.final_url or page.url
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "sms:", "javascript:", "#")):
            continue
        url = urljoin(base, href).split("#")[0]
        if not same_site(url, base) or SKIP_EXT_RE.search(urlsplit(url).path):
            continue
        yield url, a.get_text(" ", strip=True)


def find_subpages(page: Page, soup: BeautifulSoup) -> dict[str, str]:
    """Best about and contact page URLs linked from the homepage."""
    home_path = urlsplit(page.final_url or page.url).path.rstrip("/")
    best: dict[str, tuple[int, int, str]] = {}
    for url, text in _same_site_links(page, soup):
        path = urlsplit(url).path
        if path.rstrip("/") == home_path:
            continue
        for kind, pattern in (("about", ABOUT_RE), ("contact", CONTACT_RE)):
            score = 2 * bool(pattern.search(text)) + bool(pattern.search(path))
            if score and (kind not in best or (score, -len(path)) > best[kind][:2]):
                best[kind] = (score, -len(path), url)
    return {kind: v[2] for kind, v in best.items()}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

@dataclass
class ParsedPage:
    url: str
    soup: BeautifulSoup
    text: str  # visible text, one line per block
    attrs: str  # href/src/alt/title values, for badges and embeds
    raw_html: str
    json_ld: list = field(default_factory=list)


def parse_page(page: Page) -> ParsedPage:
    soup = BeautifulSoup(page.html, "html.parser")
    json_ld = []
    for tag in soup.find_all("script", type=re.compile("ld\\+json", re.I)):
        try:
            json_ld.append(json.loads(tag.string or ""))
        except (json.JSONDecodeError, TypeError):
            pass
    attrs = " ".join(
        str(v) for tag in soup.find_all(["a", "img", "iframe", "script", "link", "source"])
        for key in ("href", "src", "alt", "title", "data-src") if (v := tag.get(key))
    )
    for tag in soup(["script", "style", "noscript", "svg", "template"]):
        tag.decompose()
    text = soup.get_text("\n")
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.splitlines()]
    text = unicodedata.normalize("NFC", "\n".join(line for line in lines if line))
    return ParsedPage(page.final_url or page.url, BeautifulSoup(page.html, "html.parser"), text, attrs,
                      page.html, json_ld)


def _snippet(text: str, match: re.Match, width: int = 70) -> str:
    start, end = max(0, match.start() - width), min(len(text), match.end() + width)
    return re.sub(r"\s+", " ", text[start:end]).strip()


# ---------------------------------------------------------------------------
# Spanish signal (page content only - never names)
# ---------------------------------------------------------------------------

SPANISH_PHRASES = re.compile(
    r"\bse\s+habla\s+espa[ñn]ol\b|\bhablamos\s+espa[ñn]ol\b|\bhabla(?:mos)?\s+espa[ñn]ol\b|"
    r"\bwe\s+speak\s+spanish\b|\bspanish[\s-]+speaking\s+(?:staff|team|crew|technicians?|reps?|representatives?|available)\b|"
    r"\bbilingual\s*\(?\s*(?:english\s*(?:/|and|&)\s*spanish|spanish\s*(?:/|and|&)\s*english)",
    re.I,
)
SPANISH_LINK_TEXT = re.compile(r"^\s*(?:en\s+)?espa[ñn]ol\s*$|^\s*spanish\s*$|^\s*es\s*$", re.I)
OTHER_LANGUAGE_TEXT = re.compile(
    r"^\s*(?:fran[cç]ais|french|deutsch|german|italiano|italian|portugu[eê]s|portuguese|"
    r"中文|chinese|ti[eế]ng\s+vi[eệ]t|vietnamese|한국어|korean|русский|russian|العربية|arabic|日本語|japanese)\s*$",
    re.I,
)
MACHINE_TRANSLATE_RE = re.compile(r"gtranslate|google_translate_element|translate\.google\.com/translate_a|doGTranslate", re.I)
SPANISH_WORDS = {
    "para", "con", "los", "las", "del", "nuestro", "nuestra", "nuestros", "nuestras", "servicios",
    "usted", "ustedes", "somos", "llame", "llámenos", "gratis", "calidad", "años", "techo", "techos",
    "reparación", "aire", "acondicionado", "calefacción", "empresa", "clientes", "hogar", "trabajo",
    "también", "porque", "cuando", "está", "están", "más", "sus", "una", "por", "que",
}


def _looks_spanish(text: str) -> bool:
    words = re.findall(r"[a-záéíóúñü]+", text.lower())
    if len(words) < 80:
        return False
    hits = sum(w in SPANISH_WORDS for w in words)
    return hits >= 30 and hits / len(words) >= 0.12


def detect_spanish(pages: list[ParsedPage]) -> tuple[bool, str]:
    for p in pages:
        if m := SPANISH_PHRASES.search(p.text):
            return True, f'"{m.group(0)}" on {p.url}'
    for p in pages:
        html_tag = p.soup.find("html")
        lang = (html_tag.get("lang") if html_tag else "") or ""
        if lang.lower().startswith("es") or _looks_spanish(p.text):
            return True, f"page written in Spanish: {p.url}"
    for p in pages:
        if MACHINE_TRANSLATE_RE.search(p.raw_html):
            continue  # a translate widget offers every language; that is not a Spanish page
        hreflangs = {(t.get("hreflang") or "").lower() for t in p.soup.find_all("link", hreflang=True)}
        other_langs = {h.split("-")[0] for h in hreflangs} - {"en", "es", "x"}
        if any(h.startswith("es") for h in hreflangs) and len(other_langs) <= 1:
            return True, f"Spanish version of the site (hreflang) on {p.url}"
        spanish_links, other_links = [], 0
        for a in p.soup.find_all("a", href=True):
            text = a.get_text(" ", strip=True)
            path = urlsplit(urljoin(p.url, a["href"])).path.lower()
            query = parse_qs(urlsplit(a["href"]).query)
            if SPANISH_LINK_TEXT.match(text) or path == "/es" or path.startswith("/es/") \
                    or "es" in [v.lower() for v in query.get("lang", [])]:
                spanish_links.append(a["href"])
            elif OTHER_LANGUAGE_TEXT.match(text):
                other_links += 1
        if spanish_links and other_links <= 1:
            return True, f"links to a Spanish page ({spanish_links[0]}) on {p.url}"
    return False, ""


# ---------------------------------------------------------------------------
# Lead platforms, emergency service, contact form
# ---------------------------------------------------------------------------

# (pattern for visible text, pattern for link/image/badge attributes)
PLATFORMS = {
    "Angi": (re.compile(r"\bangi\b|angie'?s\s*list", re.I),
             re.compile(r"angi\.com|angieslist|\bangi\b", re.I)),
    "HomeAdvisor": (re.compile(r"home\s*advisor", re.I), re.compile(r"home[\s_-]*advisor", re.I)),
    # In attributes "thumbtack" alone is often just a map-pin icon.
    "Thumbtack": (re.compile(r"\bthumbtack\b", re.I),
                  re.compile(r"thumbtack\.com|thumbtack[\s_-]*(?:badge|logo|pro|top|review|award)", re.I)),
    "Google Guaranteed": (re.compile(r"google[\s-]*guarantee", re.I), re.compile(r"google[\s_-]*guarantee", re.I)),
}

EMERGENCY_RE = re.compile(
    r"\b24\s*/\s*7\b|\b24\s*x\s*7\b|\b24[\s-]*hours?\s+(?:a\s+day|emergency|service)|"
    r"\bemergenc(?:y|ies)\b|\bemergencias?\b|around[\s-]+the[\s-]+clock",
    re.I,
)

FORM_EMBED_RE = re.compile(
    r"jotform|typeform|hsforms|hbspt\.forms|gravityforms|gform_|wufoo|formstack|cognitoforms|"
    r"leadconnectorhq\.com/widget/form|msgsndr|servicetitan|housecallpro|getjobber|clienthub|"
    r"forms\.gle|docs\.google\.com/forms|wpforms|ninja-forms|elementor-form|wpcf7",
    re.I,
)


def detect_platforms(pages: list[ParsedPage]) -> tuple[list[str], str]:
    found, evidence = [], []
    for name, (in_text, in_attrs) in PLATFORMS.items():
        for p in pages:
            if in_text.search(p.text) or in_attrs.search(p.attrs):
                found.append(name)
                evidence.append(f"{name} on {p.url}")
                break
    return found, "; ".join(evidence)


def detect_emergency(pages: list[ParsedPage]) -> tuple[bool, str]:
    for p in pages:
        if m := EMERGENCY_RE.search(p.text):
            return True, _snippet(p.text, m)
    return False, ""


def _is_contact_form(form) -> bool:
    if form.get("role") == "search" or "search" in (form.get("action") or "").lower():
        return False
    if form.find("textarea"):
        return True
    fields = set()
    for inp in form.find_all(["input", "select"]):
        kind = (inp.get("type") or "text").lower()
        if kind in ("hidden", "submit", "button", "checkbox", "radio", "image", "reset"):
            continue
        name = " ".join(str(inp.get(k) or "") for k in ("name", "id", "placeholder", "autocomplete")).lower()
        if kind == "email" or "email" in name:
            fields.add("email")
        if kind == "tel" or "phone" in name or "tel" in name:
            fields.add("phone")
        if "name" in name and "user" not in name:
            fields.add("name")
    return len(fields) >= 2


def detect_contact_form(pages: list[ParsedPage]) -> tuple[bool, str]:
    for p in pages:
        if any(_is_contact_form(f) for f in p.soup.find_all("form")):
            return True, f"form on {p.url}"
        if m := FORM_EMBED_RE.search(p.raw_html):
            return True, f"{m.group(0)} form embed on {p.url}"
    return False, ""


# ---------------------------------------------------------------------------
# Owner name
# ---------------------------------------------------------------------------

ROLE = r"(?:co[-\s]?)?(?:owner|founder|president|due[ñn][oa]|propietari[oa]|fundador(?:a)?)"
ROLE_PAIR = rf"{ROLE}(?:\s*(?:&|and|/|y)\s*(?:{ROLE}|ceo|operator))?"
TOKEN = r"[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü'’\-]+"
INITIAL = r"[A-Z]\."
FULL_NAME = rf"{TOKEN}(?:[ \t]+(?:{TOKEN}|{INITIAL})){{1,2}}(?:,?[ \t]+(?:Jr|Sr|II|III|IV)\.?)?"
SEP = r"[ \t]*(?:[,|:(\-–—][ \t]*|\n\s*)"
WORD_RE = re.compile(r"[A-Za-zÁÉÍÓÚÑáéíóúñü]+")


@dataclass(frozen=True)
class OwnerPattern:
    regex: re.Pattern
    allow_first_name_only: bool = False
    check_employer: bool = False  # "Jane Doe, Owner of Some Other Business" is a testimonial


OWNER_PATTERNS = [
    # "John Smith, Owner" / "John Smith\nFounder & President" / "Juan Pérez - Dueño", with the
    # name starting a line or sentence (so "serving Katy, Sugar Land - Owner ..." doesn't count).
    OwnerPattern(re.compile(rf"(?:^|(?<=[.!?:]\s))(?P<name>{FULL_NAME}){SEP}(?:the\s+|our\s+)?(?i:{ROLE_PAIR})\b",
                            re.M), check_employer=True),
    # "Owner: John Smith" / "Founder & CEO, John Smith" / "Meet the owner, Dave Miller" / "Dueño: Juan Pérez"
    OwnerPattern(re.compile(rf"(?i:\b{ROLE_PAIR})[ \t]*(?:[:,\-–—][ \t]*|\n\s*|[ \t]+)(?P<name>{FULL_NAME})\b")),
    # "John Smith is the owner"
    OwnerPattern(re.compile(rf"(?P<name>{FULL_NAME}),?\s+(?i:is|has\s+been|serves\s+as|became)\s+"
                            rf"(?i:the\s+|our\s+)?(?i:proud\s+)?(?i:{ROLE})\b"), check_employer=True),
    # "founded by John Smith" / "owned and operated by John Smith" / "fundada por Juan Pérez"
    OwnerPattern(re.compile(rf"(?i:\b(?:founded|owned(?:\s+and\s+operated)?|started|established)\s+by|"
                            rf"\bfundad[oa]\s+por)\s+(?P<name>{FULL_NAME})\b")),
    # "John Smith founded ABC Roofing"
    OwnerPattern(re.compile(rf"(?P<name>{FULL_NAME})\s+(?i:founded|started)\s+(?:the\s+company|[A-Z])")),
    # "Hi, I'm Mike, owner of ..." - a first name alone is enough here
    OwnerPattern(re.compile(rf"(?i:\bmy\s+name\s+is|\bi'?m|\bi\s+am|\bsoy|\bme\s+llamo)\s+"
                            rf"(?P<name>{TOKEN}(?:[ \t]+{TOKEN})?)(?=[^.\n]{{0,60}}(?i:\b{ROLE}\b))"),
                 allow_first_name_only=True),
]

NOT_A_NAME = set("""
owner owners founder founders president co ceo operator operated owned manager general vice director
dueño dueña dueno duena fundador fundadora presidente propietario propietaria gerente
roofing roof roofs roofer roofers hvac air heating cooling conditioning ac plumbing electric electrical
solar construction contracting contractor contractors exteriors exterior restoration remodeling
services service solutions systems mechanical pros experts company companies inc llc corp ltd group
team family veteran veterans local locally licensed insured certified bonded our the and meet your we us
call free estimate estimates today now best top quality professional professionals customer customers
residential commercial home homes about contact gallery reviews review blog financing careers
texas arizona houston dallas phoenix san antonio fort worth austin north south east west central
sales office project lead senior chief officer operations award awards winner club factory authorized
dealer elite master preferred platinum gold premier select shingle shingles gaf owens corning
certainteed carrier trane lennox rheem goodman american standard copyright rights reserved privacy
policy terms read more learn click here view see get request schedule book hello hi portal login
nuestro nuestra el la los las y de del con para servicio servicios techos
mr mrs ms dr sr jr ii iii iv
""".split())
SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}
FIRST_NAMES = {
    w for line in (Path(__file__).with_name("first_names.txt")).read_text(encoding="utf-8").splitlines()
    if not line.startswith("#") for w in line.split()
}


def _plain(word: str) -> str:
    """Lowercase without accents: "José" -> "jose"."""
    return "".join(c for c in unicodedata.normalize("NFKD", word.lower()) if not unicodedata.combining(c))


def clean_name(raw: str, business_name: str, allow_single: bool = False, known_first: bool = True) -> str:
    """A tidy person's name, or "" if raw doesn't look like one.

    known_first requires the first name to be a common first name, which is
    what keeps "Owner Portal" or a suburb from being taken for a person.
    """
    tokens = [t if re.fullmatch(INITIAL, t) else t.strip(",.;:") for t in raw.split()]
    tokens = [t for t in tokens if t]
    while tokens and tokens[0].lower().rstrip(".") in {"mr", "mrs", "ms", "dr"}:
        tokens = tokens[1:]
    suffix = tokens.pop() if len(tokens) > 2 and tokens[-1].lower().rstrip(".") in SUFFIXES else ""
    if not tokens or len(tokens) > 3 or (len(tokens) < 2 and not allow_single):
        return ""
    words = [t for t in tokens if not re.fullmatch(INITIAL, t)]
    if any(len(w) < 2 or w.lower() in NOT_A_NAME for w in words):
        return ""
    if known_first and _plain(words[0]) not in FIRST_NAMES:
        return ""
    business = {_plain(w) for w in WORD_RE.findall(business_name)}
    if all(_plain(w) in business for w in words):
        return ""
    tokens = [t.title() if t.isupper() and len(t) > 2 else t for t in tokens]
    if suffix:
        tokens.append(suffix.upper().rstrip(".") if suffix.lower().startswith("i") else suffix.title().rstrip(".") + ".")
    return " ".join(tokens)


def _other_employer(after: str, business_name: str) -> bool:
    """True for "..., Owner of Doe's Bakery" when that isn't this business."""
    m = re.match(r"\s*(?:of|at|@)\s+([^\n.,;]{2,60})", after, re.I)
    if not m:
        return False
    org = {_plain(w) for w in WORD_RE.findall(m.group(1))} - NOT_A_NAME - {"s"}
    business = {_plain(w) for w in WORD_RE.findall(business_name)} - NOT_A_NAME
    return bool(org) and not org & business


def _json_ld_founders(data) -> list[str]:
    names = []
    if isinstance(data, list):
        for item in data:
            names += _json_ld_founders(item)
    elif isinstance(data, dict):
        for key in ("founder", "founders"):
            value = data.get(key)
            for person in value if isinstance(value, list) else [value]:
                if isinstance(person, dict) and person.get("name"):
                    names.append(str(person["name"]))
                elif isinstance(person, str):
                    names.append(person)
        for value in data.values():
            if isinstance(value, (dict, list)):
                names += _json_ld_founders(value)
    return names


def find_owner(pages: list[ParsedPage], business_name: str) -> tuple[str, str]:
    """Owner/founder named on the site, or "" - never a guess."""
    found: Counter = Counter()
    evidence: dict[str, str] = {}
    for p in pages:
        for data in p.json_ld:
            for raw in _json_ld_founders(data):
                name = clean_name(raw, business_name, known_first=False)
                if name:
                    found[name] += 3
                    evidence.setdefault(name, f"founder in structured data on {p.url}")
        for pattern in OWNER_PATTERNS:
            for m in pattern.regex.finditer(p.text):
                if pattern.check_employer and _other_employer(p.text[m.end():m.end() + 80], business_name):
                    continue
                name = clean_name(m.group("name"), business_name, allow_single=pattern.allow_first_name_only)
                if name:
                    found[name] += 1
                    evidence.setdefault(name, f'"{_snippet(p.text, m, 30)}" on {p.url}')
    if not found:
        return "", ""
    # A bare first name that matches a full name found elsewhere is the same person.
    full = [n for n in found if " " in n]
    for n in [n for n in found if " " not in n]:
        if any(f.split()[0] == n for f in full):
            found[next(f for f in full if f.split()[0] == n)] += found.pop(n)
    name = found.most_common(1)[0][0]
    return name, evidence[name]


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
FREE_MAIL = {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
             "live.com", "msn.com", "att.net", "sbcglobal.net", "comcast.net", "me.com", "ymail.com"}
JUNK_EMAIL = re.compile(
    r"\.(?:png|jpe?g|gif|webp|svg)$|@(?:sentry|wixpress|sentry-next\.wixpress|example|domain|email|"
    r"yourdomain|godaddy|squarespace|wix)\.|^(?:name|email|your|you|user|test|noreply|no-reply)@",
    re.I,
)
GOOD_MAILBOXES = ("info", "office", "contact", "service", "sales", "admin", "hello", "estimates", "support")


def _decode_cfemail(hex_value: str) -> str:
    try:
        data = bytes.fromhex(hex_value)
        return "".join(chr(b ^ data[0]) for b in data[1:])
    except (ValueError, IndexError):
        return ""


def extract_emails(pages: list[ParsedPage]) -> list[str]:
    emails: list[str] = []
    for p in pages:
        for a in p.soup.find_all("a", href=True):
            if a["href"].lower().startswith("mailto:"):
                emails.append(unquote(a["href"][7:].split("?")[0]))
        for tag in p.soup.find_all(attrs={"data-cfemail": True}):  # Cloudflare-obfuscated
            emails.append(_decode_cfemail(tag["data-cfemail"]))
        for a in p.soup.find_all("a", href=re.compile(r"/cdn-cgi/l/email-protection#")):
            emails.append(_decode_cfemail(a["href"].split("#", 1)[1]))
        emails += EMAIL_RE.findall(p.text)
    seen, result = set(), []
    for e in emails:
        e = e.strip().strip(".").lower()
        if EMAIL_RE.fullmatch(e) and not JUNK_EMAIL.search(e) and e not in seen:
            seen.add(e)
            result.append(e)
    return result


def best_email(emails: list[str], site_url: str, owner_name: str) -> str:
    """The business's own address: on its domain, or a free mailbox it lists."""
    site_host = host_of(site_url)
    on_builder = not dedupe_domain(site_url)  # wixsite.com etc.: own domain unknown
    first = owner_name.split()[0].lower() if owner_name else ""

    def on_site(email: str) -> bool:
        domain = email.split("@", 1)[1]
        return bool(site_host) and (site_host == domain or site_host.endswith("." + domain))

    # An address on some other company's domain is usually the web designer's.
    usable = [e for e in emails if on_site(e) or e.split("@", 1)[1] in FREE_MAIL or on_builder]
    if not usable:
        return ""
    return max(usable, key=lambda e: (on_site(e), bool(first) and first in e.split("@")[0],
                                      e.split("@")[0] in GOOD_MAILBOXES))


# ---------------------------------------------------------------------------
# Putting it together
# ---------------------------------------------------------------------------

def enrich_lead(lead: Lead, fetcher: Fetcher) -> None:
    """Fill the lead's website signals in place. Leaves defaults if there is no site."""
    if not lead.website or is_social(lead.website):
        return
    home = fetcher.fetch(lead.website)
    if not home.ok:
        lead.enrich_error = f"homepage: {home.error or 'empty page'}"
        return
    pages = [parse_page(home)]
    targets = find_subpages(home, pages[0].soup)
    base = home.final_url or home.url
    for kind in ("about", "contact"):
        url = targets.get(kind) or urljoin(base, FALLBACK_PATHS[kind])
        if any(p.url.rstrip("/") == url.rstrip("/") for p in pages):
            continue
        page = fetcher.fetch(url)
        if page.ok:
            pages.append(parse_page(page))
    lead.pages_fetched = len(pages)

    lead.owner_name, owner_ev = find_owner(pages, lead.name)
    lead.spanish_signal, spanish_ev = detect_spanish(pages)
    lead.lead_platforms, platform_ev = detect_platforms(pages)
    lead.emergency_service, emergency_ev = detect_emergency(pages)
    lead.has_contact_form, form_ev = detect_contact_form(pages)
    lead.email = best_email(extract_emails(pages), base, lead.owner_name)
    lead.email_source = "website" if lead.email else ""
    lead.evidence = {k: v for k, v in {
        "owner": owner_ev, "spanish": spanish_ev, "platforms": platform_ev,
        "emergency": emergency_ev, "contact_form": form_ev,
    }.items() if v}
