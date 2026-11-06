"""Outcome summaries for recorded setups; void and unresolved setups are excluded.

Win rate here is based on tracked TP/SL terminal labels, not strategy expectancy
or a promise of future performance. It does not model execution costs.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable


_WIN_PREFIX = "TP"
_LOSS_STATUS = "SL_HIT"
_VOID_STATUS = "VOID"


def summarize_setup_performance(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate resolved outcomes overall and by symbol/timeframe.

    Terminal TPn_HIT labels count as wins, SL_HIT as losses. VOID and unresolved
    statuses are not included in the resolved denominator.
    """
    groups: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"wins": 0, "losses": 0, "void": 0})
    totals = {"wins": 0, "losses": 0, "void": 0}

    for record in records:
        if not isinstance(record, dict):
            continue
        status = str(record.get("status", "")).strip().upper()
        if status.startswith(_WIN_PREFIX) and status.endswith("_HIT"):
            outcome = "wins"
        elif status == _LOSS_STATUS:
            outcome = "losses"
        elif status == _VOID_STATUS:
            outcome = "void"
        else:
            continue

        symbol = str(record.get("symbol") or "UNKNOWN").strip().upper() or "UNKNOWN"
        timeframe = str(record.get("timeframe") or "UNKNOWN").strip().upper() or "UNKNOWN"
        groups[(symbol, timeframe)][outcome] += 1
        totals[outcome] += 1

    def metrics(counts: dict[str, int]) -> dict[str, int | float]:
        resolved = counts["wins"] + counts["losses"]
        return {
            "wins": counts["wins"],
            "losses": counts["losses"],
            "void": counts["void"],
            "resolved": resolved,
            "win_rate_pct": round(counts["wins"] / resolved * 100, 2) if resolved else 0.0,
        }

    by_market = [
        {"symbol": symbol, "timeframe": timeframe, **metrics(counts)}
        for (symbol, timeframe), counts in sorted(groups.items())
    ]
    return {"overall": metrics(totals), "by_market": by_market,
            "method": "Tracked TP terminal labels vs SL_HIT; excludes VOID and unresolved; excludes execution costs."}
