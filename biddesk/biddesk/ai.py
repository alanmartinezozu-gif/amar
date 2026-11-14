"""All Claude calls and prompt templates.

- Triage: claude-haiku-5-5 (cheap first pass).
- Bid brief: claude-fable-5-2 (deep read of the bid package).

Every call returns JSON constrained to a schema, validated with pydantic (one retry on a
bad result), and is logged to ai_usage with its cost. The static part of the brief prompt
(instructions + wyoming_rules.md) is cached.
"""
from __future__ import annotations

import base64
import json
import sqlite3
from typing import Literal

import anthropic
from anthropic import transform_schema
from pydantic import BaseModel, ValidationError

from . import db, settings

# USD per million tokens: (input, output, cache read, cache write). Update if prices change.
PRICES = {
    "claude-fable-5-2": (8.00, 40.00, 0.20, 10.00),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-opus-4-8": (5.00, 25.00, 0.50, 6.25),
}
# Models that take the server-side refusal fallback (not Haiku).
FALLBACK_MODELS = ("claude-fable-", "claude-opus-5", "claude-sonnet-5-5")
MAX_VISION_PAGES = 40

TRADE_TAGS = [
    "asphalt_paving", "concrete", "earthwork_excavation", "utilities_water_sewer", "roofing",
    "hvac_mechanical", "plumbing", "electrical", "general_building", "remodel_interior", "painting",
    "flooring", "demolition", "fencing", "landscaping_grounds", "snow_removal", "steel_metal_building",
    "playground_sports_surfaces", "glazing", "low_voltage_data", "janitorial", "other",
]
TradeTag = Literal[tuple(TRADE_TAGS)]  # type: ignore[valid-type]


# --- schemas -----------------------------------------------------------------
class Triage(BaseModel):
    is_construction: bool
    trade_tags: list[TradeTag]
    est_value_if_stated: float | None
    confidence: float


class EstimatedValue(BaseModel):
    amount: float | None
    source: Literal["stated", "engineer_estimate", "unknown"]
    page: str | None


class KeyDates(BaseModel):
    posted: str
    questions_due: str
    prebid_meeting: str
    prebid_mandatory: bool | None
    prequal_due: str
    bid_due: str
    bid_opening: str
    completion_date: str


class Submission(BaseModel):
    method: Literal["sealed_paper", "public_purchase_upload", "wydot_icx", "email", "other", "unknown"]
    deliver_to: str
    envelope_marking: str
    copies: int | None


class Requirement(BaseModel):
    item: str
    detail: str
    page: str


class Prequalification(BaseModel):
    required: bool | None
    type: Literal["WYDOT list", "owner prequal packet", "none", "unknown"]
    detail: str
    page: str


class LiquidatedDamages(BaseModel):
    amount_per_day: float | None
    page: str


class RedFlag(BaseModel):
    flag: str
    why_it_matters: str
    page: str


class Fit(BaseModel):
    score_0_100: int
    go_no_go: Literal["go", "maybe", "no_go"]
    reasons: list[str]


class BidBrief(BaseModel):
    project_name: str
    owner: str
    location: str
    scope_summary: str
    trades_involved: list[TradeTag]
    estimated_value: EstimatedValue
    key_dates: KeyDates
    submission: Submission
    requirements: list[Requirement]
    prequalification: Prequalification
    resident_preference_applies: Literal["yes", "no", "unknown"]
    wyoming_materials_preference_applies: Literal["yes", "no", "unknown"]
    liquidated_damages: LiquidatedDamages
    red_flags: list[RedFlag]
    questions_to_ask_owner: list[str]
    fit_for_client: Fit
    addenda_count: int
    unreadable_documents: list[str]


# --- prompts -----------------------------------------------------------------
TRIAGE_SYSTEM = (
    "You sort public procurement notices for a service that helps Wyoming construction "
    "contractors find bids. Decide whether the notice is for construction, building "
    "maintenance or site work a contractor would bid (as opposed to goods, vehicles, "
    "software, consulting, surplus sales, hearings or other notices). Pick trade tags only "
    "from the allowed list. Report a dollar value only if the notice states one. "
    "confidence is 0 to 1."
)

