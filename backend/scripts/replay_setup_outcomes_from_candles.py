#!/usr/bin/env python3
"""Read-only replay audit of stored setup outcomes against supplied OHLC candles.

Input:
  --setups: JSON export containing {"items": [...]}
  --candles-dir: CSV files named SYMBOL_TIMEFRAME.csv (e.g. XAUUSD_15m.csv)
Each candle CSV must contain timestamp, open, high, low, close. Timestamps must be
UTC/ISO-8601. The script does not connect to or write to the application database.
It emits a discrepancy CSV and a compact JSON summary.

Replay policy: candles after entered_at (signal_time fallback) through outcome_at
(as-of now for ACTIVE rows); for BUY, low touches SL and high touches TP; for SELL,
high touches SL and low touches TP. If SL and TP are both touched in the same candle,
SL is assumed first (conservative). Results are audit candidates, not automatic fixes:
source/provider, gaps, and intrabar order can make a replay inconclusive.
"""
from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def load_candles(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        required = {"timestamp", "open", "high", "low", "close"}
        if not required.issubset(set(reader.fieldnames or [])):
            raise ValueError(f"{path} must contain columns: {sorted(required)}")
        for row in reader:
            ts = parse_time(row["timestamp"])
            if ts is None:
                continue
            candle = {"timestamp": ts, **{k: float(row[k]) for k in ("open", "high", "low", "close")}}
            if candle["high"] < max(candle["open"], candle["close"], candle["low"]) or candle["low"] > min(candle["open"], candle["close"], candle["high"]):
                raise ValueError(f"Malformed OHLC row in {path} at {row['timestamp']}")
            rows.append(candle)
    rows.sort(key=lambda x: x["timestamp"])
    return rows


def touches(side: str, candle: dict[str, Any], sl: float, targets: list[float]) -> tuple[bool, list[int]]:
    if side == "BUY":
        stop = candle["low"] <= sl
        hit = [i for i, tp in enumerate(targets) if candle["high"] >= tp]
    else:
        stop = candle["high"] >= sl
        hit = [i for i, tp in enumerate(targets) if candle["low"] <= tp]
    return stop, hit


def replay(item: dict[str, Any], candles: list[dict[str, Any]]) -> dict[str, Any]:
    side = str(item.get("side", "")).upper()
    if side not in {"BUY", "SELL"}:
        return {"replay": "INCONCLUSIVE", "reason": "unsupported side"}
    try:
        sl = float(item["stop_loss"])
        tps = [float(x) for x in (item.get("take_profits") or [])]
    except (KeyError, TypeError, ValueError):
        return {"replay": "INCONCLUSIVE", "reason": "missing/malformed SL or TP"}
    start = parse_time(item.get("entered_at")) or parse_time(item.get("signal_time"))
    end = parse_time(item.get("outcome_at")) or datetime.now(timezone.utc)
    if start is None:
        return {"replay": "INCONCLUSIVE", "reason": "missing start timestamp"}
    window = [c for c in candles if start <= c["timestamp"] <= end]
    if not window:
        return {"replay": "INCONCLUSIVE", "reason": "no candles in replay window"}
    reached = set()
    for candle in window:
        stop, hits = touches(side, candle, sl, tps)
        reached.update(hits)
        # Stop-first when SL and any target are touched in the same bar.
        if stop:
            return {"replay": "SL_HIT", "reached_target": max(reached, default=0), "targets_hit": sorted(reached),
                    "event_time": candle["timestamp"].isoformat(), "reason": "stop touched (conservative same-bar policy)"}
        if len(reached) == len(tps) and tps:
            return {"replay": "TP3_HIT" if len(tps) >= 3 else f"TP{len(tps)}_HIT",
                    "reached_target": len(tps), "targets_hit": sorted(reached),
                    "event_time": candle["timestamp"].isoformat(), "reason": "all configured targets touched"}
    if reached:
        n = max(reached) + 1
        return {"replay": f"TP{n}_HIT", "reached_target": n, "targets_hit": sorted(reached),
                "event_time": window[-1]["timestamp"].isoformat(), "reason": "partial target progression; no SL touch in window"}
    return {"replay": "UNRESOLVED", "reached_target": 0, "targets_hit": [],
            "event_time": None, "reason": "neither SL nor TP touched in replay window"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setups", required=True, type=Path, help="JSON setup-history export")
    parser.add_argument("--candles-dir", required=True, type=Path, help="Directory with SYMBOL_TIMEFRAME.csv files")
    parser.add_argument("--out", default=Path("setup_outcome_replay_audit.csv"), type=Path)
    args = parser.parse_args()
    payload = json.loads(args.setups.read_text(encoding="utf-8"))
    items = payload.get("items", payload if isinstance(payload, list) else [])
    cache: dict[str, list[dict[str, Any]]] = {}
    results = []
    for item in items:
        key = f"{item.get('symbol','')}_{item.get('timeframe','')}".upper()
        try:
            if key not in cache:
                path = args.candles_dir / f"{key}.csv"
                if not path.exists():
                    raise FileNotFoundError(f"missing candle file {path.name}")
                cache[key] = load_candles(path)
            result = replay(item, cache[key])
        except Exception as exc:
            result = {"replay": "INCONCLUSIVE", "reason": str(exc)}
        stored = str(item.get("status", ""))
        results.append({
            "id": item.get("id"), "symbol": item.get("symbol"), "timeframe": item.get("timeframe"),
            "side": item.get("side"), "stored_status": stored, "replay_status": result.get("replay"),
            "stored_reached_target": item.get("reached_target"), "replay_reached_target": result.get("reached_target"),
            "stored_targets_hit": json.dumps(item.get("targets_hit") or []),
            "replay_targets_hit": json.dumps(result.get("targets_hit") or []),
            "stored_outcome_at": item.get("outcome_at"), "replay_event_time": result.get("event_time"),
            "provider": item.get("provider"), "discrepancy_candidate": stored != result.get("replay") and result.get("replay") not in {"INCONCLUSIVE", "UNRESOLVED"},
            "reason": result.get("reason", ""),
        })
    fields = list(results[0].keys()) if results else ["id"]
    with args.out.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(results)
    counts: dict[str, int] = {}
    for row in results:
        status = str(row["replay_status"])
        counts[status] = counts.get(status, 0) + 1
    print(json.dumps({"rows": len(results), "replay_status_counts": counts,
                      "discrepancy_candidates": sum(bool(r["discrepancy_candidate"]) for r in results),
                      "csv": str(args.out)}, indent=2))


if __name__ == "__main__":
    main()
