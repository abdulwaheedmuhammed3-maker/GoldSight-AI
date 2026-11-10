"""Persistent storage for SiftingIO-derived XAUUSD candles."""
from __future__ import annotations

import logging
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
        conn.commit()
    restored = 0
    return {"enabled": True, "restored": restored, "reason": None}


def save_completed_candle(timeframe: str, candle: dict[str, Any]) -> bool:
    if timeframe not in TIMEFRAMES or not database_configured():
        return False
    if not candle.get("closed") or int(candle.get("tick_count", 0)) < 1:
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
