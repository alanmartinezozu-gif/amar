import logging

import anthropic
import outscraper
import requests

from daily_leads.cli import main

from .test_pipeline import world


def test_cli_end_to_end(tmp_path, monkeypatch, capsys):
    (tmp_path / "config.yaml").write_text(
        "trades: [roofing, HVAC]\ncities: ['Dallas, TX']\nsender_name: Alan\ncrawler: {delay_seconds: 0}\n")
    (tmp_path / ".env").write_text("OUTSCRAPER_API_KEY=o\nANTHROPIC_API_KEY=a\nHUNTER_API_KEY=h\n")
    for key in ("OUTSCRAPER_API_KEY", "ANTHROPIC_API_KEY", "HUNTER_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    fake = world()
    fake.outscraper.places_by_query = {"roofing in Houston, TX": fake.outscraper.places_by_query.popitem()[1]}
    monkeypatch.setattr(outscraper, "OutscraperClient", lambda api_key: fake.outscraper)
    monkeypatch.setattr(requests, "Session", lambda: fake.http)
    monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: fake.claude)

    root = logging.getLogger()
    before = list(root.handlers)
    try:
        code = main(["--config", str(tmp_path / "config.yaml"), "--trade", "roofing",
                     "--city", "Houston, TX", "--limit", "3", "--date", "2026-10-27"])
    finally:
        for h in root.handlers[len(before):]:
            root.removeHandler(h)
            h.close()

    out = capsys.readouterr().out
    assert code == 0
    assert "3 leads ready for GoHighLevel" in out
    assert out.count("Sample DM") == 3
    assert "Nothing was sent" in out
    assert (tmp_path / "output" / "ghl_import_2026-10-27.csv").exists()
    assert (tmp_path / "leads_history.csv").exists()
    assert '"sender_name": "Alan"' in fake.claude.calls[0]["messages"][0]["content"]


def test_cli_missing_keys(tmp_path, monkeypatch, capsys):
    (tmp_path / "config.yaml").write_text("trades: [roofing]\ncities:\n  - Dallas, TX\n")
    for key in ("OUTSCRAPER_API_KEY", "ANTHROPIC_API_KEY", "HUNTER_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    assert main(["--config", str(tmp_path / "config.yaml")]) == 2
    assert "OUTSCRAPER_API_KEY, ANTHROPIC_API_KEY" in capsys.readouterr().err
