#!/usr/bin/env python3
"""Website checks for contractor leads: owner name, ad tracking and lead forms.

Takes a Google Maps Scraper Kit CSV (scrape with --full so the `owner`, `link` and
`complete_address` columns come through), visits each business website and writes a lead sheet
with these extra columns:

  owner_name, owner_source, owner_evidence   who owns the business, and where that came from
  runs_ads, ad_signals                       likely | maybe | no signs | unknown, plus the tags found
  has_form, form_details                     yes | no | unknown, plus where the form lives

"runs_ads = likely" means ad tracking is installed (Meta Pixel, Google Ads tag, call tracking...).
That is how businesses that pay for ads measure them, but it does not prove a campaign is live
today. Confirm in the Meta Ad Library or the Google Ads Transparency Center before you pitch.

Standard library only, like the kit.

    python3 enrich.py results.csv leads.csv
"""
import argparse, csv, json, re, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from html.parser import HTMLParser

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

LEAD_FIELDS = ["name", "category", "city", "address", "phone", "emails", "website",
               "owner_name", "owner_source", "owner_evidence", "runs_ads", "ad_signals",
               "has_form", "form_details", "rating", "reviews", "google_maps_url", "place_id"]


# ── Fetching ───────────────────────────────────────────────────────────────────

def fetch(url, timeout=12):
    """GET a page -> (final url, text), or ("", "") on any failure: dead small-business sites are common."""
    try:
        r = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.8"})
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body, charset = resp.read(1_500_000), resp.headers.get_content_charset() or "utf-8"
            final = resp.geturl()
    except Exception:
        return "", ""
    try:
        return final, body.decode(charset, "replace")
    except LookupError:  # a bogus charset in the header
        return final, body.decode("utf-8", "replace")


@lru_cache(maxsize=4096)
def tag_container(tag_id):
    """Script of a Google Tag Manager container or Google tag. Ad tags set up inside a container
    never appear in the page HTML, so the container itself has to be read. None if unreachable."""
    path = "gtm.js" if tag_id.startswith("GTM-") else "gtag/js"
    _, js = fetch(f"https://www.googletagmanager.com/{path}?id={tag_id}")
    return js or None


# ── Page parsing ───────────────────────────────────────────────────────────────

class Page(HTMLParser):
    """One pass over a page: visible text, links, JSON-LD blocks and the fields of each <form>."""
    HIDDEN = {"script", "style", "noscript", "svg", "template"}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.text, self.links, self.jsonld, self.forms = [], [], [], []
        self._hidden, self._ld, self._form, self._a = 0, None, None, None
        self.feed(html)
        self.close()
        self._end_form()
        self.text = re.sub(r"\s+", " ", " ".join(self.text)).strip()

    def handle_starttag(self, tag, attrs):
        a = {k: v or "" for k, v in attrs}
        if tag in self.HIDDEN:
            self._hidden += 1
            if tag == "script" and "ld+json" in a.get("type", "").lower():
                self._ld = []
            return
        if tag == "a" and a.get("href"):
            self._a = (a["href"], [])
        elif tag == "form":
            self._end_form()  # unclosed previous form
            self._form = {"attrs": " ".join([a.get("id", ""), a.get("class", ""), a.get("action", ""),
                                             a.get("name", ""), a.get("role", "")]).lower(),
                          "fields": [], "textarea": False, "password": False}
        elif self._form is not None and tag in ("input", "textarea", "select"):
            kind = "textarea" if tag == "textarea" else (a.get("type") or "text").lower()
            if kind == "password":
                self._form["password"] = True
            if kind in ("hidden", "submit", "button", "image", "reset"):
                return
            self._form["textarea"] |= kind == "textarea"
            label = " ".join([a.get("name", ""), a.get("id", ""), a.get("placeholder", ""),
                              a.get("aria-label", "")]).lower()
            self._form["fields"].append((kind, label))

    def handle_endtag(self, tag):
        if tag in self.HIDDEN:
            self._hidden = max(0, self._hidden - 1)
            if tag == "script" and self._ld is not None:
                self.jsonld.append("".join(self._ld))
                self._ld = None
        elif tag == "a" and self._a:
            self.links.append((self._a[0], " ".join(self._a[1])))
            self._a = None
        elif tag == "form":
            self._end_form()

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
        elif not self._hidden:
            self.text.append(data)
            if self._a:
                self._a[1].append(data)

    def _end_form(self):
        if self._form is not None:
            self.forms.append(self._form)
            self._form = None


