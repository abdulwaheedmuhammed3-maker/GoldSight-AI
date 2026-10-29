"""Walk-forward historical backtest for GoldSight's rule-based signal engine.

Uses only candles available at each simulated decision point. Same-candle stop/target
touches are conservatively counted as stop-loss first. Results are research estimates,
not a guarantee of future performance.
"""
from __future__ import annotations

from typing import Any
from app.market import analyze

SECONDS = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
HIGHER = {"5m": "15m", "15m": "1h", "1h": "4h"}


import math

def _prepare_candles(candles: list[dict[str, Any]], timeframe: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Validate OHLC bars, deduplicate timestamps, sort chronologically, and report gaps."""
    seconds = SECONDS[timeframe]
    valid: list[dict[str, Any]] = []
    invalid = 0
    for raw in candles:
        try:
            bar = {
                "time": int(raw["time"]),
                "open": float(raw["open"]),
                "high": float(raw["high"]),
                "low": float(raw["low"]),
                "close": float(raw["close"]),
                "volume": float(raw.get("volume", 0) or 0),
            }
            prices = [bar["open"], bar["high"], bar["low"], bar["close"]]
            if not all(math.isfinite(v) for v in prices + [bar["volume"]]):
                invalid += 1
                continue
            if min(prices) <= 0 or bar["high"] < max(bar["open"], bar["close"], bar["low"]) or bar["low"] > min(bar["open"], bar["close"], bar["high"]):
                invalid += 1
                continue
            valid.append(bar)
        except (KeyError, TypeError, ValueError, OverflowError):
            invalid += 1

    by_time: dict[int, dict[str, Any]] = {}
    for bar in valid:
        by_time[bar["time"]] = bar
    bars = [by_time[t] for t in sorted(by_time)]
    duplicates = len(valid) - len(bars)
    gaps = []
    for prev, cur in zip(bars, bars[1:]):
        delta = cur["time"] - prev["time"]
        if delta > seconds * 1.5:
            gaps.append({
                "after": _iso(prev["time"]),
                "before": _iso(cur["time"]),
                "gap_minutes": round(delta / 60, 1),
            })
    return bars, {
        "input_candles": len(candles),
        "valid_candles": len(bars),
        "invalid_candles_removed": invalid,
        "duplicate_timestamps_removed": duplicates,
        "time_gaps_over_1_5_bars": len(gaps),
        "longest_gap_minutes": max((g["gap_minutes"] for g in gaps), default=0),
        "gap_examples": gaps[:10],
        "note": "Gaps may reflect market closures or missing provider history; inspect before interpreting results.",
    }


def run_backtest(
    candles: list[dict[str, Any]],
    symbol: str,
    timeframe: str,
    spread: float | None,
    higher_candles: list[dict[str, Any]] | None = None,
    target_r: int = 2,
    max_hold_bars: int = 24,
) -> dict[str, Any]:
    """Simulate entries at the next candle open after a completed-candle signal."""
    if timeframe not in SECONDS:
        raise ValueError("Unsupported timeframe.")
    if target_r not in (1, 2, 3):
        raise ValueError("target_r must be 1, 2, or 3.")
    bars, data_quality = _prepare_candles(candles, timeframe)
    higher, higher_quality = _prepare_candles(higher_candles or [], HIGHER.get(timeframe, timeframe))
    if len(bars) < 45:
        result = _empty(symbol, timeframe, len(bars), "At least 45 valid, unique candles are required.")
        result["data_quality"] = data_quality
        result["higher_timeframe_data_quality"] = higher_quality
        return result

    higher_tf = HIGHER.get(timeframe)
    trades: list[dict[str, Any]] = []
    skipped = 0
    next_available_index = 41

    # i is the simulated entry candle. analyze() drops the final (forming) bar,
    # so passing bars[:i+1] makes its last input bar the entry candle and its
    # calculations use only candles closed before that entry candle began.
    for i in range(41, len(bars) - 1):
        # One position at a time: avoid stacking trades during an existing trade.
        if i < next_available_index:
            continue
        entry_bar = bars[i]
        decision_time = int(entry_bar["time"])
        if higher_tf:
            # Include the higher-timeframe bar active at decision time; analyze()
            # drops it as potentially incomplete and uses only previously closed bars.
            eligible_higher = [x for x in higher if int(x.get("time", 0)) <= decision_time]
            if len(eligible_higher) < 41:
                skipped += 1
                continue
        else:
            eligible_higher = None

        history = bars[: i + 1]
        signal = analyze(history, symbol, timeframe, spread, eligible_higher)
        side = signal.get("side")
        if side not in ("BUY", "SELL"):
            continue
        stop = signal.get("stop_loss")
        entry = float(entry_bar.get("open", 0))
        targets = signal.get("take_profits") or []
        if stop is None or len(targets) < target_r or entry <= 0:
            continue
        stop = float(stop)
        target = float(targets[target_r - 1])
        risk = entry - stop if side == "BUY" else stop - entry
        if risk <= 0:
            continue
        # Re-anchor target distance to the simulated next-open entry, preserving
        # the requested R multiple rather than pretending a close fill occurred.
        target = entry + target_r * risk if side == "BUY" else entry - target_r * risk

        outcome = "TIME_EXIT"
        exit_price = float(bars[min(i + max_hold_bars, len(bars) - 1)]["close"])
        exit_index = min(i + max_hold_bars, len(bars) - 1)
        for j in range(i, min(i + max_hold_bars + 1, len(bars))):
            bar = bars[j]
            bar_open = float(bar["open"])
            bar_high = float(bar["high"])
            bar_low = float(bar["low"])

            # Model stop gaps at the first tradable bar price rather than the
            # requested stop price. This avoids understating losses on gaps.
            if side == "BUY":
                if bar_open <= stop:
                    outcome, exit_price, exit_index = "STOP_GAP", bar_open, j
                    break
                hit_stop = bar_low <= stop
                hit_target = bar_high >= target
            else:
                if bar_open >= stop:
                    outcome, exit_price, exit_index = "STOP_GAP", bar_open, j
                    break
                hit_stop = bar_high >= stop
                hit_target = bar_low <= target

            # OHLC bars cannot tell which level was hit first. If both are
            # touched within one candle, assume the adverse stop was hit first.
            if hit_stop and hit_target:
                outcome, exit_price, exit_index = "STOP_AND_TARGET_SAME_BAR_STOP_ASSUMED", stop, j
                break
            if hit_stop:
                outcome, exit_price, exit_index = "STOP", stop, j
                break
            if hit_target:
                outcome, exit_price, exit_index = "TARGET", target, j
                break

        gross_r = (exit_price - entry) / risk if side == "BUY" else (entry - exit_price) / risk
        spread_cost_r = float(spread or 0) / risk
        net_r = gross_r - spread_cost_r
        next_available_index = exit_index + 1
        trades.append({
            "signal_time": signal.get("signal_time"),
            "entry_time": _iso(decision_time),
            "exit_time": _iso(int(bars[exit_index]["time"])),
            "side": side,
            "entry": round(entry, 5),
            "stop_loss": round(stop, 5),
            "target": round(target, 5),
            "exit": round(exit_price, 5),
            "outcome": outcome,
            "gross_r": round(gross_r, 3),
            "estimated_spread_cost_r": round(spread_cost_r, 4),
            "net_r": round(net_r, 3),
        })

    if not trades:
        result = _empty(symbol, timeframe, len(bars), "No qualifying trades found in this candle sample.")
        result["sample_start"] = _iso(int(bars[0]["time"]))
        result["sample_end"] = _iso(int(bars[-1]["time"]))
        result["sample_span_days"] = round((int(bars[-1]["time"]) - int(bars[0]["time"])) / 86400, 2)
        result["skipped_for_missing_higher_timeframe"] = skipped
        result["data_quality"] = data_quality
        result["higher_timeframe_data_quality"] = higher_quality
        return result

    wins = sum(1 for t in trades if t["net_r"] > 0)
    losses = sum(1 for t in trades if t["net_r"] < 0)
    net_values = [float(t["net_r"]) for t in trades]
    gross_wins = sum(x for x in net_values if x > 0)
    gross_losses = abs(sum(x for x in net_values if x < 0))
    equity = peak = 0.0
    max_drawdown = 0.0
    for value in net_values:
        equity += value
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
    profit_factor = gross_wins / gross_losses if gross_losses > 0 else (None if gross_wins == 0 else "infinite")
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "higher_timeframe": higher_tf,
        "method": "Walk-forward; next-bar-open entry; stop gaps fill at bar open; same-bar stop/target assumes stop first",
        "target_r": target_r,
        "max_hold_bars": max_hold_bars,
        "candles_used": len(bars),
        "data_quality": data_quality,
        "higher_timeframe_data_quality": higher_quality,
        "sample_start": _iso(int(bars[0]["time"])),
        "sample_end": _iso(int(bars[-1]["time"])),
        "sample_span_days": round((int(bars[-1]["time"]) - int(bars[0]["time"])) / 86400, 2),
        "trades": len(trades),
        "wins": wins,
        "losses": losses,
        "breakeven": len(trades) - wins - losses,
        "win_rate_pct": round(100 * wins / len(trades), 2),
        "net_r_total": round(sum(net_values), 3),
        "average_net_r": round(sum(net_values) / len(net_values), 3),
        "profit_factor": round(profit_factor, 3) if isinstance(profit_factor, float) else profit_factor,
        "max_drawdown_r": round(max_drawdown, 3),
        "spread_cost": "Approximation using current observed spread for every historical trade; excludes slippage and commission.",
        "skipped_for_missing_higher_timeframe": skipped,
        "trade_details": trades[-50:],
        "limitations": [
            "This is a provider-limited candle sample, not a robust multi-year test.",
            "Trades are not overlapped; a new position is considered only after the previous one exits.",
            "Current spread is used as a rough historical cost proxy.",
            "Stop gaps are filled at the next bar open; target gaps are conservatively filled at target.",
            "OHLC candles cannot establish intrabar price order; same-bar stop/target collisions assume the stop is first.",
            "No slippage, commission, financing, latency, or broker-specific execution simulation.",
            "Historical results do not establish future profitability.",
        ],
    }


def _iso(timestamp: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _empty(symbol: str, timeframe: str, count: int, reason: str) -> dict[str, Any]:
    return {
        "symbol": symbol, "timeframe": timeframe, "candles_used": count,
        "trades": 0, "wins": 0, "losses": 0, "win_rate_pct": None,
        "net_r_total": 0, "average_net_r": None, "profit_factor": None,
        "max_drawdown_r": 0, "trade_details": [], "reason": reason,
        "limitations": ["Insufficient data or no qualifying trades; this is not evidence of profitability."],
    }
