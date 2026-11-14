"""Paths and environment settings. Everything secret comes from .env."""
from __future__ import annotations

import os
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

CONFIG_DIR = ROOT / "config"
CLIENTS_DIR = CONFIG_DIR / "clients"
DATA_DIR = ROOT / "data"
DOCS_DIR = DATA_DIR / "docs"
RULES_PATH = CONFIG_DIR / "wyoming_rules.md"
SOURCES_PATH = CONFIG_DIR / "sources.yaml"

TZ = ZoneInfo("America/Denver")

FOOTER = (
    "Prices and submission are your responsibility. "
    "Always verify against the official bid documents."
)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def db_path() -> Path:
    p = env("BIDDESK_DB")
    return Path(p) if p else DATA_DIR / "biddesk.db"


def brief_model() -> str:
    return env("BRIEF_MODEL", "claude-fable-5-2")


def triage_model() -> str:
    return env("TRIAGE_MODEL", "claude-haiku-5-5")


def max_briefs_per_run() -> int:
    return int(env("MAX_BRIEFS_PER_RUN", "10") or 10)


def user_agent() -> str:
    contact = env("CONTACT_EMAIL")
    return f"BidDeskBot/0.1 (public bid notices; contact {contact})" if contact else "BidDeskBot/0.1 (public bid notices)"