# ── Ads ────────────────────────────────────────────────────────────────────────

AD_TAGS = [  # matched against page HTML
    ("Meta Pixel", re.compile(r"fbevents\.js|facebook\.com/tr[?/]|\bfbq\(", re.I)),
    ("Google Ads tag", re.compile(r"\bAW-\d{6,12}\b|googleadservices\.com/pagead/conversion"
                                  r"|googleads\.g\.doubleclick\.net/pagead", re.I)),
    ("Microsoft Ads UET", re.compile(r"bat\.bing\.com/bat\.js", re.I)),
    ("TikTok Pixel", re.compile(r"analytics\.tiktok\.com", re.I)),
    ("Nextdoor Pixel", re.compile(r"ads\.nextdoor\.com", re.I)),
    ("CallRail call tracking", re.compile(r"cdn\.callrail\.com", re.I)),
    ("CallTrackingMetrics", re.compile(r"\.tctm\.co/|calltrackingmetrics\.com", re.I)),
]
CONTAINER_TAGS = [  # matched against GTM / Google tag scripts, which carry library code too
    ("Google Ads tag", re.compile(r'"function":"__(?:awct|sp)"|\bAW-\d{6,12}\b')),
    ("Meta Pixel", re.compile(r"fbevents\.js|facebook\.com\\?/tr")),
    ("Microsoft Ads UET", re.compile(r'"function":"__baut"|bat\.bing\.com')),
    ("TikTok Pixel", re.compile(r"analytics\.tiktok\.com")),
]
GTM_RE = re.compile(r"\b(GTM-[A-Z0-9]{4,10})\b")
GTAG_RE = re.compile(r"googletagmanager\.com/gtag/js\?id=(G-[A-Z0-9]{4,12})")


def ad_signals(html):
    """Ad tags on a page, including ones loaded through a tag container -> (names, unread containers)."""
    found = [name for name, rx in AD_TAGS if rx.search(html)]
    unread = []
    for tag_id in sorted(set(GTM_RE.findall(html)) | set(GTAG_RE.findall(html))):
        js = tag_container(tag_id)
        if js is None:
            unread.append(tag_id)
            continue
        found += [f"{name} (via {tag_id})" for name, rx in CONTAINER_TAGS
                  if rx.search(js) and not any(f.startswith(name) for f in found)]
    return found, unread


# ── Forms ──────────────────────────────────────────────────────────────────────

FORM_PLUGINS = [  # class/id fragments of common WordPress and site-builder form plugins
    ("Contact Form 7", "wpcf7"), ("Gravity Forms", "gform"), ("WPForms", "wpforms"),
    ("Elementor form", "elementor-form"), ("Ninja Forms", "nf-form"), ("Formidable", "frm_form"),
    ("Fluent Forms", "fluentform"), ("Forminator", "forminator"), ("HubSpot form", "hs-form"),
]
FORM_EMBEDS = [  # hosted forms and booking widgets, found in the raw HTML
    ("Jotform", r"jotform\.(?:com|us)"), ("Typeform", r"typeform\.com/to/|embed\.typeform\.com"),
    ("HubSpot form", r"js\.hsforms\.net|hbspt\.forms\.create"), ("Google Form", r"docs\.google\.com/forms"),
    ("Formstack", r"formstack\.com/forms"), ("Cognito Forms", r"cognitoforms\.com"),
    ("123FormBuilder", r"123formbuilder\.com"), ("Zoho Forms", r"forms\.zohopublic\.com"),
    ("Wufoo", r"wufoo\.com/(?:forms|embed)"), ("Squarespace form", r"sqs-block-form|\bform-block\b"),
    ("GoHighLevel form", r"leadconnectorhq\.com/widget/(?:form|survey|booking)|link\.msgsndr\.com"),
    ("Housecall Pro booking", r"online-booking\.housecallpro\.com|book\.housecallpro\.com"),
    ("Jobber request form", r"clienthub\.getjobber\.com"),
    ("ServiceTitan scheduler", r"scheduler\.servicetitan"), ("Calendly booking", r"calendly\.com/[a-z0-9]"),
]
FORM_EMBEDS = [(name, re.compile(rx, re.I)) for name, rx in FORM_EMBEDS]
JS_BUILDERS = re.compile(r"static\.wixstatic\.com|img1\.wsimg\.com", re.I)  # forms render in the browser only
LEAD_HINT = re.compile(r"contact|quote|estimate|request|inquiry|enquiry|appointment|booking|lead")
NEWSLETTER_HINT = re.compile(r"newsletter|subscribe|mc-embedded|mailchimp|klaviyo")
SEARCH_FIELD = re.compile(r"(?:^|\s)(?:s|q|search|query|keyword)(?:\s|$)")


