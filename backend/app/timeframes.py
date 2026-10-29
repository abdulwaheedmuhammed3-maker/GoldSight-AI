"""Timeframe conversion helpers for provider candles."""
from __future__ import annotations
from typing import Any


def aggregate_15m_to_45m(candles: list[dict[str, Any]], limit: int = 240) -> list[dict[str, Any]]:
    """Aggregate only complete, aligned groups of three 15m candles."""
    buckets: dict[int, list[dict[str, Any]]] = {}
    for candle in candles:
        try:
            stamp = int(candle["time"])
            if stamp < 0 or stamp % 900 != 0:
                continue
            start = (stamp // 2700) * 2700
            buckets.setdefault(start, []).append(candle)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    result: list[dict[str, Any]] = []
    for start in sorted(buckets):
        rows = sorted(buckets[start], key=lambda row: int(row["time"]))
        try:
            if [int(row["time"]) for row in rows] != [start, start + 900, start + 1800]:
                continue
            bars = [{"open": float(row["open"]), "high": float(row["high"]), "low": float(row["low"]), "close": float(row["close"]), "volume": float(row.get("volume", 0) or 0)} for row in rows]
            bar: dict[str, Any] = {"time": start, "open": bars[0]["open"], "high": max(x["high"] for x in bars), "low": min(x["low"] for x in bars), "close": bars[-1]["close"], "volume": sum(x["volume"] for x in bars)}
            if any("closed" in row for row in rows):
                bar["closed"] = all(bool(row.get("closed", False)) for row in rows)
            result.append(bar)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return result[-limit:] if limit > 0 else []
