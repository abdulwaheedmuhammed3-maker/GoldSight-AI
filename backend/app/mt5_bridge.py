"""Authenticated, read-only MT5 companion device registry.

Device tokens are returned once at pairing and stored only as SHA-256 hashes.
No broker passwords or trade commands are accepted by this module.
"""
from __future__ import annotations

import hashlib
import math
import os
import secrets
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

from app.setup_history import database_configured, _database_url


def _admin_key() -> str:
    value = os.getenv("MT5_BRIDGE_ADMIN_KEY", "").strip()
    if len(value) < 32:
        raise RuntimeError("MT5_BRIDGE_ADMIN_KEY must be configured with at least 32 characters.")
    return value


def initialize_bridge_store() -> None:
    if not database_configured():
        return
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tradesight_mt5_devices (
                id BIGSERIAL PRIMARY KEY,
                device_id TEXT NOT NULL UNIQUE,
                device_name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TIMESTAMPTZ NOT NULL,
                last_seen_at TIMESTAMPTZ,
                last_snapshot JSONB,
                revoked_at TIMESTAMPTZ
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS tradesight_mt5_devices_seen_idx ON tradesight_mt5_devices(last_seen_at DESC)")
        conn.commit()


def pair_device(admin_key: str, device_name: str) -> dict[str, Any]:
    configured = _admin_key()
    if not secrets.compare_digest(admin_key, configured):
        raise PermissionError("Bridge pairing authorization failed.")
    if not database_configured():
        raise RuntimeError("Persistent device pairing requires DATABASE_URL.")
    name = device_name.strip()[:80]
    if not name:
        raise ValueError("A device name is required.")
    device_id = secrets.token_urlsafe(18)
    token = secrets.token_urlsafe(40)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute(
            """INSERT INTO tradesight_mt5_devices
               (device_id, device_name, token_hash, created_at)
               VALUES (%s, %s, %s, %s)""",
            (device_id, name, token_hash, now),
        )
        conn.commit()
    return {
        "status": "paired",
        "device_id": device_id,
        "device_name": name,
        "device_token": token,
        "token_storage": "Only a SHA-256 hash is stored by the server. Copy this token now; it cannot be retrieved later.",
        "read_only": True,
        "order_execution_enabled": False,
    }


def _device_for_token(token: str) -> dict[str, Any] | None:
    if not token or len(token) > 256 or not database_configured():
        return None
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        return conn.execute(
            """SELECT device_id, device_name FROM tradesight_mt5_devices
               WHERE token_hash=%s AND revoked_at IS NULL""",
            (digest,),
        ).fetchone()


def _safe_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    def text_field(key: str, max_len: int = 100) -> str:
        value = payload.get(key, "")
        if not isinstance(value, str):
            raise ValueError(f"{key} must be text.")
        return value.strip()[:max_len]

    def number_field(key: str, required: bool = False) -> float | None:
        value = payload.get(key)
        if value is None and not required:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{key} must be numeric.")
        result = float(value)
        if not math.isfinite(result) or abs(result) > 1e15:
            raise ValueError(f"{key} is outside the accepted range.")
        return result

    positions = payload.get("open_positions")
    if isinstance(positions, bool) or not isinstance(positions, int) or not 0 <= positions <= 100000:
        raise ValueError("open_positions must be an integer between 0 and 100000.")
    connected = payload.get("connected")
    if not isinstance(connected, bool):
        raise ValueError("connected must be boolean.")

    snapshot: dict[str, Any] = {
        "broker": text_field("broker"),
        "server": text_field("server"),
        "account_login": text_field("account_login", 40),
        "account_currency": text_field("account_currency", 12),
        "leverage": number_field("leverage"),
        "terminal": text_field("terminal"),
        "terminal_build": text_field("terminal_build", 30),
        "connected": connected,
        "open_positions": positions,
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
    # Financial figures are accepted only when explicitly sent by the terminal.
    for key in ("balance", "equity", "free_margin"):
        value = number_field(key)
        if value is not None:
            snapshot[key] = value
    return snapshot


def record_heartbeat(token: str, payload: dict[str, Any]) -> dict[str, Any]:
    device = _device_for_token(token)
    if not device:
        raise PermissionError("Unknown, revoked or invalid bridge token.")
    snapshot = _safe_snapshot(payload)
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute(
            """UPDATE tradesight_mt5_devices
               SET last_seen_at=%s, last_snapshot=%s::jsonb
               WHERE device_id=%s AND revoked_at IS NULL""",
            (datetime.now(timezone.utc), __import__("json").dumps(snapshot), device["device_id"]),
        )
        conn.commit()
    return {"status": "received", "device_id": device["device_id"], "read_only": True}


def list_devices() -> list[dict[str, Any]]:
    if not database_configured():
        raise RuntimeError("Persistent device registry requires DATABASE_URL.")
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        rows = conn.execute(
            """SELECT device_id, device_name, created_at, last_seen_at,
                      last_snapshot, revoked_at
               FROM tradesight_mt5_devices ORDER BY created_at DESC LIMIT 100"""
        ).fetchall()
    return [dict(row) for row in rows]


def revoke_device(admin_key: str, device_id: str) -> bool:
    if not secrets.compare_digest(admin_key, _admin_key()):
        raise PermissionError("Bridge administration authorization failed.")
    if not database_configured():
        raise RuntimeError("Persistent device registry requires DATABASE_URL.")
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        result = conn.execute(
            """UPDATE tradesight_mt5_devices SET revoked_at=%s
               WHERE device_id=%s AND revoked_at IS NULL""",
            (datetime.now(timezone.utc), device_id),
        )
        conn.commit()
        return result.rowcount > 0


def device_status(token: str) -> dict[str, Any]:
    device = _device_for_token(token)
    if not device:
        raise PermissionError("Unknown, revoked or invalid bridge token.")
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        row = conn.execute(
            """SELECT device_name, created_at, last_seen_at, last_snapshot
               FROM tradesight_mt5_devices
               WHERE device_id=%s AND revoked_at IS NULL""",
            (device["device_id"],),
        ).fetchone()
    if not row:
        raise PermissionError("This bridge device has been revoked.")
    return {
        "status": "paired",
        "device_id": device["device_id"],
        "device_name": row["device_name"],
        "created_at": row["created_at"],
        "last_seen_at": row["last_seen_at"],
        "snapshot": row["last_snapshot"],
        "read_only": True,
        "order_execution_enabled": False,
    }
