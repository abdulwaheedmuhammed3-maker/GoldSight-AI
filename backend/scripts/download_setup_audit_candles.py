#!/usr/bin/env python3
"""Export historical OHLC CSVs for the read-only stored setup replay audit.

Exness-origin setups use the authenticated Exness historical candle adapter.
Binance-origin BTCUSD rows use BTCUSDT public spot klines (proxy only); they are
marked as proxy source in the manifest and must not be treated as CFD-exact.
No database writes or trade actions are performed.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def dt(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def binance_klines(start: int, end: int, timeframe: str) -> list[dict[str, Any]]:
    interval = {"5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h"}.get(timeframe)
    if not interval:
        raise ValueError(f"Binance interval unsupported: {timeframe}")
    result: dict[int, dict[str, Any]] = {}
    cursor = start * 1000
    end_ms = end * 1000
    for _ in range(100):
        query = urllib.parse.urlencode({"symbol": "BTCUSDT", "interval": interval,
                                        "startTime": cursor, "endTime": end_ms, "limit": 1000})
        url = "https://data-api.binance.vision/api/v3/klines?" + query
        req = urllib.request.Request(url, headers={"User-Agent": "GoldSightAI-audit/1.0"})
        with urllib.request.urlopen(req, timeout=15) as response:
            rows = json.loads(response.read().decode("utf-8"))
        if not isinstance(rows, list) or not rows:
            break
        for row in rows:
            stamp = int(row[0]) // 1000
            if start <= stamp <= end:
                result[stamp] = {"time": stamp, "open": float(row[1]), "high": float(row[2]),
                                 "low": float(row[3]), "close": float(row[4])}
        newest = max(int(row[0]) for row in rows)
        next_cursor = newest + 1
        if next_cursor <= cursor or newest >= end_ms or len(rows) < 1000:
            break
        cursor = next_cursor
        time.sleep(0.15)
    return [result[t] for t in sorted(result)]


def write_csv(path: Path, candles: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["timestamp", "open", "high", "low", "close"])
        writer.writeheader()
        for bar in candles:
            writer.writerow({"timestamp": datetime.fromtimestamp(bar["time"], timezone.utc).isoformat(),
                             **{k: bar[k] for k in ("open", "high", "low", "close")}})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setups", required=True, type=Path, help="JSON setup-history export")
    parser.add_argument("--out-dir", default=Path("historical-candles"), type=Path)
    parser.add_argument("--manifest", default=Path("candle-source-manifest.json"), type=Path)
    args = parser.parse_args()
    payload = json.loads(args.setups.read_text(encoding="utf-8"))
    items = payload.get("items", payload if isinstance(payload, list) else [])
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for item in items:
        provider = str(item.get("provider", "")).lower()
        source = "binance_proxy" if "binance" in provider else "exness"
        groups.setdefault((str(item.get("symbol", "")).upper(), str(item.get("timeframe", "")), source), []).append(item)

    exness_fetch = None
    manifest = []
    for (symbol, timeframe, source), rows in groups.items():
        starts = [dt(x.get("entered_at") or x.get("signal_time")).timestamp() for x in rows
                  if x.get("entered_at") or x.get("signal_time")]
        ends = [dt(x.get("outcome_at")).timestamp() for x in rows if x.get("outcome_at")]
        if not starts:
            manifest.append({"symbol": symbol, "timeframe": timeframe, "source": source, "status": "SKIPPED", "reason": "no start times"})
            continue
        start, end = int(min(starts)) - 2 * 86400, int(max(ends or [datetime.now(timezone.utc).timestamp()])) + 2 * 86400
        try:
            if source == "binance_proxy":
                if symbol != "BTCUSD":
                    raise ValueError("Binance proxy exporter only supports BTCUSD setup rows")
                bars = binance_klines(start, end, timeframe)
                source_note = "BTCUSDT Binance spot proxy; not exact BTCUSD CFD execution feed"
            else:
                if exness_fetch is None:
                    from app.exness import exness_historical_candles
                    exness_fetch = exness_historical_candles
                bars = exness_fetch(symbol, timeframe, start, end)
                source_note = "Exness authenticated historical OHLC"
            filename = f"{symbol}_{timeframe}.csv"
            write_csv(args.out_dir / filename, bars)
            manifest.append({"symbol": symbol, "timeframe": timeframe, "source": source,
                             "source_note": source_note, "bars": len(bars), "file": filename,
                             "requested_start_utc": datetime.fromtimestamp(start, timezone.utc).isoformat(),
                             "requested_end_utc": datetime.fromtimestamp(end, timezone.utc).isoformat(),
                             "status": "OK" if bars else "EMPTY"})
        except Exception as exc:
            manifest.append({"symbol": symbol, "timeframe": timeframe, "source": source,
                             "status": "FAILED", "reason": str(exc)})
    args.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"groups": len(groups), "manifest": str(args.manifest),
                      "successful_groups": sum(x.get("status") == "OK" for x in manifest),
                      "failed_groups": sum(x.get("status") == "FAILED" for x in manifest)}, indent=2))


if __name__ == "__main__":
    main()