def lead_form(f):
    """Name of a <form> that collects a lead, or None for search boxes, logins and newsletter signups."""
    fields = f["fields"]
    if f["password"] or not fields or "search" in f["attrs"]:
        return None
    labels = " ".join(label for _, label in fields)
    if len(fields) <= 2 and SEARCH_FIELD.search(labels):
        return None
    contact = any(kind in ("email", "tel") for kind, _ in fields) or re.search(r"e-?mail|phone", labels)
    plugin = next((name for name, frag in FORM_PLUGINS if frag in f["attrs"]), None)
    if not (f["textarea"] or plugin or LEAD_HINT.search(f["attrs"]) or (contact and len(fields) >= 2)):
        return None
    if not f["textarea"] and len(fields) <= 2 and NEWSLETTER_HINT.search(f["attrs"] + labels):
        return None
    return plugin or "web form"


def forms_on(page, html):
    """Lead forms on one page: its own <form>s, then embedded form and booking widgets."""
    found = [name for name in (lead_form(f) for f in page.forms) if name]
    found += [name for name, rx in FORM_EMBEDS if rx.search(html) and name not in found]
    return list(dict.fromkeys(found))


# ── Owner name ─────────────────────────────────────────────────────────────────

NAME_WORD = r"(?:Mc|Mac|O')?[A-Z][a-z]+(?:-[A-Z][a-z]+)?"
NAME = rf"{NAME_WORD}(?:\s[A-Z]\.)?(?:\s{NAME_WORD}){{1,3}}"
TITLE = r"(?i:co-?owners?|owners?(?:\s*(?:/|&|and)\s*operators?)?|co-?founders?|founders?|president|ceo|proprietor)"
OWNER_PATTERNS = [
    re.compile(rf"(?P<name>{NAME})\s*(?:[,\-–—|:(]\s*)?(?:is\s+)?(?:the\s+)?(?:proud\s+)?{TITLE}\b"),
    re.compile(rf"\b{TITLE}\s*(?:[,\-–—|:]\s*|\s)(?P<name>{NAME})"),
    re.compile(rf"(?i:owned\s*(?:and|&)\s*operated\s+by|(?:founded|started|established)\s+(?:in\s+\d{{4}}\s+)?by"
               rf"|run\s+by)\s+(?P<name>{NAME})"),
]
# Capitalized words that show up next to "Owner" on contractor sites but are not names.
STOP = set("""
the our we us you your my meet hi hello call contact free home about team staff today local family
owned operated business company co inc llc ltd corp group since years year experience veteran
roofing roof roofs construction contractor contractors contracting services service solutions pros
pro professional quality custom plumbing plumber heating cooling air electric electrical electrician
hvac remodeling remodel builders building builds homes concrete painting landscaping excavation
exteriors interiors windows doors siding gutters restoration storm damage insurance repair repairs
installation residential commercial wyoming cheyenne casper laramie gillette sheridan riverton evanston
rawlins lander douglas powell torrington worland cody jackson estimate estimates quote quotes request
get started learn more read view click here message from president owner owners founder founders ceo
operator operators proprietor office manager project sales general operations and of in at for to with
mr mrs ms dr customer customers reviews testimonials gallery projects careers blog privacy policy terms
copyright all rights reserved hours open phone email address areas serving proudly licensed insured
bonded certified master elite preferred best top rated award winning dedicated christian mountain
rocky western plains valley summit peak state county city north south east west new
""".split())


def clean_name(raw, business=""):
    """Trim filler words off a matched name. '' unless 2-3 real-looking name words remain."""
    words = raw.split()
    while words and words[0].lower().strip(".") in STOP:
        words.pop(0)
    while words and words[-1].lower().strip(".") in STOP:
        words.pop()
    if not 2 <= len(words) <= 3 or any(w.lower() in STOP for w in words):
        return ""
    biz = set(re.findall(r"[a-z']+", business.lower()))
    if all(w.lower().strip(".") in biz for w in words):  # the company name, not a person
        return ""
    return " ".join(words)


