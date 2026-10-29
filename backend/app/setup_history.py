"""Persistent server-side recording of valid setups.

Requires DATABASE_URL pointing to a persistent PostgreSQL database. No browser
state or ephemeral local file is used as the source of truth.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row


def database_configured() -> bool:
    return bool(os.getenv("DATABASE_URL", "").strip())


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not configured; persistent setup history is disabled.")
    # Render may provide postgres://; psycopg accepts postgresql:// consistently.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


def initialize_history_store() -> None:
    if not database_configured():
        return
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_setup_history (
                id BIGSERIAL PRIMARY KEY,
                signal_key TEXT NOT NULL UNIQUE,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
                signal_time TIMESTAMPTZ NOT NULL,
                detected_at TIMESTAMPTZ NOT NULL,
                entry DOUBLE PRECISION NOT NULL,
                stop_loss DOUBLE PRECISION NOT NULL,
                take_profits JSONB NOT NULL,
                rr JSONB,
                confidence INTEGER,
                trend TEXT,
                reasons JSONB NOT NULL,
                invalidation TEXT,
                provider TEXT,
                status TEXT NOT NULL DEFAULT 'DETECTED'
            )
        """)
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS trade_type TEXT NOT NULL DEFAULT 'TECHNICAL TRADE'")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS news_context JSONB")
        conn.execute("CREATE INDEX IF NOT EXISTS goldsight_setup_detected_at_idx ON goldsight_setup_history (detected_at DESC)")
        conn.commit()


def record_setup(symbol: str, timeframe: str, market_data: dict[str, Any]) -> bool:
    """Insert one genuinely observed, fresh BUY/SELL setup; duplicate candles are ignored."""
    signal = market_data.get("signal") or {}
    if market_data.get("status") != "LIVE" or signal.get("status") not in {"BUY", "SELL"}:
        return False
    if signal.get("signal_fresh") is not True:
        return False
    signal_time = signal.get("signal_time")
    entry, stop_loss = signal.get("entry"), signal.get("stop_loss")
    take_profits = signal.get("take_profits")
    if not signal_time or entry is None or stop_loss is None or not isinstance(take_profits, list) or not take_profits:
        return False
    try:
        parsed_signal_time = datetime.fromisoformat(signal_time.replace("Z", "+00:00"))
        if parsed_signal_time.tzinfo is None:
            parsed_signal_time = parsed_signal_time.replace(tzinfo=timezone.utc)
        parsed_signal_time = parsed_signal_time.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return False
    side = signal["status"]
    key = f"{symbol}:{timeframe}:{side}:{parsed_signal_time.isoformat()}"
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        result = conn.execute("""
            INSERT INTO goldsight_setup_history (
                signal_key, symbol, timeframe, side, signal_time, detected_at,
                entry, stop_loss, take_profits, rr, confidence, trend, reasons,
                invalidation, provider, trade_type, news_context
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s,
                %s::jsonb, %s, %s, %s, %s::jsonb
            )
            ON CONFLICT (signal_key) DO NOTHING
            RETURNING id
        """, (
            key, symbol, timeframe, side, parsed_signal_time, datetime.now(timezone.utc),
            float(entry), float(stop_loss), json.dumps(take_profits),
            json.dumps(signal.get("rr")) if signal.get("rr") is not None else None,
            signal.get("confidence"), signal.get("trend"),
            json.dumps(signal.get("reasons") or []), signal.get("invalidation"),
            market_data.get("provider"),
            signal.get("trade_type", "TECHNICAL TRADE"),
            json.dumps(signal.get("news_context")) if signal.get("news_context") is not None else None,
        ))
        conn.commit()
        return result.fetchone() is not None


def list_setups(limit: int = 50) -> list[dict[str, Any]]:
    if not database_configured():
        return []
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        rows = conn.execute("""
            SELECT id, symbol, timeframe, side, signal_time, detected_at, entry,
                   stop_loss, take_profits, rr, confidence, trend, reasons,
                   invalidation, provider, status, trade_type, news_context
            FROM goldsight_setup_history
            ORDER BY detected_at DESC
            LIMIT %s
        """, (max(1, min(limit, 200)),)).fetchall()
    for row in rows:
        row["signal_time"] = row["signal_time"].isoformat()
        row["detected_at"] = row["detected_at"].isoformat()
    return rows
