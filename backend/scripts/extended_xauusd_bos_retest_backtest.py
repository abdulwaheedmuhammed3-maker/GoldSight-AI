#!/usr/bin/env python3
"""Compare original and BOS-retest XAUUSD rules on one year of Dukascopy OHLC.

Input files are downloaded before this script runs. No database writes, order
execution, or parameter fitting are performed.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

BASELINE_REF = "478078c556c1008da9357698f5faf27ac464a170"
TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
HIGHER_TIMEFRAME = {"5m": "15m", "15m": "1h", "1h": "4h"}
TARGET_R = 2
MAX_HOLD_BARS = 24
ANALYSIS_LOOKBACK_BARS = 240
DATA_DIR = ROOT / "external-candles"


def _load_market_at_baseline():
    source = subprocess.run(
        ["git", "show", f"{BASELINE_REF}:backend/app/market.py"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    temp_path = ROOT / "market_baseline_for_extended_backtest.py"
    try:
        temp_path.write_text(source, encoding="utf-8")
        spec = importlib.util.spec_from_file_location("app.market_baseline_extended", temp_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Could not load the original strategy implementation.")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        temp_path.unlink(missing_ok=True)


def _read_csv(timeframe: str, side: str) -> list[dict[str, Any]]:
    path = DATA_DIR / f"xauusd-{timeframe}-{side}.csv"
    if not path.exists():
        raise FileNotFoundError(f"Historical feed file is missing: {path.name}")
    step = TIMEFRAME_SECONDS[timeframe]
    now = int(datetime.now(timezone.utc).timestamp())
    by_time: dict[int, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"timestamp", "open", "high", "low", "close"}
        fields = {str(name).strip().lower() for name in (reader.fieldnames or [])}
        if not required.issubset(fields):
            raise ValueError(f"{path.name} must contain timestamp, open, high, low and close columns.")
        for row in reader:
            lowered = {str(k).strip().lower(): v for k, v in row.items() if k is not None}
            try:
                stamp = int(float(lowered["timestamp"])) // 1000
                # Do not include a partially formed final candle in outcome checks.
                if stamp + step > now:
                    continue
                values = [float(lowered[key]) for key in ("open", "high", "low", "close")]
                if not all(math.isfinite(v) and v > 0 for v in values):
                    continue
                opening, high, low, close = values
                if high < max(opening, close, low) or low > min(opening, close, high):
                    continue
                volume = float(lowered.get("volume") or 0)
                if not math.isfinite(volume) or volume < 0:
                    volume = 0.0
                by_time[stamp] = {
                    "time": stamp, "open": opening, "high": high,
                    "low": low, "close": close, "volume": volume,
                }
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
    return [by_time[stamp] for stamp in sorted(by_time)]


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


def _spread_stats(bid: list[dict[str, Any]], ask: list[dict[str, Any]]) -> dict[str, Any]:
    ask_by_time = {int(bar["time"]): bar for bar in ask}
    spreads = []
    for bar in bid:
        other = ask_by_time.get(int(bar["time"]))
        if other is None:
            continue
        value = float(other["close"]) - float(bar["close"])
        if math.isfinite(value) and value >= 0:
            spreads.append(value)
    return {
        "matched_bid_ask_bars": len(spreads),
        "median_close_spread_price_units": median(spreads) if spreads else None,
        "p90_close_spread_price_units": _percentile(spreads, 0.90),
        "mean_close_spread_price_units": sum(spreads) / len(spreads) if spreads else None,
        "note": "Spread estimate is derived from matched Dukascopy bid/ask candle closes; it is not an Exness historical spread series.",
    }


def _run(backtest_module, analyzer, *, candles, timeframe, higher, spread):
    old_analyze = backtest_module.analyze
    try:
        backtest_module.analyze = analyzer
        return backtest_module.run_backtest(
            candles=candles, symbol="XAUUSD", timeframe=timeframe,
            spread=spread, higher_candles=higher,
            target_r=TARGET_R, max_hold_bars=MAX_HOLD_BARS,
            commission_r=0.0, slippage_price=0.0,
            analysis_lookback_bars=ANALYSIS_LOOKBACK_BARS,
        )
    finally:
        backtest_module.analyze = old_analyze


def _summary(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result.get(key) for key in (
            "trades", "wins", "losses", "win_rate_pct",
            "stop_loss_hits", "stop_loss_rate_pct",
            "target_hits", "target_hit_rate_pct", "time_exit_count",
            "outcome_counts", "net_r_total", "expectancy_net_r_per_trade",
            "profit_factor", "max_drawdown_r", "max_drawdown_pct",
            "max_losing_streak", "sample_start", "sample_end",
            "sample_span_days", "candles_used", "analysis_lookback_bars",
            "sample_size_warning", "reason",
        )
    } | {"trade_details": result.get("trade_details", [])[-50:]}


def main() -> None:
    from app import market as current_market
    from app import backtest as backtest_module

    baseline_market = _load_market_at_baseline()
    data: dict[str, dict[str, list[dict[str, Any]]]] = {}
    coverage: dict[str, Any] = {}

    for timeframe in TIMEFRAME_SECONDS:
        bid = _read_csv(timeframe, "bid")
        ask = _read_csv(timeframe, "ask")
        data[timeframe] = {"bid": bid, "ask": ask}
        gaps = sum(
            1 for left, right in zip(bid, bid[1:])
            if int(right["time"]) - int(left["time"]) > TIMEFRAME_SECONDS[timeframe] * 1.5
        )
        coverage[timeframe] = {
            "bid_candles": len(bid),
            "ask_candles": len(ask),
            "matched_bid_ask_candles": len(set(x["time"] for x in bid) & set(x["time"] for x in ask)),
            "first_utc": datetime.fromtimestamp(bid[0]["time"], timezone.utc).isoformat() if bid else None,
            "last_utc": datetime.fromtimestamp(bid[-1]["time"], timezone.utc).isoformat() if bid else None,
            "gaps_over_1_5_bars": gaps,
            "spread": _spread_stats(bid, ask),
        }

    results: dict[str, Any] = {}
    for timeframe in TIMEFRAME_SECONDS:
        bars = data[timeframe]["bid"]
        ask_bars = data[timeframe]["ask"]
        higher_tf = HIGHER_TIMEFRAME.get(timeframe)
        higher = data[higher_tf]["bid"] if higher_tf else None
        spread = coverage[timeframe]["spread"]["median_close_spread_price_units"]
        cost_p90 = coverage[timeframe]["spread"]["p90_close_spread_price_units"]
        scenarios = {}
        for scenario_name, scenario_spread in (("median_spread", spread), ("p90_spread_stress", cost_p90)):
            if scenario_spread is None:
                scenarios[scenario_name] = {"reason": "No matched bid/ask spread history."}
                continue
            baseline = _run(backtest_module, baseline_market.analyze,
                            candles=bars, timeframe=timeframe, higher=higher, spread=scenario_spread)
            retest = _run(backtest_module, current_market.analyze,
                          candles=bars, timeframe=timeframe, higher=higher, spread=scenario_spread)
            old, new = _summary(baseline), _summary(retest)
            old_n, new_n = int(old.get("trades") or 0), int(new.get("trades") or 0)
            old_sl, new_sl = int(old.get("stop_loss_hits") or 0), int(new.get("stop_loss_hits") or 0)
            scenarios[scenario_name] = {
                "spread_assumption_price_units": scenario_spread,
                "baseline": old,
                "retest": new,
                "change": {
                    "trade_count": new_n - old_n,
                    "trade_count_pct": round(100 * (new_n - old_n) / old_n, 2) if old_n else None,
                    "stop_loss_hits": new_sl - old_sl,
                    "stop_loss_rate_percentage_points": (
                        round(float(new["stop_loss_rate_pct"]) - float(old["stop_loss_rate_pct"]), 2)
                        if old.get("stop_loss_rate_pct") is not None and new.get("stop_loss_rate_pct") is not None else None
                    ),
                    "expectancy_r_per_trade": (
                        round(float(new["expectancy_net_r_per_trade"]) - float(old["expectancy_net_r_per_trade"]), 3)
                        if old.get("expectancy_net_r_per_trade") is not None and new.get("expectancy_net_r_per_trade") is not None else None
                    ),
                    "net_r_total": round(float(new.get("net_r_total") or 0) - float(old.get("net_r_total") or 0), 3),
                },
            }
        results[timeframe] = {
            "entry_timeframe": timeframe,
            "higher_timeframe": higher_tf,
            "candles": len(bars),
            "scenarios": scenarios,
        }

    report = {
        "status": "completed",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "symbol": "XAUUSD",
        "date_range_utc": {"from": "2025-11-16", "to_exclusive": "2026-11-17"},
        "baseline_commit": BASELINE_REF,
        "retest_commit": subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
            capture_output=True, text=True,
        ).stdout.strip(),
        "data_source": "Dukascopy public historical XAUUSD bid/ask data downloaded with dukascopy-node v1.51.1. Independent research feed; not the user's Exness execution venue.",
        "method": "Walk-forward next-bar-open entry; 2R target; 24-bar maximum hold; one open trade at a time; same-bar SL/TP assumes SL first; 240-bar rolling analysis context; median and p90 bid/ask close-spread cost assumptions.",
        "execution_costs": "Bid/ask spread is modelled from matched candle closes. Commission and slippage are set to zero because no validated historical Exness execution records are available.",
        "coverage": coverage,
        "results": results,
        "interpretation_guardrails": [
            "This is an independent market-feed proxy, not exact Exness CFD fills.",
            "Fewer trades alone do not mean improved strategy quality.",
            "A timeframe with fewer than 30 trades is an insufficient sample.",
            "Historical bid/ask candle-close spread is only an approximation of executable spread during the bar.",
            "Slippage, financing, latency and broker-specific execution remain unmodelled.",
            "No parameters were optimized on this dataset.",
            "Results do not establish future profitability.",
        ],
    }
    out_dir = ROOT / "backtest-results"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "xauusd_extended_bos_retest_comparison.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    compact = {
        "status": report["status"],
        "generated_at_utc": report["generated_at_utc"],
        "coverage": coverage,
        "results": {
            tf: {
                name: {
                    "baseline": {k: v for k, v in scenario.get("baseline", {}).items() if k != "trade_details"},
                    "retest": {k: v for k, v in scenario.get("retest", {}).items() if k != "trade_details"},
                    "change": scenario.get("change"),
                }
                for name, scenario in value["scenarios"].items()
            }
            for tf, value in results.items()
        },
        "artifact": "backtest-results/xauusd_extended_bos_retest_comparison.json",
    }
    print("EXTENDED XAUUSD BOS RETEST A-B SUMMARY")
    print(json.dumps(compact, indent=2))


if __name__ == "__main__":
    main()