def owner_in_text(text, business):
    """First owner name in page text -> (name, evidence snippet), or None."""
    for rx in OWNER_PATTERNS:
        for m in rx.finditer(text):
            name = clean_name(m.group("name"), business)
            if name:
                s, e = max(0, m.start() - 40), min(len(text), m.end() + 40)
                return name, text[s:e].strip()
    return None


def owner_in_jsonld(blocks, business):
    """Founder, or a Person whose jobTitle is owner/founder/president, from schema.org JSON-LD."""
    names = []

    def walk(x):
        if isinstance(x, list):
            for item in x:
                walk(item)
        elif isinstance(x, dict):
            for p in x.get("founder") if isinstance(x.get("founder"), list) else [x.get("founder")]:
                names.append(p.get("name") if isinstance(p, dict) else p)
            if "person" in str(x.get("@type", "")).lower() and re.search(
                    r"owner|founder|president|ceo", str(x.get("jobTitle", "")), re.I):
                names.append(x.get("name"))
            for v in x.values():
                if isinstance(v, (list, dict)):
                    walk(v)

    for block in blocks:
        try:
            walk(json.loads(block))
        except ValueError:
            continue
    for n in names:
        name = clean_name(n, business) if isinstance(n, str) else ""
        if name:
            return name
    return None


def _json(s):
    try:
        v = json.loads(s) if s else {}
    except ValueError:
        return {}
    return {str(k).lower(): val for k, val in v.items()} if isinstance(v, dict) else {}


def listing_owner(row):
    """The Google Maps listing owner's name when it reads like a person rather than the company."""
    name = str(_json(row.get("owner")).get("name") or "").strip()
    if not re.fullmatch(rf"{NAME_WORD}(?:\s[A-Z]\.)?(?:\s{NAME_WORD}){{1,2}}", name):
        return ""
    return clean_name(name, row.get("title", ""))


# ── One website ────────────────────────────────────────────────────────────────

CONTACT_LINK = re.compile(r"contact|quote|estimate|request|schedul|appointment|book|get-started|inspection", re.I)
ABOUT_LINK = re.compile(r"about|team|our-story|story|meet|who-we-are|company|history|owner|staff", re.I)
SKIP_LINK = re.compile(r"^(?:mailto|tel|sms|javascript):|\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?)(?:$|\?)", re.I)