BRIEF_INSTRUCTIONS = """\
You write bid briefs for a done-for-you bid service used by construction contractors in
Wyoming. The reader is a busy contractor deciding whether to bid a public job, and then
what they must hand in. They do their own pricing and they sign and submit the bid
themselves; you never propose prices.

You will get the notice text and the text of every bid document we could read, with page
markers like [[PAGE 7]] inside each document, plus the client's profile.

What matters most is that the contractor can trust every line:

- Report only what the documents say. When the documents do not say something, write
  "unknown" (or null for numbers). A missed deadline or an invented bond amount can cost
  the client a job or their bid security, so never fill a gap from general knowledge or
  from the reference notes below.
- Give a page or section reference for every requirement, red flag, prequalification
  finding and liquidated-damages figure, written like "Invitation to Bid p.2" or
  "Spec 00 21 13, p.14". If a point comes from the short notice text with no page, write
  "notice". If you cannot point to where something is stated, write "unknown - verify".
- Dates: copy them as written in the document, including the time and time zone
  wording. Use "unknown" when a date is not given. Keep a prequalification deadline
  separate from the bid deadline.
- requirements: list every bond, security, form, certificate, license, insurance,
  acknowledgment, meeting and submission rule a bidder must satisfy.
- red_flags: things that could disqualify the bid or cost money, such as a mandatory
  pre-bid meeting, a prequalification the client lacks, short schedules, heavy liquidated
  damages, unusual insurance, or documents that contradict each other.
- fit_for_client: score against the client profile (trades, counties and travel, job
  size, bonding, prequalification, time left before the deadline). Say plainly in the
  reasons what drove the score and which profile facts are missing.
- If a document is listed as unreadable or looks like a garbled scan, name it in
  unreadable_documents and say in scope_summary what could not be read. Do not guess at
  its contents.
- addenda_count is the number of addenda among the documents provided.

Write scope_summary as three to five plain sentences a foreman would understand.

The reference notes below describe how Wyoming public bidding usually works. Use them to
know what to look for and to explain why something matters. The bid documents always
override them.

<wyoming_reference_notes>
{rules}
</wyoming_reference_notes>
"""


# --- plumbing ----------------------------------------------------------------
_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY (loaded from .env)
    return _client


def available() -> bool:
    return bool(settings.env("ANTHROPIC_API_KEY") or settings.env("ANTHROPIC_AUTH_TOKEN"))


def cost_usd(model: str, usage) -> float:
    p = PRICES.get(model)
    if not p:
        return 0.0
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    cr = getattr(usage, "cache_read_input_tokens", 0) or 0
    cw = getattr(usage, "cache_creation_input_tokens", 0) or 0
    return round((inp * p[0] + out * p[1] + cr * p[2] + cw * p[3]) / 1_000_000, 6)


def _log(conn, model, usage, purpose, client_id, opportunity_id) -> float:
    cost = cost_usd(model, usage)
    conn.execute(
        "INSERT INTO ai_usage(ts,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,"
        "cost_usd,purpose,client_id,opportunity_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (db.now(), model, getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0,
         getattr(usage, "cache_read_input_tokens", 0) or 0, getattr(usage, "cache_creation_input_tokens", 0) or 0,
         cost, purpose, client_id, opportunity_id))
    conn.commit()
    return cost


class AIError(Exception):
    pass


def call_json(conn: sqlite3.Connection, *, model: str, system, content, schema: type[BaseModel],
              purpose: str, max_tokens: int, effort: str | None = None,
              client_id: int | None = None, opportunity_id: int | None = None):
    """One structured call. Returns (validated model, cost). Retries once on bad JSON."""
    output_config: dict = {"format": {"type": "json_schema", "schema": transform_schema(schema)}}
    if effort:
        output_config["effort"] = effort
    kwargs = dict(model=model, max_tokens=max_tokens, system=system,
                  messages=[{"role": "user", "content": content}], output_config=output_config)
    use_fallback = model.startswith(FALLBACK_MODELS)
    if use_fallback:
        # If a safety classifier declines the request, Anthropic re-runs it on its
        # recommended fallback model inside the same call.
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    total, last_err = 0.0, None
    for _attempt in range(2):
        api = client().beta.messages if use_fallback else client().messages
        with api.stream(**kwargs) as stream:  # streaming avoids HTTP timeouts on long reads
            msg = stream.get_final_message()
        total += _log(conn, msg.model or model, msg.usage, purpose, client_id, opportunity_id)
        if msg.stop_reason == "refusal":
            raise AIError(f"The model declined this request ({purpose}).")
        if msg.stop_reason == "max_tokens":
            last_err = "The answer was cut off (max_tokens)."
            kwargs["max_tokens"] = min(max_tokens * 2, 64000)
            continue
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            return schema.model_validate(json.loads(text)), total
        except (json.JSONDecodeError, ValidationError) as e:
            last_err = f"{type(e).__name__}: {e}"
    raise AIError(f"No valid JSON after one retry ({purpose}): {last_err}")


