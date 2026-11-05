"""Walk-forward historical backtest for GoldSight's rule-based signal engine.

Uses only candles available at each simulated decision point. Same-candle stop/target
touches are conservatively counted as stop-loss first. Results are research estimates,
not a guarantee of future performance.
"""
from __future__ import annotations

from typing import Any
from app.market import analyze

SECONDS = {"5m": 300, "15m": 900, "45m": 2700, "1h": 3600, "4h": 14400}
HIGHER = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}


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
    trend_filter_candles: list[dict[str, Any]] | None = None,
    commission_r: float = 0.0,
    slippage_price: float = 0.0,
) -> dict[str, Any]:
    """Simulate entries at the next candle open after a completed-candle signal."""
    if timeframe not in SECONDS:
        raise ValueError("Unsupported timeframe.")
    if target_r not in (1, 2, 3):
        raise ValueError("target_r must be 1, 2, or 3.")
    if not math.isfinite(float(commission_r)) or commission_r < 0:
        raise ValueError("commission_r must be finite and nonnegative.")
    if not math.isfinite(float(slippage_price)) or slippage_price < 0:
        raise ValueError("slippage_price must be finite and nonnegative.")
    if spread is not None and (not math.isfinite(float(spread)) or float(spread) < 0):
        raise ValueError("spread must be finite and nonnegative.")
    bars, data_quality = _prepare_candles(candles, timeframe)
    higher, higher_quality = _prepare_candles(higher_candles or [], HIGHER.get(timeframe, timeframe))
    trend_filter, trend_filter_quality = _prepare_candles(trend_filter_candles or [], "4h")
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
        if trend_filter_candles is not None:
            # Only use 4H bars whose full four-hour interval had elapsed at decision time.
            completed_filter = [x for x in trend_filter if int(x.get("time", 0)) + SECONDS["4h"] <= decision_time]
            if len(completed_filter) < 40:
                skipped += 1
                continue
            filter_closes = [float(x["close"]) for x in completed_filter]
            def _ema(values: list[float], period: int) -> float:
                alpha = 2 / (period + 1)
                value = values[0]
                for point in values[1:]:
                    value = alpha * point + (1 - alpha) * value
                return value
            filter_trend = "BULLISH" if _ema(filter_closes[-80:], 9) > _ema(filter_closes[-120:], 21) else "BEARISH" if _ema(filter_closes[-80:], 9) < _ema(filter_closes[-120:], 21) else "RANGE"
            expected_trend = "BULLISH" if side == "BUY" else "BEARISH"
            if filter_trend != expected_trend:
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
        slippage_cost_r = (2.0 * float(slippage_price)) / risk
        commission_cost_r = float(commission_r)
        net_r = gross_r - spread_cost_r - slippage_cost_r - commission_cost_r
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
            "estimated_round_trip_slippage_cost_r": round(slippage_cost_r, 4),
            "estimated_commission_cost_r": round(commission_cost_r, 4),
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
        result["additional_trend_filter"] = "4h EMA 9/21 alignment" if trend_filter_candles is not None else None
        result["trend_filter_data_quality"] = trend_filter_quality if trend_filter_candles is not None else None
        return result

    wins = sum(1 for t in trades if t["net_r"] > 0)
    losses = sum(1 for t in trades if t["net_r"] < 0)
    net_values = [float(t["net_r"]) for t in trades]
    gross_wins = sum(x for x in net_values if x > 0)
    gross_losses = abs(sum(x for x in net_values if x < 0))
    # Track the full trade-by-trade equity path, not only the last 50 displayed trades.
    # Equity index starts at 100 and treats each R as one percentage-point of initial risk.
    equity = peak_equity = 100.0
    max_drawdown = 0.0
    max_drawdown_pct = 0.0
    equity_curve: list[dict[str, Any]] = []
    peak_trade_index = 0
    drawdown_start_index = 0
    max_drawdown_duration_trades = 0
    for trade_index, (trade, value) in enumerate(zip(trades, net_values), start=1):
        equity += value
        if equity >= peak_equity:
            peak_equity = equity
            peak_trade_index = trade_index
            current_drawdown = 0.0
            current_drawdown_pct = 0.0
        else:
            current_drawdown = peak_equity - equity
            current_drawdown_pct = current_drawdown / peak_equity * 100 if peak_equity > 0 else 0.0
            drawdown_start_index = peak_trade_index
            max_drawdown_duration_trades = max(
                max_drawdown_duration_trades, trade_index - drawdown_start_index
            )
        max_drawdown = max(max_drawdown, current_drawdown)
        max_drawdown_pct = max(max_drawdown_pct, current_drawdown_pct)
        equity_curve.append({
            "trade_index": trade_index,
            "exit_time": trade["exit_time"],
            "side": trade["side"],
            "net_r": round(value, 3),
            "cumulative_net_r": round(sum(net_values[:trade_index]), 3),
            "equity_index": round(equity, 3),
            "peak_equity_index": round(peak_equity, 3),
            "drawdown_r": round(current_drawdown, 3),
            "drawdown_pct": round(current_drawdown_pct, 3),
        })
    profit_factor = gross_wins / gross_losses if gross_losses > 0 else (None if gross_wins == 0 else "infinite")
    winning_values = [value for value in net_values if value > 0]
    losing_values = [value for value in net_values if value < 0]
    average_winning_net_r = sum(winning_values) / len(winning_values) if winning_values else None
    average_losing_net_r = sum(losing_values) / len(losing_values) if losing_values else None
    expectancy_net_r = sum(net_values) / len(net_values)
    recovery_factor = sum(net_values) / max_drawdown if max_drawdown > 0 else (None if sum(net_values) == 0 else "infinite")
    max_losing_streak = current_losing_streak = 0
    side_stats: dict[str, dict[str, Any]] = {}
    for trade in trades:
        value = float(trade["net_r"])
        current_losing_streak = current_losing_streak + 1 if value < 0 else 0
        max_losing_streak = max(max_losing_streak, current_losing_streak)
        stats = side_stats.setdefault(trade["side"], {"trades": 0, "wins": 0, "losses": 0, "net_r_total": 0.0})
        stats["trades"] += 1
        stats["wins"] += int(value > 0)
        stats["losses"] += int(value < 0)
        stats["net_r_total"] += value
    for stats in side_stats.values():
        stats["win_rate_pct"] = round(100 * stats["wins"] / stats["trades"], 2)
        stats["net_r_total"] = round(stats["net_r_total"], 3)

    outcome_stats: dict[str, dict[str, Any]] = {}
    for trade in trades:
        outcome = str(trade.get("outcome", "UNKNOWN"))
        stats = outcome_stats.setdefault(outcome, {"trades": 0, "net_r_total": 0.0})
        stats["trades"] += 1
        stats["net_r_total"] += float(trade.get("net_r", 0))
    for stats in outcome_stats.values():
        stats["net_r_total"] = round(stats["net_r_total"], 3)
    sample_warning = (
        "Very small sample: fewer than 30 trades; performance statistics are highly uncertain."
        if len(trades) < 30 else
        "Limited sample: fewer than 100 trades; treat metrics as preliminary."
        if len(trades) < 100 else None
    )
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
        "average_net_r": round(expectancy_net_r, 3),
        "expectancy_net_r_per_trade": round(expectancy_net_r, 3),
        "average_winning_net_r": round(average_winning_net_r, 3) if average_winning_net_r is not None else None,
        "average_losing_net_r": round(average_losing_net_r, 3) if average_losing_net_r is not None else None,
        "recovery_factor": round(recovery_factor, 3) if isinstance(recovery_factor, float) else recovery_factor,
        "profit_factor": round(profit_factor, 3) if isinstance(profit_factor, float) else profit_factor,
        "max_drawdown_r": round(max_drawdown, 3),
        "max_drawdown_pct": round(max_drawdown_pct, 3),
        "max_drawdown_duration_trades": max_drawdown_duration_trades,
        "equity_curve": equity_curve,
        "equity_curve_model": "Equity index starts at 100; each net R is treated as one percentage-point of initial risk (fixed-risk, non-compounding approximation).",
        "max_losing_streak": max_losing_streak,
        "side_breakdown": side_stats,\n        "outcome_breakdown": outcome_stats,
        "sample_size_warning": sample_warning,
        "spread_cost": "Approximation using current observed spread for every historical trade.",
        "execution_cost_model": {"spread_price_units_per_trade": float(spread or 0), "slippage_price_units_per_side": float(slippage_price), "round_trip_slippage_price_units": 2.0 * float(slippage_price), "commission_r_per_round_trip": float(commission_r), "note": "Slippage is modeled as an adverse price-unit cost on entry and exit; commission is a caller-supplied R multiple. These are user-configured estimates, not broker-calibrated historical costs."},
        "skipped_for_missing_higher_timeframe": skipped,
        "additional_trend_filter": "4h EMA 9/21 alignment" if trend_filter_candles is not None else None,
        "trend_filter_data_quality": trend_filter_quality if trend_filter_candles is not None else None,
        "trade_details": trades[-50:],
        "limitations": [
            "This is a provider-limited candle sample, not a robust multi-year test.",
            "Trades are not overlapped; a new position is considered only after the previous one exits.",
            "Current spread is used as a rough historical cost proxy.",
            "Stop gaps are filled at the next bar open; target gaps are conservatively filled at target.",
            "OHLC candles cannot establish intrabar price order; same-bar stop/target collisions assume the stop is first.",
            "Financing, latency, and broker-specific execution details remain unmodeled; cost inputs are estimates.",
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