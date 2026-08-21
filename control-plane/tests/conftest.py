from __future__ import annotations

import sqlite3
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.auth import ADMIN_TOKEN, INTERNAL_TOKEN
from app.db import create_connection, get_db
from app.main import app


@pytest.fixture()
def admin_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {ADMIN_TOKEN}"}


@pytest.fixture()
def internal_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


@pytest.fixture()
def db_conn() -> Iterator[sqlite3.Connection]:
    conn = create_connection(":memory:")
    yield conn
    conn.close()


@pytest.fixture()
def client(db_conn: sqlite3.Connection) -> Iterator[TestClient]:
    def override_get_db() -> Iterator[sqlite3.Connection]:
        yield db_conn

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
