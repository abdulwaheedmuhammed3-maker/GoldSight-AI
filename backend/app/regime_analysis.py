"""Classify historical bars into simple volatility/trend regimes and evaluate strategy slices.

Regime labels are descriptive diagnostics only, not a prediction or live filter.
"""
from __future__ import annotations

from typing import Any, Callable
from statistics import median

from app.backtest import run_backtest

MIN_SEGMENT_CANDLES = 45
LOOKBACK = 20
REGIMES = ("TRENDING", "RANGING", "HIGH_VOLATILITY")


def _true_range(bar: dict[str, Any], previous_close: float | None) -> float:
    high, low = float(bar["high"]), float(bar["low"])
    if previous_close is None:
        return high - low
    return max(high - low, abs(high - previous_close), abs(low - previous_close))


def classify_market_regimes(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign each candle a regime using trailing-only data (no future leakage)."""
    ordered = sorted(candles, key=lambda bar: int(bar.get("time", 0)))
    ranges: list[float] = []
    atr_pct_history: list[float] = []
    classified: list[dict[str, Any]] = []
    for i, bar in enumerate(ordered):
        close = float(bar["close"])
        previous_close = float(ordered[i - 1]["close"]) if i else None
        ranges.append(_true_range(bar, previous_close))
        window_start = max(0, i - LOOKBACK + 1)
        window = ordered[window_start:i + 1]
        if len(window) < LOOKBACK or close <= 0:
            classified.append({**bar, "regime": None})
            continue
        atr = sum(ranges[window_start:i + 1]) / len(ranges[window_start:i + 1])
        atr_pct = atr / close * 100.0
        historical_vol = atr_pct_history[-50:]
        volatility_threshold = median(historical_vol) * 1.5 if historical_vol else None
        closes = [float(item["close"]) for item in window]
        net_move = abs(closes[-1] - closes[0])
        path = sum(abs(closes[j] - closes[j - 1]) for j in range(1, len(closes)))
        efficiency = net_move / path if path > 0 else 0.0
        if volatility_threshold is not None and atr_pct > volatility_threshold:
            regime = "HIGH_VOLATILITY"
        elif efficiency >= 0.35:
            regime = "TRENDING"
        else:
            regime = "RANGING"
        classified.append({**bar, "regime": regime, "atr_pct": round(atr_pct, 6), "directional_efficiency": round(efficiency, 4)})
        atr_pct_history.append(atr_pct)
    return classified


def run_regime_analysis(
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
    """Run independent backtest slices over contiguous classified regimes."""
    labeled = classify_market_regimes(candles)
    segments: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_regime: str | None = None
    for candle in labeled:
        regime = candle.get("regime")
        if regime is None:
            if current:
                segments.append({"regime": current_regime, "candles": current})
                current, current_regime = [], None
            continue
        if regime != current_regime:
            if current:
                segments.append({"regime": current_regime, "candles": current})
            current, current_regime = [candle], regime
        else:
            current.append(candle)
    if current:
        segments.append({"regime": current_regime, "candles": current})

    summaries = {name: {"segments": 0, "evaluated_segments": 0, "candles": 0, "trades": 0, "net_r_total": 0.0, "weighted_expectancy_sum": 0.0, "trade_details": []} for name in REGIMES}
    skipped_segments = 0
    for segment in segments:
        regime = segment["regime"]
        bars = segment["candles"]
        summary = summaries[regime]
        summary["segments"] += 1
        summary["candles"] += len(bars)
        if len(bars) < MIN_SEGMENT_CANDLES:
            skipped_segments += 1
            continue
        start, end = int(bars[0]["time"]), int(bars[-1]["time"])
        context = [item for item in higher_candles or [] if start <= int(item.get("time", 0)) <= end] if higher_candles is not None else None
        result = backtest_fn(
            candles=bars, symbol=symbol, timeframe=timeframe, spread=spread,
            higher_candles=context, target_r=target_r, max_hold_bars=max_hold_bars,
            commission_r=commission_r, slippage_price=slippage_price,
        )
        trades = int(result.get("trades", 0) or 0)
        net_r = float(result.get("net_r_total", 0) or 0)
        expectancy = result.get("expectancy_net_r_per_trade")
        summary["evaluated_segments"] += 1
        summary["trades"] += trades
        summary["net_r_total"] += net_r
        if trades and isinstance(expectancy, (int, float)):
            summary["weighted_expectancy_sum"] += float(expectancy) * trades
        summary["trade_details"].append({
            "candles": len(bars), "start_time": start, "end_time": end,
            "trades": trades, "net_r_total": round(net_r, 3),
            "expectancy_net_r_per_trade": expectancy,
            "profit_factor": result.get("profit_factor"),
            "max_drawdown_r": result.get("max_drawdown_r"),
        })

    results = {}
    for name, item in summaries.items():
        trades = item["trades"]
        results[name] = {
            "segments": item["segments"], "evaluated_segments": item["evaluated_segments"],
            "candles": item["candles"], "trades": trades,
            "net_r_total": round(item["net_r_total"], 3),
            "expectancy_net_r_per_trade": round(item["weighted_expectancy_sum"] / trades, 3) if trades else None,
            "segment_results": item["trade_details"],
        }
    return {
        "symbol": symbol, "timeframe": timeframe,
        "method": "Trailing 20-bar directional efficiency and ATR-percent volatility classification; contiguous regime slices backtested independently.",
        "regimes": results, "classified_candles": sum(1 for item in labeled if item.get("regime")),
        "skipped_short_segments": skipped_segments, "minimum_segment_candles": MIN_SEGMENT_CANDLES,
        "limitations": [
            "Regime labels are heuristic, trailing-window diagnostics rather than a canonical market taxonomy.",
            "Separate segments each restart indicator warm-up and may yield fewer usable trades.",
            "Historical regime performance does not predict future performance; sample sizes and provider coverage matter.",
            "Estimated transaction costs are not historical broker fills; this analysis does not establish a live edge.",
        ],
    }
