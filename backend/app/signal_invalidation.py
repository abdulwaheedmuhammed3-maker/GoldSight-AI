"""Instrument-agnostic signal invalidation checks.

A signal is invalidated when the observed price crosses its structural
invalidation level. This helper does not predict price or place orders.
"""
from math import isfinite
from typing import Any


def evaluate_signal_invalidation(
    direction: str,
    current_price: float | None,
    invalidation_price: float | None,
) -> dict[str, Any]:
    """Return a deterministic invalidation status for a long or short signal."""
    side = str(direction).strip().lower()
    if side not in {"buy", "sell", "long", "short"}:
        return {
            "status": "unavailable",
            "invalidated": None,
            "reason": "unsupported_direction",
        }

    if current_price is None or invalidation_price is None:
        return {
            "status": "unavailable",
            "invalidated": None,
            "reason": "missing_price",
        }

    try:
        current = float(current_price)
        level = float(invalidation_price)
    except (TypeError, ValueError):
        return {
            "status": "unavailable",
            "invalidated": None,
            "reason": "invalid_price",
        }

    if not isfinite(current) or not isfinite(level):
        return {
            "status": "unavailable",
            "invalidated": None,
            "reason": "non_finite_price",
        }

    is_long = side in {"buy", "long"}
    invalidated = current <= level if is_long else current >= level
    return {
        "status": "invalidated" if invalidated else "valid",
        "invalidated": invalidated,
        "reason": "invalidation_level_breached" if invalidated else "level_not_breached",
        "current_price": current,
        "invalidation_price": level,
        "direction": "long" if is_long else "short",
    }
