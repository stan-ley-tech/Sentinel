"""SQLite storage for the Sentinel control plane.

The connection to the real on-disk database is created lazily, on first
use, so importing this module (or `app.main`) never has the side effect of
touching disk — tests override the `get_db` FastAPI dependency with an
in-memory connection instead of ever calling into `Database`.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS roles (
    name TEXT PRIMARY KEY,
    permissions TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL REFERENCES roles(name),
    signing_secret TEXT NOT NULL,
    rate_limit_per_second REAL,
    rate_limit_burst INTEGER,
    quota_limit INTEGER,
    quota_period TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    path_prefix TEXT NOT NULL,
    upstreams TEXT NOT NULL,
    strip_prefix INTEGER NOT NULL DEFAULT 0,
    auth_required INTEGER NOT NULL DEFAULT 1,
    required_permission TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_rules (
    id TEXT PRIMARY KEY,
    cidr TEXT NOT NULL,
    action TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
"""


def create_connection(path: str) -> sqlite3.Connection:
    """Open (creating if necessary) a Sentinel control-plane database.
    Use ":memory:" for an ephemeral store (tests)."""
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


class Database:
    """Lazily-created singleton connection to the real on-disk database,
    used by the app in production. Tests never touch this — they override
    the get_db dependency directly with their own in-memory connection."""

    _conn: sqlite3.Connection | None = None

    @classmethod
    def connection(cls) -> sqlite3.Connection:
        if cls._conn is None:
            path = os.environ.get("SENTINEL_DB_PATH", "sentinel.db")
            cls._conn = create_connection(path)
        return cls._conn


def get_db() -> Iterator[sqlite3.Connection]:
    yield Database.connection()
