#!/usr/bin/env python3
"""Read-only A/B replay of the original and BOS-retest XAUUSD strategies.

Reads only completed XAUUSD OHLC candles from goldsight_xau_live_candles.
No database writes, order execution, or parameter fitting are performed.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

BACKEND = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

BASELINE_REF = "478078c556c1008da9357698f5faf27ac464a170"
ENTRY_TIMEFRAMES = ("5m", "15m", "1h", "4h")
HIGHER_TIMEFRAME = {"5m": "15m", "15m": "1h", "1h": "4h"}
TARGET_R = 2
MAX_HOLD_BARS = 24
MAX_CANDLES_PER_TIMEFRAME = 10000


def _database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise SystemExit("DATABASE_URL is not configured; no backtest was run.")
    if value.startswith("postgres://"):
        value = "postgresql://" + value[len("postgres://"):]
    return value


def _load_baseline_market():
    """Load market.py from the pre-retest commit alongside the current package."""
    source = subprocess.run(
        ["git", "show", f"{BASELINE_REF}:backend/app/market.py"],
        cwd=REPO_ROOT, check=True, capture_output=True, text=True,
    ).stdout
    temp_path = REPO_ROOT / "market_baseline_for_backtest.py"
    try:
        temp_path.write_text(source, encoding="utf-8")
        spec = importlib.util.spec_from_file_location("app.market_baseline", temp_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Could not load baseline market module.")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        temp_path.unlink(missing_ok=True)


def _load_candles() -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    candles: dict[str, list[dict[str, Any]]] = {}
    coverage: dict[str, Any] = {}
    with psycopg.connect(_database_url(), connect_timeout=10, row_factory=dict_row) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        table = conn.execute("SELECT to_regclass('public.goldsight_xau_live_candles') AS name").fetchone()
        if not table or not table["name"]:
            raise RuntimeError("The XAUUSD candle table goldsight_xau_live_candles is not present.")
        for timeframe in ("5m", "15m", "30m", "1h", "4h"):
            total = conn.execute(
                "SELECT COUNT(*) AS n FROM goldsight_xau_live_candles WHERE symbol='XAUUSD' AND timeframe=%s",
                (timeframe,),
            ).fetchone()["n"]
            rows = conn.execute(
                """
                SELECT candle_time, open, high, low, close, tick_count, source
                FROM goldsight_xau_live_candles
                WHERE symbol='XAUUSD' AND timeframe=%s
                ORDER BY candle_time ASC
                LIMIT %s
                """,
                (timeframe, MAX_CANDLES_PER_TIMEFRAME),
            ).fetchall()
            bars = [{
                "time": int(row["candle_time"]),
                "open": float(row["open"]), "high": float(row["high"]),
                "low": float(row["low"]), "close": float(row["close"]),
                "volume": 0.0,
            } for row in rows]
            candles[timeframe] = bars
            sources = Counter(str(row["source"]) for row in rows)
            coverage[timeframe] = {
                "database_rows": int(total),
                "rows_loaded": len(bars),
                "oldest_utc": datetime.fromtimestamp(bars[0]["time"], timezone.utc).isoformat() if bars else None,
                "newest_utc": datetime.fromtimestamp(bars[-1]["time"], timezone.utc).isoformat() if bars else None,
                "source_counts": dict(sources),
                "truncated": int(total) > len(bars),
            }
    return candles, coverage


def _metrics(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "trades": result.get("trades", 0),
        "wins": result.get("wins", 0),
        "losses": result.get("losses", 0),
        "win_rate_pct": result.get("win_rate_pct"),
        "stop_loss_hits": result.get("stop_loss_hits", 0),
        "stop_loss_rate_pct": result.get("stop_loss_rate_pct"),
        "target_hits": result.get("target_hits", 0),
        "target_hit_rate_pct": result.get("target_hit_rate_pct"),
        "time_exit_count": result.get("time_exit_count", 0),
        "outcome_counts": result.get("outcome_counts", {}),
        "net_r_total": result.get("net_r_total", 0),
        "expectancy_net_r_per_trade": result.get("expectancy_net_r_per_trade"),
        "profit_factor": result.get("profit_factor"),
        "max_drawdown_r": result.get("max_drawdown_r"),
        "max_losing_streak": result.get("max_losing_streak"),
        "sample_start": result.get("sample_start"),
        "sample_end": result.get("sample_end"),
        "sample_span_days": result.get("sample_span_days"),
        "candles_used": result.get("candles_used", 0),
        "data_quality": result.get("data_quality"),
        "sample_size_warning": result.get("sample_size_warning") or result.get("reason"),
        "trade_details": result.get("trade_details", []),
    }


def _run_with_analyzer(backtest_module, analyzer, **kwargs):
    previous = backtest_module.analyze
    try:
        backtest_module.analyze = analyzer
        return backtest_module.run_backtest(**kwargs)
    finally:
        backtest_module.analyze = previous


def main() -> None:
    from app import market as current_market
    from app import backtest as backtest_module

    baseline_market = _load_baseline_market()
    candle_sets, coverage = _load_candles()
    results: dict[str, Any] = {}

    for timeframe in ENTRY_TIMEFRAMES:
        bars = candle_sets[timeframe]
        higher_tf = HIGHER_TIMEFRAME.get(timeframe)
        higher_bars = candle_sets[higher_tf] if higher_tf else None
        common = {
            "candles": bars,
            "symbol": "XAUUSD",
            "timeframe": timeframe,
            "spread": None,
            "higher_candles": higher_bars,
            "target_r": TARGET_R,
            "max_hold_bars": MAX_HOLD_BARS,
            "commission_r": 0.0,
            "slippage_price": 0.0,
        }
        baseline_result = _run_with_analyzer(backtest_module, baseline_market.analyze, **common)
        retest_result = _run_with_analyzer(backtest_module, current_market.analyze, **common)
        old = _metrics(baseline_result)
        new = _metrics(retest_result)
        old_trades = int(old["trades"] or 0)
        new_trades = int(new["trades"] or 0)
        old_sl = int(old["stop_loss_hits"] or 0)
        new_sl = int(new["stop_loss_hits"] or 0)
        results[timeframe] = {
            "entry_timeframe": timeframe,
            "higher_timeframe": higher_tf,
            "candle_count": len(bars),
            "baseline": old,
            "retest": new,
            "change": {
                "trade_count": new_trades - old_trades,
                "trade_count_pct": round(100 * (new_trades - old_trades) / old_trades, 2) if old_trades else None,
                "stop_loss_hits": new_sl - old_sl,
                "stop_loss_rate_percentage_points": (
                    round(float(new["stop_loss_rate_pct"]) - float(old["stop_loss_rate_pct"]), 2)
                    if old["stop_loss_rate_pct"] is not None and new["stop_loss_rate_pct"] is not None else None
                ),
                "expectancy_r_per_trade": (
                    round(float(new["expectancy_net_r_per_trade"]) - float(old["expectancy_net_r_per_trade"]), 3)
                    if old["expectancy_net_r_per_trade"] is not None and new["expectancy_net_r_per_trade"] is not None else None
                ),
                "net_r_total": round(float(new["net_r_total"] or 0) - float(old["net_r_total"] or 0), 3),
            },
        }

    payload = {
        "status": "completed",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "symbol": "XAUUSD",
        "baseline_commit": BASELINE_REF,
        "retest_commit": subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, check=True,
            capture_output=True, text=True,
        ).stdout.strip(),
        "method": "Same candle arrays; walk-forward next-bar-open entry; 2R target; 24-bar maximum hold; one position at a time; same-bar SL/TP assumes SL first.",
        "execution_costs": "Historical spread, slippage, commission and financing were not available in the persisted candle table; reported R metrics are gross estimates and exclude these costs.",
        "data_source": "Persisted SiftingIO XAUUSD tick-aggregated candles from PostgreSQL; not broker-native Exness historical CFD candles.",
        "coverage": coverage,
        "results": results,
        "interpretation_guardrails": [
            "This compares entry-rule behavior, not a guaranteed improvement in profitability.",
            "Fewer trades alone do not mean better performance.",
            "A timeframe with fewer than 30 trades is an insufficient sample.",
            "Provider gaps, short history, proxy spread assumptions and missing execution costs limit confidence.",
            "No parameters were optimized on this sample.",
        ],
    }

    output_dir = REPO_ROOT / "backtest-results"
    output_dir.mkdir(exist_ok=True)
    output_file = output_dir / "xauusd_bos_retest_comparison.json"
    output_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print("XAUUSD BOS RETEST A/B SUMMARY")
    print(json.dumps({
        "status": payload["status"],
        "generated_at_utc": payload["generated_at_utc"],
        "coverage": coverage,
        "timeframes": {
            tf: {
                "baseline": {k: v for k, v in value["baseline"].items() if k not in {"trade_details", "data_quality"}},
                "retest": {k: v for k, v in value["retest"].items() if k not in {"trade_details", "data_quality"}},
                "change": value["change"],
            }
            for tf, value in results.items()
        },
        "artifact": str(output_file.relative_to(REPO_ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
