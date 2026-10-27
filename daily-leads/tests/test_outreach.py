import anthropic
import httpx2
import pytest

from daily_leads.cache import Cache
from daily_leads.config import City
from daily_leads.models import Lead
from daily_leads.outreach import (
    FALLBACK_BETA, OutreachCopy, OutreachFatal, OutreachWriter, check_copy, lead_facts, opens_with_question,
)

from .conftest import FakeClaude

GOOD_EN = OutreachCopy(
    call_note="57 reviews and 24/7 emergency repair - ask who answers after hours.",
    dm_text="Hey Mike, who calls your customers back when you're up on a roof? I get every lead a call in 60 "
            "seconds and booked on your calendar. Open to a quick 15-min look?",
    missed_call_text="Just tried calling - you were probably on a job. That's exactly what I fix: every lead "
                     "called back in 60 seconds and booked. When's a good time to talk?",
)
GOOD_ES = OutreachCopy(
    call_note="Their site says Se Habla Español - lead with the bilingual angle.",
    dm_text="Hola, ¿quién le regresa la llamada a sus clientes cuando usted está en un trabajo? Yo hago que "
            "cada cliente reciba llamada en 60 segundos. ¿Le enseño cómo en 15 minutos?",
    missed_call_text="Le acabo de llamar, seguro estaba en un trabajo. Eso es justo lo que resuelvo: cada "
                     "cliente recibe llamada en 60 segundos y queda agendado. ¿Cuándo podemos platicar?",
)


def lead(**kw):
    base = dict(name="Alamo Roof Pros", phone="+12105550199", website="https://alamoroofpros.com/",
                address="1 Main St", city="San Antonio", state="TX", postal_code="78205", rating=4.8,
                reviews=57, maps_url="", place_id="p1", trades=["roofing"], market=City("San Antonio", "TX"))
    return Lead(**{**base, **kw})


def test_good_copy_passes():
    assert check_copy(GOOD_EN, spanish=False) == []
    assert check_copy(GOOD_ES, spanish=True) == []


@pytest.mark.parametrize("field, text, problem", [
    ("dm_text", "Who calls your leads back? Our AI answers in 60 seconds.", "mentions AI"),
    ("dm_text", "Who calls your leads back? Our A.I. answers.", "mentions AI"),
    ("missed_call_text", "Missed you - our chatbot books leads.", "mentions a bot"),
    ("dm_text", "Who calls back? See https://x.co", "contains a link"),
    ("dm_text", "Who calls back? Check www.speedlead.com", "contains a link"),
    ("dm_text", "Who calls back? " + "word " * 50, "words"),
    ("dm_text", "Hey Mike. Hope all is well. Who calls your customers back?", "open with a question"),
    ("dm_text", "We fix missed calls for roofers.", "open with a question"),
    ("call_note", "Pitch the artificial intelligence angle", "artificial intelligence"),
])
def test_rule_violations_caught(field, text, problem):
    copy = GOOD_EN.model_copy(update={field: text})
    assert any(problem in p for p in check_copy(copy, spanish=False))


@pytest.mark.parametrize("text", [
    "Hey Mike! Who calls your customers back when you're on a roof?",
    "¡Hola Sr. Ramírez! ¿Quién le regresa la llamada a sus clientes?",
    "Quick question - who calls your customers back while you're on a job?",
])
def test_short_greeting_before_question_is_fine(text):
    assert opens_with_question(text)


def test_spanish_rules():
    tu = GOOD_ES.model_copy(update={"dm_text": "Hola, ¿quién le regresa la llamada a tus clientes cuando estás en un trabajo?"})
    assert any("usted" in p for p in check_copy(tu, spanish=True))
    assert any("Spanish" in p for p in check_copy(GOOD_EN, spanish=True))
    assert any("English" in p for p in check_copy(GOOD_ES, spanish=False))
    ia = GOOD_ES.model_copy(update={"missed_call_text": "Le llamé. Mi sistema con IA contesta en 60 segundos."})
    assert any("IA" in p for p in check_copy(ia, spanish=True))


def test_writer_uses_fallbacks_and_structured_output(settings, tmp_path):
    claude = FakeClaude()
    writer = OutreachWriter(claude, Cache(tmp_path / "c.db", {}), settings)
    l = lead(owner_name="Carlos Ramirez", spanish_signal=True)
    writer.write(l)
    call = claude.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["betas"] == [FALLBACK_BETA] and call["fallbacks"] == "default"
    assert call["output_format"] is OutreachCopy and call["output_config"] == {"effort": "medium"}
    assert '"owner_first_name": "Carlos"' in call["messages"][0]["content"]
    assert l.dm_text.startswith("Hola Carlos, ¿")
    assert l.call_note and l.missed_call_text


def test_writer_rewrites_bad_drafts(settings, tmp_path):
    claude = FakeClaude(bad_first=1)
    l = lead()
    OutreachWriter(claude, Cache(tmp_path / "c.db", {}), settings).write(l)
    assert len(claude.calls) == 2
    assert "mentions AI" in claude.calls[1]["messages"][0]["content"]
    assert "AI" not in l.dm_text.split()


def test_writer_leaves_blank_after_repeated_failures(settings, tmp_path):
    l = lead()
    OutreachWriter(FakeClaude(bad_first=99), Cache(tmp_path / "c.db", {}), settings).write(l)
    assert l.dm_text == "" and "mentions AI" in l.outreach_error


def test_refusal_leaves_blank(settings, tmp_path):
    l = lead()
    OutreachWriter(FakeClaude(refuse=True), Cache(tmp_path / "c.db", {}), settings).write(l)
    assert l.dm_text == "" and l.outreach_error


def test_cached_copy_is_not_rebilled(settings, tmp_path):
    claude, cache = FakeClaude(), Cache(tmp_path / "c.db", {"claude": 30})
    OutreachWriter(claude, cache, settings).write(lead())
    again = lead()
    OutreachWriter(claude, cache, settings).write(again)
    assert len(claude.calls) == 1 and again.dm_text


def test_bad_api_key_is_fatal(settings, tmp_path):
    class Broken(FakeClaude):
        def parse(self, **kwargs):
            request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
            raise anthropic.AuthenticationError("invalid x-api-key", response=httpx2.Response(401, request=request),
                                                body=None)

    with pytest.raises(OutreachFatal):
        OutreachWriter(Broken(), Cache(tmp_path / "c.db", {}), settings).write(lead())


def test_facts_never_include_last_name_or_guesses():
    facts = lead_facts(lead(owner_name="Carlos Ramirez"), "")
    assert facts["owner_first_name"] == "Carlos" and "Ramirez" not in str(facts)
    assert lead_facts(lead(), "Alan")["owner_first_name"] is None
