"""Chronological out-of-sample validation helpers for the rule-based backtester.

This module deliberately does not optimize parameters on the test segment. The
out-of-sample segment is run independently; its first 41 bars are indicator
warm-up and do not generate trades. Results are research estimates, not proof
of a durable edge.
"""
from __future__ import annotations

from typing import Any, Callable

from app.backtest import run_backtest


def run_walk_forward_validation(
    candles: list[dict[str, Any]],
    symbol: str,
    timeframe: str,
    spread: float | None,
    higher_candles: list[dict[str, Any]] | None = None,
    target_r: int = 2,
    max_hold_bars: int = 24,
    commission_r: float = 0.0,
    slippage_price: float = 0.0,
    train_fraction: float = 0.70,
    min_oos_candles: int = 86,
    backtest_fn: Callable[..., dict[str, Any]] = run_backtest,
) -> dict[str, Any]:
    """Compare chronological in-sample and out-of-sample backtest segments."""
    if not 0.5 <= float(train_fraction) <= 0.85:
        raise ValueError("train_fraction must be between 0.50 and 0.85.")
    if min_oos_candles < 45:
        raise ValueError("min_oos_candles must be at least 45.")

    ordered = sorted(candles, key=lambda bar: int(bar.get("time", 0)))
    split_index = int(len(ordered) * train_fraction)
    in_sample = ordered[:split_index]
    out_sample = ordered[split_index:]
    split_time = int(out_sample[0]["time"]) if out_sample else None

    def eligible_higher(segment: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
        if higher_candles is None:
            return None
        if not segment:
            return []
        start, end = int(segment[0]["time"]), int(segment[-1]["time"])
        return [bar for bar in higher_candles if start <= int(bar.get("time", 0)) <= end]

    common = {
        "symbol": symbol,
        "timeframe": timeframe,
        "spread": spread,
        "target_r": target_r,
        "max_hold_bars": max_hold_bars,
        "commission_r": commission_r,
        "slippage_price": slippage_price,
    }
    train_result = backtest_fn(
        candles=in_sample, higher_candles=eligible_higher(in_sample), **common
    ) if len(in_sample) >= 45 else {
        "trades": 0, "expectancy_net_r_per_trade": None,
        "profit_factor": None, "max_drawdown_r": None,
        "reason": "In-sample segment has fewer than 45 candles.",
    }
    test_result = backtest_fn(
        candles=out_sample, higher_candles=eligible_higher(out_sample), **common
    ) if len(out_sample) >= min_oos_candles else {
        "trades": 0, "expectancy_net_r_per_trade": None,
        "profit_factor": None, "max_drawdown_r": None,
        "reason": f"Out-of-sample segment requires at least {min_oos_candles} candles (including indicator warm-up).",
    }

    train_exp = train_result.get("expectancy_net_r_per_trade")
    test_exp = test_result.get("expectancy_net_r_per_trade")
    train_pf = train_result.get("profit_factor")
    test_pf = test_result.get("profit_factor")
    degradation = (
        round(float(train_exp) - float(test_exp), 3)
        if train_exp is not None and test_exp is not None else None
    )
    enough_test_trades = int(test_result.get("trades", 0) or 0) >= 30
    if not enough_test_trades:
        verdict = "INSUFFICIENT OOS SAMPLE"
        warnings = ["Fewer than 30 out-of-sample trades; performance estimate is highly uncertain."]
    elif test_exp is None or float(test_exp) <= 0:
        verdict = "NO OOS EDGE OBSERVED"
        warnings = ["Out-of-sample expectancy is not positive after modeled costs."]
    elif isinstance(test_pf, (int, float)) and float(test_pf) <= 1:
        verdict = "WEAK OOS ROBUSTNESS"
        warnings = ["Out-of-sample profit factor is at or below 1."]
    elif degradation is not None and degradation > max(0.10, abs(float(train_exp)) * 0.5):
        verdict = "POSSIBLE PERFORMANCE DEGRADATION"
        warnings = ["Out-of-sample expectancy declined materially versus in-sample."]
    else:
        verdict = "PROMISING, NOT PROVEN"
        warnings = ["Positive OOS metrics are not proof of future profitability; test more market regimes and costs."]

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "method": "Chronological holdout; no parameter optimization on OOS; OOS indicator warm-up trades excluded by the backtest's 41-bar warm-up.",
        "train_fraction": train_fraction,
        "split_time": split_time,
        "in_sample": train_result,
        "out_of_sample": test_result,
        "comparison": {
            "in_sample_expectancy_net_r_per_trade": train_exp,
            "out_of_sample_expectancy_net_r_per_trade": test_exp,
            "expectancy_degradation_r": degradation,
            "in_sample_profit_factor": train_pf,
            "out_of_sample_profit_factor": test_pf,
            "in_sample_trades": int(train_result.get("trades", 0) or 0),
            "out_of_sample_trades": int(test_result.get("trades", 0) or 0),
        },
        "robustness_verdict": verdict,
        "warnings": warnings,
        "limitations": [
            "This is a single chronological holdout, not repeated rolling walk-forward folds.",
            "A provider-limited candle sample may not cover enough regimes.",
            "A positive holdout does not establish future profitability or a live trading edge.",
            "Current spread and configured costs are estimates, not historical broker execution records.",
        ],
    }
