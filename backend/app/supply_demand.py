"""Deterministic, no-lookahead supply/demand zone primitives.

A pivot is usable only after its right-side confirmation candles have closed.
Zone scores rank historical evidence; they are not probabilities of winning.
"""
from __future__ import annotations

from typing import Any
import math


def _valid_bars(candles: list[dict[str, Any]]) -> list[dict[str, float]]:
    bars: list[dict[str, float]] = []
    for candle in candles:
        # Provider-marked forming candles must never count toward pivot confirmation.
        if candle.get("closed") is False or candle.get("complete") is False:
            continue
        try:
            stamp = float(candle["time"])
            o, h, l, c = (float(candle[k]) for k in ("open", "high", "low", "close"))
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not all(math.isfinite(v) for v in (stamp, o, h, l, c)):
            continue
        if min(o, h, l, c) <= 0 or h < max(o, c, l) or l > min(o, c, h):
            continue
        bars.append({"time": stamp, "open": o, "high": h, "low": l, "close": c})
    bars.sort(key=lambda b: b["time"])
    return bars


def confirmed_pivots(
    candles: list[dict[str, Any]], *, left: int = 3, right: int = 3,
) -> dict[str, list[dict[str, float]]]:
    """Find strict confirmed swing highs/lows; omit pivots lacking right bars."""
    if left < 1 or right < 1:
        raise ValueError("Pivot left/right windows must be positive.")
    bars = _valid_bars(candles)
    highs: list[dict[str, float]] = []
    lows: list[dict[str, float]] = []
    for i in range(left, len(bars) - right):
        window = bars[i-left:i+right+1]
        high, low = bars[i]["high"], bars[i]["low"]
        if all(high > b["high"] for j, b in enumerate(window) if j != left):
            highs.append({"time": bars[i]["time"], "price": high, "index": float(i)})
        if all(low < b["low"] for j, b in enumerate(window) if j != left):
            lows.append({"time": bars[i]["time"], "price": low, "index": float(i)})
    return {"highs": highs, "lows": lows}


def cluster_zones(
    pivots: list[dict[str, float]], *, side: str, tolerance: float,
    candles: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Cluster pivots into zones whose full price span never exceeds tolerance."""
    if side not in {"SUPPLY", "DEMAND"}:
        raise ValueError("side must be SUPPLY or DEMAND")
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("tolerance must be finite and positive")
    valid = sorted(
        (p for p in pivots if math.isfinite(p.get("price", float("nan")))
         and math.isfinite(p.get("time", float("nan")))),
        key=lambda p: p["price"],
    )
    groups: list[list[dict[str, float]]] = []
    for pivot in valid:
        # Compare against the group's lowest price, not just its last pivot,
        # preventing chained near-neighbors from creating oversized zones.
        if not groups or pivot["price"] - groups[-1][0]["price"] > tolerance:
            groups.append([pivot])
        else:
            groups[-1].append(pivot)
    bars = _valid_bars(candles or [])
    zones: list[dict[str, Any]] = []
    for group in groups:
        lower, upper = group[0]["price"], group[-1]["price"]
        midpoint = (lower + upper) / 2
        touches = 0
        last_touch: float | None = None
        # Count independent reaction bars, separated by at least 3 bars.
        last_touch_index = -3
        for i, bar in enumerate(bars):
            intersects = bar["low"] <= upper + tolerance and bar["high"] >= lower - tolerance
            reaction = bar["close"] > midpoint if side == "DEMAND" else bar["close"] < midpoint
            if intersects and reaction and i - last_touch_index >= 3:
                touches += 1
                last_touch_index = i
                last_touch = bar["time"]
        zones.append({
            "side": side, "lower": lower, "upper": upper, "midpoint": midpoint,
            "pivot_count": len(group), "touch_count": touches,
            "strength_score": min(100, 20 * len(group) + 10 * touches),
            "first_seen": min(p["time"] for p in group),
            "last_seen": max(p["time"] for p in group),
            "last_reaction": last_touch,
            "tolerance": tolerance,
        })
    return zones


def detect_supply_demand_zones(
    candles: list[dict[str, Any]], *, atr: float, left: int = 3, right: int = 3,
    tolerance_atr: float = 0.5,
) -> dict[str, Any]:
    """Return ATR-scaled supply/demand zones from confirmed swing pivots."""
    if not math.isfinite(atr) or atr <= 0:
        raise ValueError("ATR must be finite and positive.")
    if not math.isfinite(tolerance_atr) or tolerance_atr <= 0:
        raise ValueError("tolerance_atr must be finite and positive.")
    bars = _valid_bars(candles)
    pivots = confirmed_pivots(bars, left=left, right=right)
    tolerance = atr * tolerance_atr
    return {
        "supply": classify_and_invalidate_zones(cluster_zones(pivots["highs"], side="SUPPLY", tolerance=tolerance, candles=bars), bars, side="SUPPLY"),
        "demand": classify_and_invalidate_zones(cluster_zones(pivots["lows"], side="DEMAND", tolerance=tolerance, candles=bars), bars, side="DEMAND"),
        "pivot_window": {"left": left, "right": right},
        "tolerance": tolerance,
        "evidence_label": "Historical zone-strength ranking; not win probability",
    }
