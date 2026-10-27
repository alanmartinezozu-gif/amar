import pytest

from daily_leads.config import City, ConfigError, load_settings
from daily_leads.export import split_name
from daily_leads.normalize import clean_website, dedupe_domain, is_social, state_abbrev, to_e164


@pytest.mark.parametrize("raw, expected", [
    ("+1 713-555-0142", "+17135550142"),
    ("(210) 555-0199", "+12105550199"),
    ("1.602.555.0100", "+16025550100"),
    ("713555014", ""),
    ("+44 20 7946 0958", ""),
    ("(013) 555-0142", ""),
    (None, ""),
])
def test_e164(raw, expected):
    assert to_e164(raw) == expected


def test_state_abbrev():
    assert state_abbrev("Texas") == "TX"
    assert state_abbrev("az") == "AZ"
    assert state_abbrev("Nowhere") == ""


def test_websites():
    assert clean_website("abcroofing.com") == "http://abcroofing.com/"
    assert clean_website("https://www.ABCroofing.com/?utm_source=gmb&utm_medium=organic") == "https://www.abcroofing.com/"
    assert clean_website("https://abc.com/houston?location=2&gclid=x#top") == "https://abc.com/houston?location=2"
    assert dedupe_domain("https://www.abcroofing.com/houston") == "abcroofing.com"
    assert dedupe_domain("https://joesroofing.wixsite.com/home") == ""
    assert dedupe_domain("https://www.facebook.com/joesroofing") == ""
    assert is_social("https://m.facebook.com/joesroofing")
    assert not is_social("https://joesroofing.com")


@pytest.mark.parametrize("full, first, last", [
    ("John Smith", "John", "Smith"),
    ("John A. Smith", "John", "Smith"),
    ("Rick Davis Jr.", "Rick", "Davis Jr."),
    ("Mike", "Mike", ""),
    ("", "", ""),
])
def test_split_name(full, first, last):
    assert split_name(full) == (first, last)


def test_city_parse():
    assert City.parse("Houston, TX") == City("Houston", "TX")
    assert City.parse("San Antonio TX") == City("San Antonio", "TX")
    assert City.parse("Houston, TX").query("roofing") == "roofing in Houston, TX"
    with pytest.raises(ConfigError):
        City.parse("Houston")


def test_settings_load_keys_from_env_file(tmp_path, monkeypatch):
    for key in ("OUTSCRAPER_API_KEY", "HUNTER_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    (tmp_path / "config.yaml").write_text("trades: [roofing, HVAC]\ncities: [Houston TX]\nleads_per_day: 50\n")
    (tmp_path / ".env").write_text("OUTSCRAPER_API_KEY=o-key\nANTHROPIC_API_KEY=a-key\n")
    s = load_settings(tmp_path / "config.yaml", trades=["roofing"], limit=10)
    assert s.trades == ["roofing"] and s.leads_per_day == 10
    assert s.cities == [City("Houston", "TX")]
    assert (s.outscraper_api_key, s.anthropic_api_key, s.hunter_api_key) == ("o-key", "a-key", "")
    assert s.history_file == tmp_path / "leads_history.csv"


def test_bad_page_size_rejected(tmp_path):
    (tmp_path / "config.yaml").write_text("trades: [roofing]\ncities: ['Houston, TX']\nsourcing: {page_size: 30}\n")
    with pytest.raises(ConfigError, match="page_size"):
        load_settings(tmp_path / "config.yaml")


def test_flow_style_city_list_explains_fix(tmp_path):
    (tmp_path / "config.yaml").write_text("trades: [roofing]\ncities: [Houston, TX]\n")
    with pytest.raises(ConfigError, match="own line"):
        load_settings(tmp_path / "config.yaml")


def test_shipped_config_loads():
    from pathlib import Path
    s = load_settings(Path(__file__).parent.parent / "config.yaml")
    assert s.trades == ["roofing", "HVAC"]
    assert [c.label for c in s.cities] == ["Houston, TX", "San Antonio, TX", "Dallas, TX", "Phoenix, AZ"]
    assert (s.leads_per_day, s.min_reviews, s.max_reviews) == (50, 10, 300)