# --- tasks -------------------------------------------------------------------
def triage(conn: sqlite3.Connection, opportunity_id: int, title: str, notice_text: str) -> Triage:
    content = f"<title>{title}</title>\n<notice>\n{notice_text[:12000]}\n</notice>"
    result, _ = call_json(conn, model=settings.triage_model(), system=TRIAGE_SYSTEM, content=content,
                          schema=Triage, purpose="triage", max_tokens=4000, effort="low",
                          opportunity_id=opportunity_id)
    return result


def _page_images(path: str, limit: int) -> list[dict]:
    import io

    import pypdfium2 as pdfium

    blocks = []
    pdf = pdfium.PdfDocument(path)
    for i in range(min(len(pdf), limit)):
        img = pdf[i].render(scale=1.6).to_pil().convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        blocks.append({"type": "text", "text": f"[[PAGE {i + 1}]] (page image)"})
        blocks.append({"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg",
            "data": base64.standard_b64encode(buf.getvalue()).decode()}})
    return blocks


def build_brief_content(opp, docs, profile_yaml: str) -> list[dict]:
    """User turn: documents first, then the notice, then the client profile and the ask."""
    blocks: list[dict] = []
    unread = []
    vision_left = MAX_VISION_PAGES
    for d in docs:
        label = f'{d["filename"]} (type: {d["doc_type"] or "unknown"})'
        if d["needs_vision"] and d["local_path"] and vision_left > 0:
            imgs = _page_images(d["local_path"], vision_left)
            vision_left -= len(imgs) // 2
            note = ""
            if (d["page_count"] or 0) > len(imgs) // 2:
                note = (f" Only the first {len(imgs) // 2} of {d['page_count']} pages are shown;"
                        " the rest could not be read.")
                unread.append(f'{d["filename"]} (pages after {len(imgs) // 2})')
            blocks.append({"type": "text", "text": f"<document name=\"{label}\" scanned=\"true\">{note}"})
            blocks += imgs
            blocks.append({"type": "text", "text": "</document>"})
        elif d["text"] and not d["needs_vision"]:
            blocks.append({"type": "text", "text": f"<document name=\"{label}\">\n{d['text']}\n</document>"})
        else:
            unread.append(d["filename"])
    tail = (
        f"<notice owner=\"{opp['owner_name'] or ''}\" source_url=\"{opp['url'] or ''}\">\n"
        f"Title: {opp['title']}\n{opp['raw_text'] or ''}\n</notice>\n\n"
        f"<documents_we_could_not_read>\n{json.dumps(unread)}\n</documents_we_could_not_read>\n\n"
        f"<client_profile>\n{profile_yaml}\n</client_profile>\n\n"
        "Write the bid brief for this client."
    )
    blocks.append({"type": "text", "text": tail})
    return blocks


def bid_brief(conn: sqlite3.Connection, opp, docs, profile_yaml: str, client_id: int | None) -> tuple[BidBrief, float]:
    rules = settings.RULES_PATH.read_text()
    system = [{"type": "text", "text": BRIEF_INSTRUCTIONS.format(rules=rules),
               "cache_control": {"type": "ephemeral"}}]
    return call_json(conn, model=settings.brief_model(), system=system,
                     content=build_brief_content(opp, docs, profile_yaml), schema=BidBrief,
                     purpose="bid_brief", max_tokens=32000, effort="high",
                     client_id=client_id, opportunity_id=opp["id"])
