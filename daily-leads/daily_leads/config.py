"""Load config.yaml and the API keys from .env."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class City:
    name: str
    state: str

    @classmethod
    def parse(cls, text: str) -> "City":
        """Accepts "Houston, TX" or "Houston TX"."""
        text = str(text).strip()
        match = re.fullmatch(r"(.+?)[,\s]+([A-Za-z]{2})", text)
        if not match:
            raise ConfigError(f'City "{text}" must look like "Houston, TX". In config.yaml put each city '
                              f'on its own line: - Houston, TX')
        return cls(match.group(1).strip(), match.group(2).upper())

    @property
    def label(self) -> str:
        return f"{self.name}, {self.state}"

    @property
    def tag(self) -> str:
        return self.name.lower()

    def query(self, trade: str) -> str:
        return f"{trade} in {self.label}"


@dataclass
class Sourcing:
    page_size: int = 40
    max_pages_per_query: int = 10
    candidate_multiplier: float = 3


@dataclass
class Crawler:
    user_agent: str = "Mozilla/5.0 (compatible; daily-leads/1.0; public business contact lookup)"
    robots_token: str = "daily-leads"
    delay_seconds: float = 1.5
    timeout_seconds: float = 15
    concurrency: int = 8
    max_bytes: int = 2_000_000


@dataclass
class ClaudeSettings:
    model: str = "claude-opus-5-5"
    effort: str = "medium"
    concurrency: int = 4


@dataclass
class HunterSettings:
    enabled: bool = True
    min_confidence: int = 50


@dataclass
class CacheSettings:
    dir: str = ".cache"
    outscraper_days: float = 30
    pages_days: float = 14
    hunter_days: float = 60
    claude_days: float = 30


@dataclass
class Settings:
    trades: list[str]
    cities: list[City]
    leads_per_day: int = 50
    min_reviews: int = 10
    max_reviews: int = 300
    sender_name: str = ""
    sourcing: Sourcing = field(default_factory=Sourcing)
    crawler: Crawler = field(default_factory=Crawler)
    claude: ClaudeSettings = field(default_factory=ClaudeSettings)
    hunter: HunterSettings = field(default_factory=HunterSettings)
    cache: CacheSettings = field(default_factory=CacheSettings)
    base_dir: Path = Path(".")
    history_file: Path = Path("leads_history.csv")
    output_dir: Path = Path("output")
    log_dir: Path = Path("logs")
    outscraper_api_key: str = ""
    hunter_api_key: str = ""
    anthropic_api_key: str = ""

    @property
    def cache_path(self) -> Path:
        return self.base_dir / self.cache.dir / "cache.sqlite3"


def _section(cls, data: dict | None):
    data = data or {}
    known = {f for f in cls.__dataclass_fields__}
    unknown = set(data) - known
    if unknown:
        raise ConfigError(f"Unknown setting(s) in config.yaml: {', '.join(sorted(unknown))}")
    return cls(**data)


def load_settings(config_path: Path, *, trades: list[str] | None = None,
                  cities: list[str] | None = None, limit: int | None = None) -> Settings:
    """Read config.yaml (CLI overrides win) and the keys from .env next to it."""
    config_path = config_path.resolve()
    if not config_path.exists():
        raise ConfigError(f"Config file not found: {config_path}")
    raw = yaml.safe_load(config_path.read_text()) or {}
    base = config_path.parent
    load_dotenv(base / ".env")

    paths = raw.get("paths") or {}
    settings = Settings(
        trades=[str(t).strip() for t in (trades or raw.get("trades") or []) if str(t).strip()],
        cities=[City.parse(c) for c in (cities or raw.get("cities") or [])],
        leads_per_day=int(limit or raw.get("leads_per_day", 50)),
        min_reviews=int(raw.get("min_reviews", 10)),
        max_reviews=int(raw.get("max_reviews", 300)),
        sender_name=str(raw.get("sender_name") or "").strip(),
        sourcing=_section(Sourcing, raw.get("sourcing")),
        crawler=_section(Crawler, raw.get("crawler")),
        claude=_section(ClaudeSettings, raw.get("claude")),
        hunter=_section(HunterSettings, raw.get("hunter")),
        cache=_section(CacheSettings, raw.get("cache")),
        base_dir=base,
        history_file=base / paths.get("history_file", "leads_history.csv"),
        output_dir=base / paths.get("output_dir", "output"),
        log_dir=base / paths.get("log_dir", "logs"),
        outscraper_api_key=os.environ.get("OUTSCRAPER_API_KEY", "").strip(),
        hunter_api_key=os.environ.get("HUNTER_API_KEY", "").strip(),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", "").strip(),
    )
    _validate(settings)
    return settings


def _validate(s: Settings) -> None:
    if not s.trades:
        raise ConfigError("config.yaml needs at least one trade")
    if not s.cities:
        raise ConfigError("config.yaml needs at least one city")
    if s.leads_per_day < 1:
        raise ConfigError("leads_per_day must be at least 1")
    if s.min_reviews > s.max_reviews:
        raise ConfigError("min_reviews can't be larger than max_reviews")
    if s.sourcing.page_size < 20 or s.sourcing.page_size % 20:
        raise ConfigError("sourcing.page_size must be a multiple of 20 (Outscraper pages by 20)")
    if s.claude.effort not in {"low", "medium", "high", "xhigh", "max"}:
        raise ConfigError("claude.effort must be low, medium, high, xhigh or max")


def require_keys(s: Settings) -> list[str]:
    """Names of required keys missing from .env."""
    missing = []
    if not s.outscraper_api_key:
        missing.append("OUTSCRAPER_API_KEY")
    if not s.anthropic_api_key:
        missing.append("ANTHROPIC_API_KEY")
    return missing
