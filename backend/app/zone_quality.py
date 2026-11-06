"""Explainable ranking of supply/demand zone evidence (not win probabilities)."""
from __future__ import annotations

import math
from typing import Any


def rank_zone_quality(
    zone: dict[str, Any],
    *,
    age_bars: int | None = None,
    displacement_atr: float | None = None,
    invalidated: bool | None = None,
) -> dict[str, Any]:
    """Score zone evidence using strength, age, retests, and departure displacement.

    Scores are capped 0..100 and are relative evidence rankings, not probabilities.
    Missing optional evidence is neutral rather than assumed favorable.
    """
    raw_strength = zone.get("strength_score", 0)
    try:
        strength = float(raw_strength)
    except (TypeError, ValueError, OverflowError):
        strength = 0.0
    if not math.isfinite(strength):
        strength = 0.0
    strength_points = max(0.0, min(30.0, strength * 0.30))

    try:
        touches = max(0, int(zone.get("touch_count", 0)))
    except (TypeError, ValueError, OverflowError):
        touches = 0
    retest_points = 20.0 if touches == 0 else 12.0 if touches == 1 else 5.0 if touches == 2 else 0.0

    age_points = 15.0
    if age_bars is not None:
        try:
            age = int(age_bars)
        except (TypeError, ValueError, OverflowError):
            age = -1
        if age < 0:
            age_points = 0.0
        elif age <= 20:
            age_points = 15.0
        elif age <= 50:
            age_points = 10.0
        elif age <= 100:
            age_points = 5.0
        else:
            age_points = 0.0

    displacement_points = 0.0
    if displacement_atr is not None:
        try:
            displacement = float(displacement_atr)
        except (TypeError, ValueError, OverflowError):
            displacement = 0.0
        if math.isfinite(displacement) and displacement > 0:
            displacement_points = min(25.0, displacement * 10.0)

    is_broken = invalidated if invalidated is not None else zone.get("invalidated", False)
    invalidation_penalty = 40.0 if bool(is_broken) else 0.0
    total = max(0.0, min(100.0, strength_points + retest_points + age_points + displacement_points - invalidation_penalty))
    tier = "A" if total >= 75 else "B" if total >= 55 else "C" if total >= 35 else "D"

    return {
        "quality_score": round(total, 2),
        "quality_tier": tier,
        "components": {
            "strength": round(strength_points, 2),
            "freshness_retests": round(retest_points, 2),
            "age": round(age_points, 2),
            "departure_displacement": round(displacement_points, 2),
            "invalidation_penalty": invalidation_penalty,
        },
        "evidence_label": "Explainable zone-quality ranking; not win probability",
    }
