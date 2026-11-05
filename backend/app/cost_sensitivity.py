"""Backtest execution-cost stress scenarios.

Multipliers apply uniformly to the caller's spread, slippage, and commission
assumptions. They are sensitivity estimates, not broker-calibrated costs.
"""
from __future__ import annotations

from typing import Any, Callable
from app.backtest import run_backtest

COST_MULTIPLIERS = (1.0, 1.5, 2.0, 3.0)


def run_cost_sensitivity(
    candles: list[dict[str, Any]],
    symbol: str,
    timeframe: str,
    spread: float | None,
    higher_candles: list[dict[str, Any]] | None = None,
    target_r: int = 2,
    max_hold_bars: int = 24,
    commission_r: float = 0.0,
    slippage_price: float = 0.0,
    backtest_fn: Callable[..., dict[str, Any]] = run_backtest,
) -> dict[str, Any]:
    """Run unchanged strategy logic against progressively harsher cost assumptions."""
    common = {
        "candles": candles, "symbol": symbol, "timeframe": timeframe,
        "higher_candles": higher_candles, "target_r": target_r,
        "max_hold_bars": max_hold_bars,
    }
    scenarios = []
    for multiplier in COST_MULTIPLIERS:
        result = backtest_fn(
            **common,
            spread=float(spread or 0.0) * multiplier,
            commission_r=commission_r * multiplier,
            slippage_price=slippage_price * multiplier,
        )
        expectancy = result.get("expectancy_net_r_per_trade")
        scenarios.append({
            "cost_multiplier": multiplier,
            "spread_price_units": round(float(spread or 0.0) * multiplier, 8),
            "commission_r": round(commission_r * multiplier, 6),
            "slippage_price_units_per_side": round(slippage_price * multiplier, 8),
            "trades": int(result.get("trades", 0) or 0),
            "net_r_total": result.get("net_r_total"),
            "expectancy_net_r_per_trade": expectancy,
            "profit_factor": result.get("profit_factor"),
            "max_drawdown_r": result.get("max_drawdown_r"),
            "positive_expectancy": isinstance(expectancy, (int, float)) and expectancy > 0,
        })
    base = scenarios[0]
    resilient = [item["cost_multiplier"] for item in scenarios if item["positive_expectancy"]]
    return {
        "symbol": symbol, "timeframe": timeframe,
        "method": "Identical historical candles and strategy rules; estimated spread, slippage and commission are scaled together.",
        "base_cost_assumptions": {
            "spread_price_units": float(spread or 0.0),
            "commission_r": commission_r,
            "slippage_price_units_per_side": slippage_price,
        },
        "scenarios": scenarios,
        "highest_tested_positive_expectancy_cost_multiplier": max(resilient) if resilient else None,
        "cost_resilience_verdict": (
            "POSITIVE THROUGH 3X COSTS" if resilient and max(resilient) >= 3.0 else
            "POSITIVE THROUGH 2X COSTS" if resilient and max(resilient) >= 2.0 else
            "POSITIVE ONLY AT LOWER COSTS" if resilient else
            "NO POSITIVE EXPECTANCY AT BASE COSTS"
        ),
        "warning": "Cost multipliers are hypothetical stress scenarios, not a prediction of actual execution costs. Positive backtest expectancy does not prove a live edge.",
    }
