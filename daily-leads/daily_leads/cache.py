"""SQLite key/value cache so reruns reuse paid API calls and fetched pages."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path


class Cache:
    def __init__(self, path: Path, ttl_days: dict[str, float]):
        """ttl_days maps a namespace to how long its entries stay fresh."""
        path.parent.mkdir(parents=True, exist_ok=True)
        self._ttl = ttl_days
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS entries ("
            " namespace TEXT NOT NULL, key_hash TEXT NOT NULL, key TEXT NOT NULL,"
            " value TEXT NOT NULL, stored_at REAL NOT NULL,"
            " PRIMARY KEY (namespace, key_hash))"
        )
        self._db.commit()

    @staticmethod
    def _hash(key: str) -> str:
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    def get(self, namespace: str, key: str, ttl_days: float | None = None):
        """Cached value, or None if missing or older than the namespace TTL."""
        with self._lock:
            row = self._db.execute(
                "SELECT value, stored_at FROM entries WHERE namespace = ? AND key_hash = ?",
                (namespace, self._hash(key)),
            ).fetchone()
        if row is None:
            return None
        ttl = ttl_days if ttl_days is not None else self._ttl.get(namespace)
        if ttl is not None and time.time() - row[1] > ttl * 86400:
            return None
        return json.loads(row[0])

    def set(self, namespace: str, key: str, value) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?, ?)",
                (namespace, self._hash(key), key, json.dumps(value), time.time()),
            )
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()
