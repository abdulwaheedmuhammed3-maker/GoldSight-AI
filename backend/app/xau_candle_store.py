"""Persistent storage for SiftingIO-derived XAUUSD candles."""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

from app.setup_history import database_configured, _database_url

LOGGER = logging.getLogger("goldsight.xau_candle_store")
TIMEFRAMES = ("5m", "15m", "30m", "1h", "4h")


def initialize_xau_candle_store() -> dict[str, Any]:
    if not database_configured():
        LOGGER.warning("XAU candle persistence disabled: DATABASE_URL is not configured.")
        return {"enabled": False, "restored": 0, "reason": "DATABASE_URL_NOT_CONFIGURED"}
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_xau_live_candles (
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL CHECK (timeframe IN ('5m','15m','30m','1h','4h')),
                candle_time BIGINT NOT NULL,
                open DOUBLE PRECISION NOT NULL,
                high DOUBLE PRECISION NOT NULL,
                low DOUBLE PRECISION NOT NULL,
                close DOUBLE PRECISION NOT NULL,
                tick_count INTEGER NOT NULL CHECK (tick_count > 0),
                source TEXT NOT NULL,
                completed_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (symbol, timeframe, candle_time),
                CHECK (high >= low),
                CHECK (high >= open AND high >= close),
                CHECK (low <= open AND low <= close)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS goldsight_xau_live_candles_recent_idx
            ON goldsight_xau_live_candles (symbol, timeframe, candle_time DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_xau_active_candles (
                timeframe TEXT PRIMARY KEY CHECK (timeframe IN ('5m','15m','30m','1h','4h')),
                candle_time BIGINT NOT NULL,
                open DOUBLE PRECISION NOT NULL,
                high DOUBLE PRECISION NOT NULL,
                low DOUBLE PRECISION NOT NULL,
                close DOUBLE PRECISION NOT NULL,
                tick_count INTEGER NOT NULL CHECK (tick_count > 0),
                last_tick_ms BIGINT NOT NULL,
                source TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                CHECK (high >= low),
                CHECK (high >= open AND high >= close),
                CHECK (low <= open AND low <= close)
            )
        """)
        conn.commit()
    restored = 0
    return {"enabled": True, "restored": restored, "reason": None}


def save_completed_candle(timeframe: str, candle: dict[str, Any]) -> bool:
    if timeframe not in TIMEFRAMES or not database_configured():
        return False
    if candle.get("closed") is not True or candle.get("signal_eligible") is not True or int(candle.get("tick_count", 0)) < 1:
        return False
    values = (
        "XAUUSD", timeframe, int(candle["time"]),
        float(candle["open"]), float(candle["high"]),
        float(candle["low"]), float(candle["close"]),
        int(candle["tick_count"]),
        str(candle.get("source", "SiftingIO WebSocket com ticks")),
        datetime.now(timezone.utc),
    )
    with psycopg.connect(_database_url(), connect_timeout=5) as conn:
        conn.execute("""
            INSERT INTO goldsight_xau_live_candles
                (symbol,timeframe,candle_time,open,high,low,close,tick_count,source,completed_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (symbol,timeframe,candle_time) DO UPDATE SET
                open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                close=EXCLUDED.close, tick_count=EXCLUDED.tick_count,
                source=EXCLUDED.source, completed_at=EXCLUDED.completed_at
        """, values)
    return True


def load_recent_candles(limit_per_timeframe: int = 500) -> dict[str, list[dict[str, Any]]]:
    result = {timeframe: [] for timeframe in TIMEFRAMES}
    if not database_configured():
        return result
    limit = max(1, min(int(limit_per_timeframe), 500))
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        for timeframe in TIMEFRAMES:
            rows = conn.execute("""
                SELECT candle_time, open, high, low, close, tick_count, source
                FROM goldsight_xau_live_candles
                WHERE symbol=%s AND timeframe=%s
                ORDER BY candle_time DESC LIMIT %s
            """, ("XAUUSD", timeframe, limit)).fetchall()
            result[timeframe] = [
                {
                    "time": int(row["candle_time"]),
                    "open": float(row["open"]), "high": float(row["high"]),
                    "low": float(row["low"]), "close": float(row["close"]),
                    "volume": 0.0, "tick_count": int(row["tick_count"]),
                    "closed": True, "source": row["source"],
                }
                for row in reversed(rows)
            ]
    return result


def xau_candle_store_status() -> dict[str, Any]:
    enabled = database_configured()
    return {
        "enabled": enabled,
        "backend": "PostgreSQL" if enabled else "memory_only",
        "survives_restart": enabled,
        "table": "goldsight_xau_live_candles" if enabled else None,
    }

def save_active_candles(candles: dict[str, dict[str, Any]]) -> int:
    """Persist the latest in-progress candle snapshots in one transaction.

    Snapshots are recovery hints only. A restored candle is always marked
    non-tradable by the stream layer because ticks may have been missed while
    the application process was down.
    """
    if not database_configured() or not isinstance(candles, dict):
        return 0

    values = []
    for timeframe, candle in candles.items():
        if timeframe not in TIMEFRAMES or not isinstance(candle, dict):
            continue
        try:
            stamp = int(candle["time"])
            last_tick_ms = int(candle["last_tick_ms"])
            tick_count = int(candle["tick_count"])
            opening, high, low, close = (
                float(candle[key]) for key in ("open", "high", "low", "close")
            )
            prices = (opening, high, low, close)
            if (
                stamp < 0 or last_tick_ms <= 0 or tick_count < 1
                or not all(math.isfinite(value) and value > 0 for value in prices)
                or high < max(opening, close, low)
                or low > min(opening, close, high)
            ):
                continue
            values.append((
                timeframe, stamp, opening, high, low, close, tick_count,
                last_tick_ms,
                str(candle.get("source", "SiftingIO WebSocket com ticks")),
                datetime.now(timezone.utc),
            ))
        except (KeyError, TypeError, ValueError, OverflowError):
            continue

    if not values:
        return 0
    with psycopg.connect(_database_url(), connect_timeout=3) as conn:
        conn.executemany(
            """
            INSERT INTO goldsight_xau_active_candles
                (timeframe,candle_time,open,high,low,close,tick_count,last_tick_ms,source,updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (timeframe) DO UPDATE SET
                candle_time=EXCLUDED.candle_time,
                open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                close=EXCLUDED.close, tick_count=EXCLUDED.tick_count,
                last_tick_ms=EXCLUDED.last_tick_ms, source=EXCLUDED.source,
                updated_at=EXCLUDED.updated_at
            WHERE EXCLUDED.last_tick_ms >= goldsight_xau_active_candles.last_tick_ms
            """,
            values,
        )
    return len(values)


def load_active_candles() -> dict[str, dict[str, Any]]:
    """Load persisted active snapshots; callers must revalidate and quarantine them."""
    result: dict[str, dict[str, Any]] = {}
    if not database_configured():
        return result
    with psycopg.connect(_database_url(), connect_timeout=3, row_factory=dict_row) as conn:
        rows = conn.execute(
            """
            SELECT timeframe,candle_time,open,high,low,close,tick_count,
                   last_tick_ms,source
            FROM goldsight_xau_active_candles
            """
        ).fetchall()
    for row in rows:
        timeframe = row.get("timeframe")
        if timeframe not in TIMEFRAMES:
            continue
        result[timeframe] = {
            "time": int(row["candle_time"]),
            "open": float(row["open"]), "high": float(row["high"]),
            "low": float(row["low"]), "close": float(row["close"]),
            "volume": 0.0, "tick_count": int(row["tick_count"]),
            "last_tick_ms": int(row["last_tick_ms"]),
            "closed": False, "source": row["source"],
        }
    return result
