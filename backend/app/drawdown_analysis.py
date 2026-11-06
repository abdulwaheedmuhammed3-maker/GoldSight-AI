"""Instrument-agnostic drawdown and recovery measurements for backtest equity paths."""
from __future__ import annotations
from typing import Any


def analyze_drawdowns(equity_values: list[float]) -> dict[str, Any]:
    """Measure peak-to-recovery durations and drawdown episodes.

    Index 0 represents the initial account equity before the first trade. A recovery
    occurs when equity returns to or exceeds the prior peak. An unfinished episode
    is reported with recovery_index=None and its observed duration.
    """
    if any(not isinstance(value, (int, float)) for value in equity_values):
        raise ValueError("Equity values must be numeric.")
    if not equity_values:
        return {"episodes": [], "max_duration_trades": 0, "longest_recovery": None}

    peak = float(equity_values[0])
    peak_index = 0
    episode_start_peak_index: int | None = None
    episode_trough_index: int | None = None
    trough = peak
    episodes: list[dict[str, Any]] = []
    max_duration = 0
    longest_recovery: dict[str, int] | None = None

    for index, raw in enumerate(equity_values[1:], start=1):
        value = float(raw)
        if value >= peak:
            if episode_start_peak_index is not None:
                duration = index - episode_start_peak_index
                episode = {
                    "peak_index": episode_start_peak_index,
                    "trough_index": episode_trough_index,
                    "recovery_index": index,
                    "duration_trades": duration,
                }
                episodes.append(episode)
                if duration > max_duration:
                    max_duration = duration
                    longest_recovery = {
                        "peak_index": episode_start_peak_index,
                        "recovery_index": index,
                        "duration_trades": duration,
                    }
                episode_start_peak_index = None
                episode_trough_index = None
                trough = value
            peak = value
            peak_index = index
        else:
            if episode_start_peak_index is None:
                episode_start_peak_index = peak_index
                episode_trough_index = index
                trough = value
            elif value < trough:
                trough = value
                episode_trough_index = index

    if episode_start_peak_index is not None:
        duration = len(equity_values) - 1 - episode_start_peak_index
        episodes.append({
            "peak_index": episode_start_peak_index,
            "trough_index": episode_trough_index,
            "recovery_index": None,
            "duration_trades": duration,
        })
        if duration > max_duration:
            max_duration = duration
            longest_recovery = {
                "peak_index": episode_start_peak_index,
                "recovery_index": None,
                "duration_trades": duration,
            }

    return {"episodes": episodes, "max_duration_trades": max_duration,
            "longest_recovery": longest_recovery}
