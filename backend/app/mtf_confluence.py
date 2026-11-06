"""Transparent multi-timeframe directional confluence scoring.

This is a weighted alignment measure, not a probability of a profitable trade.
"""
from __future__ import annotations

from typing import Any


_TIMEFRAME_WEIGHTS = {"4H": 4.0, "1H": 3.0, "15M": 2.0, "5M": 1.0}
_BULLISH = {"BULLISH", "BULL", "BUY", "UP", "LONG"}
_BEARISH = {"BEARISH", "BEAR", "SELL", "DOWN", "SHORT"}


def score_mtf_confluence(timeframe_directions: dict[str, Any]) -> dict[str, Any]:
    """Score directional agreement across 4H, 1H, 15M, and 5M inputs.

    Missing/unknown readings are excluded from the denominator; no timeframe is
    inferred. Higher timeframes carry more weight. Neutral readings contribute
    to coverage but neither bullish nor bearish weight.
    """
    bullish_weight = 0.0
    bearish_weight = 0.0
    neutral_weight = 0.0
    coverage: list[str] = []
    normalized: dict[str, str] = {}

    if not isinstance(timeframe_directions, dict):
        timeframe_directions = {}

    for timeframe, weight in _TIMEFRAME_WEIGHTS.items():
        raw = timeframe_directions.get(timeframe)
        if raw is None:
            continue
        direction = str(raw).strip().upper()
        if direction in _BULLISH:
            bullish_weight += weight
            normalized[timeframe] = "bullish"
        elif direction in _BEARISH:
            bearish_weight += weight
            normalized[timeframe] = "bearish"
        elif direction in {"NEUTRAL", "RANGE", "SIDEWAYS"}:
            neutral_weight += weight
            normalized[timeframe] = "neutral"
        else:
            continue
        coverage.append(timeframe)

    total_weight = bullish_weight + bearish_weight + neutral_weight
    directional_weight = bullish_weight + bearish_weight
    if directional_weight == 0:
        bias = "neutral"
        score = 0.0
    elif bullish_weight == bearish_weight:
        bias = "neutral"
        score = 0.0
    elif bullish_weight > bearish_weight:
        bias = "bullish"
        score = round((bullish_weight - bearish_weight) / directional_weight * 100, 2)
    else:
        bias = "bearish"
        score = round((bearish_weight - bullish_weight) / directional_weight * 100, 2)

    return {
        "bias": bias,
        "confluence_score": score,
        "bullish_weight": round(bullish_weight, 2),
        "bearish_weight": round(bearish_weight, 2),
        "neutral_weight": round(neutral_weight, 2),
        "coverage": coverage,
        "normalized_directions": normalized,
        "evidence_label": "Weighted multi-timeframe directional alignment; not win probability",
    }
