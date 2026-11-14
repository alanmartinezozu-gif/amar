"""Polite HTTP: robots.txt, per-domain rate limit, conditional requests, cache.

Rules (BUILD_SPEC section 3): identify ourselves, at most one request every 3 seconds per
domain (or the site's Crawl-delay if longer), never log in, never get around a block.
"""
from __future__ import annotations

import hashlib
import sqlite3
import time
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from . import db, settings

MIN_DELAY = 3.0
MAX_BYTES = 60 * 1024 * 1024


class Blocked(Exception):
    """robots.txt disallows this URL, or the site refused us. We do not work around it."""


@dataclass
class Page:
    url: str
    body: bytes
    content_type: str
    sha256: str
    changed: bool  # False when the server said 304 or the bytes are identical to last time

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class Fetcher:
    def __init__(self, conn: sqlite3.Connection, client: httpx.Client | None = None, sleep=time.sleep):
        self.conn = conn
        self.ua = settings.user_agent()
        self.client = client or httpx.Client(
            headers={"User-Agent": self.ua}, follow_redirects=True, timeout=45.0)
        self._sleep = sleep
        self._last: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    # --- robots -----------------------------------------------------------
    def _robots_for(self, url: str):
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            rp: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
            try:
                self._wait(parts.netloc, MIN_DELAY)
                r = self.client.get(origin + "/robots.txt")
                if r.status_code == 429 or r.status_code >= 500:
                    rp.disallow_all = True  # site is struggling or rate-limiting: stay away
                elif r.status_code >= 400:
                    rp = None  # no robots.txt (file hosts often answer 403/404): nothing is disallowed
                else:
                    rp.parse(r.text.splitlines())
            except httpx.HTTPError:
                rp = None  # robots.txt unreachable (often a redirect off-site): treat as absent
            self._robots[origin] = rp
        return self._robots[origin]

    def _wait(self, host: str, delay: float) -> None:
        last = self._last.get(host)
        if last is not None:
            gap = time.monotonic() - last
            if gap < delay:
                self._sleep(delay - gap)
        self._last[host] = time.monotonic()

    # --- fetch ------------------------------------------------------------
    def get(self, url: str) -> Page:
        host = urlsplit(url).netloc
        rp = self._robots_for(url)
        delay = MIN_DELAY
        if rp is not None:
            if not rp.can_fetch(self.ua, url):
                raise Blocked(f"robots.txt disallows {url}")
            delay = max(delay, float(rp.crawl_delay(self.ua) or 0))
        cached = self.conn.execute("SELECT * FROM http_cache WHERE url=?", (url,)).fetchone()
        headers = {}
        if cached:
            if cached["etag"]:
                headers["If-None-Match"] = cached["etag"]
            if cached["last_modified"]:
                headers["If-Modified-Since"] = cached["last_modified"]
        self._wait(host, delay)
        r = self.client.get(url, headers=headers)
        if r.status_code == 304 and cached:
            return Page(url, cached["body"], cached["content_type"] or "", cached["sha256"], False)
        if r.status_code in (401, 403, 407, 429):
            raise Blocked(f"{url} answered HTTP {r.status_code}")
        r.raise_for_status()
        body = r.content
        if len(body) > MAX_BYTES:
            raise ValueError(f"{url} is larger than {MAX_BYTES} bytes")
        sha = hashlib.sha256(body).hexdigest()
        changed = not cached or cached["sha256"] != sha
        self.conn.execute(
            "INSERT OR REPLACE INTO http_cache(url,etag,last_modified,sha256,body,content_type,fetched_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (url, r.headers.get("etag"), r.headers.get("last-modified"), sha, body,
             r.headers.get("content-type", ""), db.now()))
        self.conn.commit()
        return Page(url, body, r.headers.get("content-type", ""), sha, changed)
