"""Read-only integrity diagnostics for persisted SiftingIO XAUUSD candles."""
from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row

from app.setup_history import database_configured, _database_url

TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
MAX_AUDIT_ROWS = 1000


def inspect_candle_rows(timeframe: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Inspect ascending database rows without modifying or deleting any data."""
    seconds = TIMEFRAME_SECONDS[timeframe]
    misaligned = []
    invalid_ohlc = []
    gaps = []
    previous_time = None

    for row in rows:
        stamp = int(row["candle_time"])
        opened, high = float(row["open"]), float(row["high"])
        low, close = float(row["low"]), float(row["close"])
        if stamp % seconds:
            misaligned.append(stamp)
        if not (high >= low and high >= opened and high >= close
                and low <= opened and low <= close):
            invalid_ohlc.append(stamp)
        if previous_time is not None:
            delta = stamp - previous_time
            if delta <= 0:
                gaps.append({"after": previous_time, "before": stamp, "kind": "non_increasing"})
            elif delta > seconds:
                gaps.append({
                    "after": previous_time,
                    "before": stamp,
                    "missing_intervals": max(0, delta // seconds - 1),
                    "kind": "gap",
                })
        previous_time = stamp

    return {
        "timeframe": timeframe,
        "timeframe_seconds": seconds,
        "rows_inspected": len(rows),
        "misaligned_count": len(misaligned),
        "misaligned_timestamps": misaligned[-20:],
        "invalid_ohlc_count": len(invalid_ohlc),
        "invalid_ohlc_timestamps": invalid_ohlc[-20:],
        "gap_count": len(gaps),
        "gaps": gaps[-20:],
        "integrity": "ISSUES_FOUND" if misaligned or invalid_ohlc or gaps else "OK",
    }


def audit_persisted_xau_candles() -> dict[str, Any]:
    """Read the latest persisted rows for each timeframe and report integrity."""
    if not database_configured():
        return {
            "status": "UNAVAILABLE",
            "persistence": "memory_only",
            "reason": "DATABASE_URL is not configured",
            "timeframes": {},
        }

    reports = {}
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        for timeframe in TIMEFRAME_SECONDS:
            rows = conn.execute(
                """
                SELECT candle_time, open, high, low, close
                FROM (
                    SELECT candle_time, open, high, low, close
                    FROM goldsight_xau_live_candles
                    WHERE symbol = %s AND timeframe = %s
                    ORDER BY candle_time DESC
                    LIMIT %s
                ) recent
                ORDER BY candle_time ASC
                """,
                ("XAUUSD", timeframe, MAX_AUDIT_ROWS),
            ).fetchall()
            reports[timeframe] = inspect_candle_rows(timeframe, rows)

    issue_count = sum(
        report["misaligned_count"] + report["invalid_ohlc_count"] + report["gap_count"]
        for report in reports.values()
    )
    return {
        "status": "OK" if issue_count == 0 else "ISSUES_FOUND",
        "persistence": "postgresql",
        "read_only": True,
        "rows_per_timeframe_limit": MAX_AUDIT_ROWS,
        "total_issue_count": issue_count,
        "timeframes": reports,
        "note": "Gaps are diagnostic only; they may reflect periods without incoming ticks. No rows were changed or deleted.",
    }
