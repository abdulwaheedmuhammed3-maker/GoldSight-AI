"""Timeframe conversion helpers for provider candles."""
from __future__ import annotations

import math
from typing import Any


def aggregate_15m_to_45m(candles: list[dict[str, Any]], limit: int = 240) -> list[dict[str, Any]]:
    """Aggregate only complete, aligned groups of three valid 15m candles."""
    buckets: dict[int, list[dict[str, Any]]] = {}
    for candle in candles:
        try:
            raw_stamp = candle["time"]
            if isinstance(raw_stamp, bool) or not isinstance(raw_stamp, (int, float)):
                continue
            if not math.isfinite(raw_stamp) or not float(raw_stamp).is_integer():
                continue
            stamp = int(raw_stamp)
            if stamp < 0 or stamp % 900 != 0:
                continue
            buckets.setdefault((stamp // 2700) * 2700, []).append(candle)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue

    result: list[dict[str, Any]] = []
    for start in sorted(buckets):
        rows = sorted(buckets[start], key=lambda row: int(row["time"]))
        try:
            if [int(row["time"]) for row in rows] != [start, start + 900, start + 1800]:
                continue
            bars = []
            for row in rows:
                raw_values = (row["open"], row["high"], row["low"], row["close"], row.get("volume", 0) or 0)
                if any(isinstance(value, bool) for value in raw_values):
                    raise ValueError("Boolean candle values are invalid.")
                opening, high, low, close, volume = (float(value) for value in raw_values)
                if (
                    not all(math.isfinite(value) for value in (opening, high, low, close, volume))
                    or min(opening, high, low, close) <= 0 or volume < 0
                    or high < max(opening, close, low) or low > min(opening, close, high)
                ):
                    raise ValueError("Invalid OHLCV geometry.")
                bars.append({"open": opening, "high": high, "low": low, "close": close, "volume": volume})
            bar: dict[str, Any] = {
                "time": start, "open": bars[0]["open"],
                "high": max(x["high"] for x in bars),
                "low": min(x["low"] for x in bars),
                "close": bars[-1]["close"],
                "volume": sum(x["volume"] for x in bars),
            }
            if any("closed" in row for row in rows):
                bar["closed"] = all(row.get("closed") is True for row in rows)
            result.append(bar)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return result[-limit:] if limit > 0 else []
