"""Polite page fetching: robots.txt, per-site delay, size limit, cache."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import UnicodeDammit

from .cache import Cache
from .config import Crawler

log = logging.getLogger(__name__)

MAX_REDIRECTS = 5
FAILED_PAGE_TTL_DAYS = 1  # retry broken sites tomorrow, not on every rerun today


@dataclass
class Page:
    url: str
    final_url: str = ""
    status: int = 0
    html: str = ""
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and 200 <= self.status < 300 and bool(self.html)


class Fetcher:
    def __init__(self, session: requests.Session, cache: Cache, crawler: Crawler):
        self.session = session
        self.cache = cache
        self.cfg = crawler
        self._robots: dict[str, RobotFileParser | None] = {}
        self._robots_lock = threading.Lock()
        self._host_locks: dict[str, threading.Lock] = {}
        self._last_hit: dict[str, float] = {}
        self._locks_lock = threading.Lock()

    # -- robots.txt -------------------------------------------------------

    def _origin(self, url: str) -> str:
        parts = urlsplit(url)
        return f"{parts.scheme}://{parts.netloc}".lower()

    def _robots_for(self, origin: str) -> RobotFileParser | None:
        """Parsed robots.txt; None means "don't crawl this site at all"."""
        with self._robots_lock:
            if origin in self._robots:
                return self._robots[origin]
        cached = self.cache.get("robots", origin, ttl_days=7)
        if cached is None:
            cached = self._download_robots(origin)
            self.cache.set("robots", origin, cached)
        if cached["mode"] == "rules":
            parser = RobotFileParser()
            parser.parse(cached["text"].splitlines())
        elif cached["mode"] == "allow_all":
            parser = RobotFileParser()
            parser.parse([])
        else:
            parser = None
        with self._robots_lock:
            self._robots[origin] = parser
        return parser

    def _download_robots(self, origin: str) -> dict:
        # RFC 9309: a 4xx means no rules; an unreachable or 5xx robots.txt
        # means assume everything is disallowed. 401/403 are treated as a
        # "keep out" as well, like Python's own robotparser does.
        url = origin + "/robots.txt"
        try:
            self._wait_turn(url, None)
            resp = self.session.get(url, headers=self._headers(), timeout=self.cfg.timeout_seconds,
                                    allow_redirects=True)
        except requests.RequestException as e:
            return {"mode": "disallow_all", "reason": f"robots.txt unreachable: {type(e).__name__}"}
        if resp.status_code in (401, 403):
            return {"mode": "disallow_all", "reason": f"robots.txt returned {resp.status_code}"}
        if 400 <= resp.status_code < 500:
            return {"mode": "allow_all"}
        if resp.status_code >= 500:
            return {"mode": "disallow_all", "reason": f"robots.txt returned {resp.status_code}"}
        return {"mode": "rules", "text": resp.text[:500_000]}

    def allowed(self, url: str) -> bool:
        parser = self._robots_for(self._origin(url))
        return parser is not None and parser.can_fetch(self.cfg.robots_token, url)

    def _crawl_delay(self, url: str) -> float:
        parser = self._robots_for(self._origin(url))
        delay = parser.crawl_delay(self.cfg.robots_token) if parser else None
        return max(self.cfg.delay_seconds, float(delay or 0))

    # -- rate limiting ----------------------------------------------------

    def _wait_turn(self, url: str, delay: float | None) -> None:
        host = (urlsplit(url).hostname or "").lower()
        with self._locks_lock:
            lock = self._host_locks.setdefault(host, threading.Lock())
        with lock:
            wait = (delay if delay is not None else self.cfg.delay_seconds) - (time.monotonic() - self._last_hit.get(host, -1e9))
            if wait > 0:
                time.sleep(wait)
            self._last_hit[host] = time.monotonic()

    def _headers(self) -> dict:
        return {"User-Agent": self.cfg.user_agent, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
                "Accept-Language": "en-US,en;q=0.8,es;q=0.6"}

    # -- pages ------------------------------------------------------------

    def fetch(self, url: str) -> Page:
        cached = self.cache.get("page", url)
        if cached is not None:
            page = Page(**cached)
            if page.ok or self.cache.get("page", url, ttl_days=FAILED_PAGE_TTL_DAYS) is not None:
                return page
        page = self._fetch_live(url)
        self.cache.set("page", url, asdict(page))
        return page

    def _fetch_live(self, url: str) -> Page:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            if urlsplit(current).scheme not in ("http", "https"):
                return Page(url, current, error="not an http(s) URL")
            if not self.allowed(current):
                return Page(url, current, error="blocked by robots.txt")
            self._wait_turn(current, self._crawl_delay(current))
            try:
                resp = self.session.get(current, headers=self._headers(), timeout=self.cfg.timeout_seconds,
                                        allow_redirects=False, stream=True)
            except requests.RequestException as e:
                return Page(url, current, error=f"{type(e).__name__}: {e}"[:300])
            try:
                if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("Location"):
                    current = urljoin(current, resp.headers["Location"])
                    continue
                if not 200 <= resp.status_code < 300:
                    return Page(url, current, resp.status_code, error=f"HTTP {resp.status_code}")
                ctype = resp.headers.get("Content-Type", "text/html").lower()
                if "html" not in ctype and "text/plain" not in ctype:
                    return Page(url, current, resp.status_code, error=f"not a web page ({ctype})")
                body = bytearray()
                for chunk in resp.iter_content(65536):
                    body.extend(chunk)
                    if len(body) >= self.cfg.max_bytes:
                        break
                declared = [resp.encoding] if "charset" in ctype and resp.encoding else []
                html = UnicodeDammit(bytes(body), declared).unicode_markup or ""
                return Page(url, current, resp.status_code, html)
            except requests.RequestException as e:
                return Page(url, current, error=f"{type(e).__name__}: {e}"[:300])
            finally:
                resp.close()
        return Page(url, current, error="too many redirects")
