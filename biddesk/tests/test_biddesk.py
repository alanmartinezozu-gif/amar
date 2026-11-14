"""Parser tests run against saved pages in tests/fixtures. No network, no API key."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from biddesk import ai, briefs, db, ingest, match, reports
from biddesk.models import Opportunity, ScrapeResult, parse_datetime
from biddesk.sources import revize, scsd1_facilities, sweetwaternow

FIX = Path(__file__).parent / "fixtures"


def read(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8", errors="replace")


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr("biddesk.settings.DOCS_DIR", tmp_path / "docs")
    c = db.connect(tmp_path / "t.db")
    ingest.sync_sources(c)
    match.sync_clients(c)
    return c


# --- dates -------------------------------------------------------------------
@pytest.mark.parametrize("text,expected", [
    ("Thursday, 6/26/25 at 2:00 PM MST at Central Administration Building", "2025-06-26T14:00"),
    ("2:00 P.M., local time, Tuesday, March 31, 2026", "2026-03-31T14:00"),
    ("09/08/21 at 2:00 PM MST", "2021-09-08T14:00"),
    ("12/01/2026 7:00 PM", "2026-12-01T19:00"),
    ("5/21/25", "2025-05-21"),
    ("Open Until Contracted", None),
    ("", None),
])
def test_parse_datetime(text, expected):
    assert parse_datetime(text) == expected


# --- Revize (Rock Springs, Sweetwater County) --------------------------------
@pytest.mark.parametrize("name", ["revize_rocksprings_empty.html", "revize_sweetwater_empty.html"])
def test_revize_live_empty_pages(name):
    r = revize.parse(read(name), "https://example.gov/bids.php")
    assert r.layout_ok and r.explicit_empty and r.items == []


def test_revize_populated():
    r = revize.parse(read("revize_populated_SYNTHETIC.html"), "https://www.rswy.net/government/bid_information.php")
    assert [o.title for o in r.items] == [
        "2027 Concrete Replacement Phase I Invitation to Bid", "Cemetery Lighting Project"]
    first, second = r.items
    assert first.due_datetime == "2026-12-01T19:00" and first.posted_date == "2026-11-02"
    assert first.url == "https://www.rswy.net/government/bid_detail_T7_R101.php"
    assert first.documents[0].url == "https://www.rswy.net/Documents/Bids/Concrete Phase I Invitation.pdf"
    assert second.due_datetime is None and not r.explicit_empty


def test_revize_layout_change_detected():
    assert revize.parse("<html><body>redesigned</body></html>", "https://x").layout_ok is False


# --- SCSD#1 ------------------------------------------------------------------
def test_scsd1_facilities():
    r = scsd1_facilities.parse(read("scsd1_facilities.html"), "https://scsd1.example/bids")
    assert len(r.items) > 30
    lowell = r.items[0]
    assert lowell.title == "Lowell HVAC System (Lowell School)"
    assert lowell.posted_date == "2025-05-21" and lowell.due_datetime == "2025-06-26T14:00"
    assert [d.filename for d in lowell.documents] == [
        "Lowell - Invitation to Bid.pdf", "Specifications - Bid Package - Lowell HVAC.pdf",
        "Addendum_1 - Lowell School HVAC.pdf"]
    assert [d.doc_type for d in lowell.documents] == ["notice", "spec", "addendum"]
    assert lowell.prebid_mandatory is True
    tennis = next(o for o in r.items if "Rock Springs High School Tennis" in o.title)
    assert tennis.prebid_datetime == "2025-04-15T10:00"


# --- SweetwaterNOW -----------------------------------------------------------
def test_sweetwaternow_listing_and_notice():
    entries, ok = sweetwaternow.parse_listing(read("sweetwaternow_legal.html"))
    assert ok and len(entries) >= 9
    bids = [t for t, _ in entries if sweetwaternow.BID_WORDS.search(t)]
    assert bids == ["SWCSD#1’s Invitation to Bid", "REQUEST FOR PROPOSALS (RFP)"]
    o = sweetwaternow.parse_notice(read("sweetwaternow_notice.html"), "https://www.sweetwaternow.com/x/")
    assert "2026 Special Education Consultation" in o.raw_text
    assert o.due_datetime == "2026-03-31T14:00"
    assert "Story continues below" not in o.raw_text


# --- ingest + health ---------------------------------------------------------
def _fake_source(conn, monkeypatch, result):
    src = conn.execute("SELECT * FROM sources WHERE parser='revize' LIMIT 1").fetchone()
    monkeypatch.setattr(revize, "scrape", lambda f, s: result() if callable(result) else result)
    return src


def test_zero_items_after_some_raises_alert(conn, monkeypatch):
    src = _fake_source(conn, monkeypatch, ScrapeResult([Opportunity("Job A", url="u", raw_text="Job A")]))
    ingest.run_source(conn, None, src)
    src = conn.execute("SELECT * FROM sources WHERE id=?", (src["id"],)).fetchone()
    assert src["last_item_count"] == 1 and src["alert"] is None
    monkeypatch.setattr(revize, "scrape", lambda f, s: ScrapeResult([]))
    ingest.run_source(conn, None, src)
    after = conn.execute("SELECT * FROM sources WHERE id=?", (src["id"],)).fetchone()
    assert after["last_status"] == "suspicious_zero" and after["alert"]
    # ...but a page that says "nothing posted" is fine.
    conn.execute("UPDATE sources SET last_item_count=1 WHERE id=?", (src["id"],))
    monkeypatch.setattr(revize, "scrape", lambda f, s: ScrapeResult([], explicit_empty=True))
    ingest.run_source(conn, None, conn.execute("SELECT * FROM sources WHERE id=?", (src["id"],)).fetchone())
    assert conn.execute("SELECT alert FROM sources WHERE id=?", (src["id"],)).fetchone()["alert"] is None


def test_scrape_error_is_recorded_not_raised(conn, monkeypatch):
    def boom():
        raise RuntimeError("site down")
    src = _fake_source(conn, monkeypatch, boom)
    ingest.run_source(conn, None, src)
    after = conn.execute("SELECT * FROM sources WHERE id=?", (src["id"],)).fetchone()
    assert after["last_status"] == "error" and "site down" in after["last_error"]


def test_upsert_is_idempotent_and_tracks_documents(conn):
    src = conn.execute("SELECT * FROM sources WHERE parser='scsd1_facilities'").fetchone()
    r = scsd1_facilities.parse(read("scsd1_facilities.html"), src["url"])
    for _ in range(2):
        for o in r.items:
            ingest.upsert_opportunity(conn, src, o)
    n = conn.execute("SELECT COUNT(*) c FROM opportunities").fetchone()["c"]
    assert n == len({ingest._dedupe_key(src["id"], o) for o in r.items})
    assert conn.execute("SELECT COUNT(*) c FROM opportunities WHERE status='open'").fetchone()["c"] == 0  # all past due
    d = conn.execute("SELECT COUNT(*) c, COUNT(DISTINCT opportunity_id||url_or_path) u FROM documents").fetchone()
    assert d["c"] == d["u"] > 30


def _pdf(text_lines: list[str]) -> bytes:
    import io

    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for page in text_lines:
        y = 780
        for line in page.split("\n"):
            c.drawString(60, y, line)
            y -= 16
        c.showPage()
    c.save()
    return buf.getvalue()


def test_manual_upload_extracts_text_with_page_markers(conn):
    long = "\n".join(["INVITATION TO BID - Bid bond of five percent (5%) of the bid is required."] * 6)
    oid = ingest.create_manual_opportunity(conn, "Test Paving", "City of Rock Springs", "Sweetwater",
                                           files=[("Invitation.pdf", _pdf([long, long + "\nPage two"]))])
    d = conn.execute("SELECT * FROM documents WHERE opportunity_id=?", (oid,)).fetchone()
    assert d["page_count"] == 2 and d["needs_vision"] == 0 and len(d["sha256"]) == 64
    assert "[[PAGE 1]]" in d["text"] and "[[PAGE 2]]" in d["text"] and "Bid bond" in d["text"]
    assert Path(d["local_path"]).exists()
    fp1 = ingest.docs_fingerprint(conn, oid)
    ingest.store_document(conn, oid, "Addendum 1.pdf", _pdf([long + "\nchanged"]), "upload:Addendum 1.pdf")
    assert ingest.docs_fingerprint(conn, oid) != fp1
    assert conn.execute("SELECT doc_type FROM documents WHERE filename='Addendum 1.pdf'").fetchone()[0] == "addendum"


def test_scanned_pdf_flagged_for_vision(conn):
    oid = ingest.create_manual_opportunity(conn, "Scan", files=[("scan.pdf", _pdf(["", ""]))])
    assert conn.execute("SELECT needs_vision FROM documents WHERE opportunity_id=?", (oid,)).fetchone()[0] == 1


# --- matching ----------------------------------------------------------------
PROFILE = {"trades": ["concrete"], "counties": ["Sweetwater"], "job_size_min": 25000, "job_size_max": 2000000}
NOW = datetime(2026, 11, 14, 9, 0)


def _opp(**kw):
    base = {"is_construction": 1, "trade_tags": '["concrete"]', "county": "Sweetwater",
            "est_value": 400000, "due_datetime": "2026-12-01T19:00"}
    base.update(kw)
    return base


def test_match_scores():
    assert match.score(PROFILE, _opp(), NOW)[0] == 100
    assert match.score(PROFILE, _opp(is_construction=0), NOW)[0] == 0
    assert match.score(PROFILE, _opp(due_datetime="2026-11-01T10:00"), NOW)[0] == 0
    wrong_trade = match.score(PROFILE, _opp(trade_tags='["roofing"]'), NOW)[0]
    assert wrong_trade < match.BRIEF_THRESHOLD
    unknowns = match.score(PROFILE, _opp(est_value=None, due_datetime=None), NOW)
    assert unknowns[0] >= match.BRIEF_THRESHOLD and "unknown" in unknowns[1]
    assert match.score(PROFILE, _opp(county="Laramie"), NOW)[0] < 100


# --- AI plumbing (no network) ------------------------------------------------
def test_brief_schema_is_accepted_by_sdk_transform():
    schema = ai.transform_schema(ai.BidBrief)
    assert schema["type"] == "object" and "fit_for_client" in schema["properties"]
    assert ai.transform_schema(ai.Triage)["additionalProperties"] is False


def test_cost_math():
    u = SimpleNamespace(input_tokens=1_000_000, output_tokens=100_000, cache_read_input_tokens=0, cache_creation_input_tokens=0)
    assert ai.cost_usd("claude-fable-5-2", u) == 12.0
    assert ai.cost_usd("claude-haiku-5-5", u) == 0.15


SAMPLE_BRIEF = {
    "project_name": "Test Paving", "owner": "City of Rock Springs", "location": "Rock Springs, WY",
    "scope_summary": "Mill and overlay.", "trades_involved": ["asphalt_paving"],
    "estimated_value": {"amount": None, "source": "unknown", "page": None},
    "key_dates": {"posted": "unknown", "questions_due": "unknown", "prebid_meeting": "unknown",
                  "prebid_mandatory": None, "prequal_due": "unknown", "bid_due": "December 1, 2026 7:00 pm",
                  "bid_opening": "unknown", "completion_date": "unknown"},
    "submission": {"method": "sealed_paper", "deliver_to": "City Clerk", "envelope_marking": "unknown", "copies": None},
    "requirements": [{"item": "5% bid bond", "detail": "Certified check or bond", "page": "Invitation p.1"}],
    "prequalification": {"required": None, "type": "unknown", "detail": "", "page": "unknown - verify"},
    "resident_preference_applies": "unknown", "wyoming_materials_preference_applies": "unknown",
    "liquidated_damages": {"amount_per_day": None, "page": "unknown - verify"},
    "red_flags": [], "questions_to_ask_owner": [], "addenda_count": 0, "unreadable_documents": [],
    "fit_for_client": {"score_0_100": 40, "go_no_go": "maybe", "reasons": ["Paving is not a listed trade."]},
}


class FakeStream:
    def __init__(self, text, stop="end_turn"):
        self.msg = SimpleNamespace(
            model="claude-fable-5-2", stop_reason=stop, content=[SimpleNamespace(type="text", text=text)],
            usage=SimpleNamespace(input_tokens=1000, output_tokens=500, cache_read_input_tokens=0, cache_creation_input_tokens=0))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.msg


def _fake_client(monkeypatch, replies):
    calls = []

    def stream(**kw):
        calls.append(kw)
        return FakeStream(*replies[min(len(calls) - 1, len(replies) - 1)])
    api = SimpleNamespace(stream=stream)
    monkeypatch.setattr(ai, "client", lambda: SimpleNamespace(messages=api, beta=SimpleNamespace(messages=api)))
    return calls


def test_brief_end_to_end_with_fake_model(conn, monkeypatch):
    calls = _fake_client(monkeypatch, [("not json",), (json.dumps(SAMPLE_BRIEF),)])
    oid = ingest.create_manual_opportunity(conn, "Test Paving", "City of Rock Springs", "Sweetwater",
                                           due_datetime="2099-01-01T10:00",
                                           files=[("ITB.pdf", _pdf(["Bid bond 5% required\n" * 8]))])
    client = conn.execute("SELECT * FROM clients").fetchone()
    a = briefs.write_brief(conn, oid, client)
    assert len(calls) == 2  # one retry after bad JSON
    kw = calls[0]
    assert kw["model"] == "claude-fable-5-2" and kw["fallbacks"] == "default"
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"} and "W.S. 16-6-102" in kw["system"][0]["text"]
    user_text = " ".join(b["text"] for b in kw["messages"][0]["content"] if b["type"] == "text")
    assert "[[PAGE 1]]" in user_text and "APLeasant" in user_text
    assert json.loads(a["brief_json"])["requirements"][0]["page"] == "Invitation p.1"
    assert conn.execute("SELECT COUNT(*), SUM(cost_usd) FROM ai_usage").fetchone()[0] == 2
    assert "5% bid bond" in briefs.brief_html(json.loads(a["brief_json"]))


def test_refusal_raises(conn, monkeypatch):
    _fake_client(monkeypatch, [("", "refusal")])
    with pytest.raises(ai.AIError):
        ai.call_json(conn, model="claude-fable-5-2", system="s", content="c", schema=ai.Triage,
                     purpose="t", max_tokens=100)


# --- weekly report + outbox --------------------------------------------------
def test_weekly_report_and_approval_gate(conn, monkeypatch):
    monkeypatch.setenv("REPORT_TO", "me@example.com")
    oid = ingest.create_manual_opportunity(conn, "Sidewalk Replacement <2027>", "City of Rock Springs", "Sweetwater",
                                           due_datetime="2099-01-01T10:00")
    conn.execute("UPDATE opportunities SET is_construction=1, trade_tags='[\"concrete\"]' WHERE id=?", (oid,))
    match.run_matching(conn)
    assert reports.queue_weekly(conn) == 1
    row = conn.execute("SELECT * FROM outbox").fetchone()
    assert row["status"] == "pending" and row["to_addr"] == "me@example.com"
    assert "Sidewalk Replacement &lt;2027&gt;" in row["html"] and "Always verify against the official bid documents" in row["html"]

    sent = []

    class FakeSMTP:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def starttls(self): pass
        def login(self, u, p): pass
        def send_message(self, m): sent.append(m)

    # Without SMTP settings the send fails loudly and nothing goes out.
    for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"):
        monkeypatch.delenv(k, raising=False)
    assert reports.send_approved(conn, row["id"], FakeSMTP).startswith("error") and not sent
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_USER", "u")
    monkeypatch.setenv("SMTP_PASSWORD", "p")
    conn.execute("UPDATE outbox SET to_addr='client@example.com'")  # even if tampered, Phase 1 sends to REPORT_TO
    assert reports.send_approved(conn, row["id"], FakeSMTP) == "sent"
    assert sent[0]["To"] == "me@example.com"
    assert reports.send_approved(conn, row["id"], FakeSMTP) == "nothing to send"


def test_report_only_contains_own_client_matches(conn, tmp_path):
    other = tmp_path / "other.yaml"
    other.write_text("name: Other Co\ntier: finder\ntrades: [roofing]\ncounties: [Sweetwater]\n")
    conn.execute("INSERT INTO clients(name,tier,profile_yaml_path,email) VALUES('Other Co','finder',?, '')", (str(other),))
    a = ingest.create_manual_opportunity(conn, "Concrete Job", county="Sweetwater", due_datetime="2099-01-01T10:00")
    b = ingest.create_manual_opportunity(conn, "Roof Job", county="Sweetwater", due_datetime="2099-01-01T10:00")
    conn.execute("UPDATE opportunities SET is_construction=1, trade_tags='[\"concrete\"]' WHERE id=?", (a,))
    conn.execute("UPDATE opportunities SET is_construction=1, trade_tags='[\"roofing\"]' WHERE id=?", (b,))
    match.run_matching(conn)
    ap = conn.execute("SELECT * FROM clients WHERE name='APLeasant'").fetchone()
    _, html = reports.build_weekly(conn, ap)
    assert "Concrete Job" in html and "Roof Job" not in html