def _host(url):
    h = (urllib.parse.urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def site_links(page, base):
    """Same-site (contact-ish, about-ish) URLs: up to 3 and 2, with fixed fallbacks."""
    contact, about, host = [], [], _host(base)
    for href, text in page.links:
        if SKIP_LINK.search(href.strip()):
            continue
        url = urllib.parse.urldefrag(urllib.parse.urljoin(base, href.strip()))[0]
        if _host(url) != host or url.rstrip("/") == base.rstrip("/"):
            continue
        probe = urllib.parse.urlparse(url).path + " " + text
        for bucket, rx in ((contact, CONTACT_LINK), (about, ABOUT_LINK)):
            if rx.search(probe) and url not in bucket:
                bucket.append(url)
                break
    contact = contact or [urllib.parse.urljoin(base, p) for p in ("/contact", "/contact-us")]
    about = about or [urllib.parse.urljoin(base, p) for p in ("/about", "/about-us")]
    return contact[:3], about[:2]


def _where(url):
    path = urllib.parse.urlparse(url).path
    return path if path not in ("", "/") else "homepage"


def check_site(website, business=""):
    """Visit a homepage plus a few contact and about pages -> owner, ads and form findings."""
    out = {"owner_name": "", "owner_source": "", "owner_evidence": "", "runs_ads": "unknown",
           "ad_signals": "", "has_form": "unknown", "form_details": ""}
    if not website:
        return out
    base = website if website.startswith(("http://", "https://")) else "http://" + website
    home_url, home = fetch(base)
    if not home:
        out["ad_signals"] = out["form_details"] = "website did not load"
        return out

    home_page = Page(home)
    ads, unread = ad_signals(home)
    forms = [f"{name} on homepage" for name in forms_on(home_page, home)]
    owner = owner_in_jsonld(home_page.jsonld, business)
    owner = (owner, "website schema", "") if owner else None
    if not owner:
        hit = owner_in_text(home_page.text, business)
        owner = (hit[0], "website homepage", hit[1]) if hit else None

    contact_urls, about_urls = site_links(home_page, home_url or base)
    for url in contact_urls + about_urls:
        if url in about_urls and owner:
            continue
        if url in contact_urls and forms and owner:
            continue
        final, html = fetch(url)
        if not html:
            continue
        page = Page(html)
        ads += [a for a in ad_signals(html)[0] if a not in ads]
        forms += [f"{name} on {_where(final)}" for name in forms_on(page, html)]
        if not owner:
            name = owner_in_jsonld(page.jsonld, business)
            hit = (name, "") if name else owner_in_text(page.text, business)
            owner = (hit[0], f"website {_where(final)}", hit[1]) if hit else None

    if owner:
        out.update(owner_name=owner[0], owner_source=owner[1], owner_evidence=owner[2])
    if ads:
        out.update(runs_ads="likely", ad_signals="; ".join(dict.fromkeys(ads)))
    elif unread:
        out.update(runs_ads="maybe", ad_signals=f"tag container {', '.join(unread)} could not be read")
    else:
        out["runs_ads"] = "no signs"
    if forms:
        out.update(has_form="yes", form_details="; ".join(dict.fromkeys(forms)))
    elif JS_BUILDERS.search(home):
        out["form_details"] = "site builder renders forms in the browser only; check by hand"
    else:
        out["has_form"] = "no"
    return out


# ── Rows ───────────────────────────────────────────────────────────────────────

def _rating(v):
    try:
        return f"{float(v):.1f}"
    except (TypeError, ValueError):
        return ""


def lead_row(row):
    """A kit CSV row (scraped with --full) -> a lead sheet row without the website findings."""
    addr = _json(row.get("complete_address"))
    city = addr.get("city") or ""
    if not city:
        m = re.search(r",\s*([^,]+),\s*[A-Z]{2}\s+\d{5}", row.get("address", ""))
        city = m.group(1).strip() if m else ""
    return {"name": row.get("title", ""), "category": row.get("category", ""), "city": city,
            "address": row.get("address", ""), "phone": row.get("phone", ""),
            "emails": row.get("emails", ""), "website": row.get("website", ""),
            "rating": _rating(row.get("review_rating")), "reviews": row.get("review_count", ""),
            "google_maps_url": row.get("link", ""), "place_id": row.get("place_id", "")}


def enrich(rows, workers=8):
    """Kit rows -> lead sheet rows with owner, ads and form findings, best prospects first."""
    def work(row):
        lead = lead_row(row)
        lead.update(check_site(lead["website"], lead["name"]))
        if not lead["owner_name"]:
            name = listing_owner(row)
            if name:
                lead.update(owner_name=name, owner_source="Google Maps listing owner")
        return lead

    leads = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i, lead in enumerate(ex.map(work, rows), 1):
            leads.append(lead)
            print(f"\r  websites: {i}/{len(rows)} checked", end="", flush=True)
    print()

    def rank(lead):
        reviews = int(lead["reviews"]) if str(lead["reviews"]).isdigit() else 0
        return (lead["runs_ads"] != "likely", lead["has_form"] != "yes", -reviews)
    return sorted(leads, key=rank)


def write_csv(leads, path):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LEAD_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(leads)


def summary(leads):
    n = len(leads) or 1
    count = lambda key, val: sum(1 for l in leads if l[key] == val)
    has = lambda key: sum(1 for l in leads if l[key])
    return (f"{len(leads)} businesses | phone {has('phone')} | email {has('emails')} | "
            f"owner name {has('owner_name')} | ads likely {count('runs_ads', 'likely')} | "
            f"web form {count('has_form', 'yes')} | ads + form "
            f"{sum(1 for l in leads if l['runs_ads'] == 'likely' and l['has_form'] == 'yes')} "
            f"({round(100 * has('website') / n)}% have a website)")


def main():
    ap = argparse.ArgumentParser(description="Add owner name, ad tracking and web-form checks to a kit CSV.")
    ap.add_argument("input", help="CSV from the Google Maps Scraper Kit, scraped with --full")
    ap.add_argument("output", help="lead sheet CSV to write")
    ap.add_argument("--workers", type=int, default=8, help="websites checked in parallel")
    a = ap.parse_args()
    with open(a.input, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if rows and "owner" not in rows[0]:
        print("ℹ No `owner` column: re-scrape with --full to get Google listing owners too.", file=sys.stderr)
    leads = enrich(rows, a.workers)
    write_csv(leads, a.output)
    print(f"✓ {summary(leads)}\n  saved → {a.output}")


if __name__ == "__main__":
    main()
