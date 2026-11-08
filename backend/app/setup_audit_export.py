"""Authenticated, read-only Exness candle export for setup outcome audits."""
from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Any

from app.exness import exness_historical_candles


ALLOWED_TIMEFRAMES = {"5m", "15m", "30m", "1h", "4h"}
MAX_SETUP_ROWS = 250
MAX_SYMBOLS = 9
MAX_GROUPS = 45
MAX_RANGE_SECONDS = 180 * 24 * 60 * 60


def _parse_stamp(value: Any) -> int | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except (TypeError, ValueError, OverflowError):
        return None


def build_exness_candle_archive(payload: dict[str, Any]) -> bytes:
    """Validate a setup export and return CSV candle files plus a manifest as ZIP bytes."""
    items = payload.get("items", [])
    if not isinstance(items, list) or not items:
        raise ValueError("Request body must contain a non-empty items array.")
    if len(items) > MAX_SETUP_ROWS:
        raise ValueError(f"Maximum {MAX_SETUP_ROWS} setup rows per audit export.")
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Every setup item must be an object.")
        symbol = str(item.get("symbol", "")).strip().upper()
        timeframe = str(item.get("timeframe", "")).strip().lower()
        if not symbol or not symbol.replace("_", "").isalnum() or len(symbol) > 24:
            raise ValueError("A setup contains an invalid symbol.")
        if timeframe not in ALLOWED_TIMEFRAMES:
            raise ValueError(f"Unsupported timeframe: {timeframe or '(missing)'}.")
        groups.setdefault((symbol, timeframe), []).append(item)
    symbols = {symbol for symbol, _ in groups}
    if len(symbols) > MAX_SYMBOLS or len(groups) > MAX_GROUPS:
        raise ValueError("Audit export exceeds the supported symbol/timeframe limits.")

    now = int(datetime.now(timezone.utc).timestamp())
    manifest: list[dict[str, Any]] = []
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for (symbol, timeframe), rows in sorted(groups.items()):
            starts = [_parse_stamp(row.get("entered_at")) or _parse_stamp(row.get("signal_time")) for row in rows]
            starts = [stamp for stamp in starts if stamp is not None]
            ends = [_parse_stamp(row.get("outcome_at")) or now for row in rows]
            if not starts:
                manifest.append({"symbol": symbol, "timeframe": timeframe, "status": "skipped", "reason": "No valid entered_at/signal_time"})
                continue
            start_ts, end_ts = min(starts), max(ends)
            if end_ts <= start_ts:
                manifest.append({"symbol": symbol, "timeframe": timeframe, "status": "skipped", "reason": "Invalid date range"})
                continue
            if end_ts - start_ts > MAX_RANGE_SECONDS:
                manifest.append({"symbol": symbol, "timeframe": timeframe, "status": "skipped", "reason": "Date range exceeds 180-day safety limit"})
                continue
            try:
                candles = exness_historical_candles(symbol, timeframe, start_ts, end_ts)
                text = io.StringIO(newline="")
                writer = csv.DictWriter(text, fieldnames=["timestamp", "open", "high", "low", "close", "volume"])
                writer.writeheader()
                for candle in candles:
                    stamp = datetime.fromtimestamp(int(candle["time"]), timezone.utc).isoformat().replace("+00:00", "Z")
                    writer.writerow({"timestamp": stamp, "open": candle["open"], "high": candle["high"],
                                     "low": candle["low"], "close": candle["close"], "volume": candle.get("volume", 0)})
                archive.writestr(f"candles/{symbol}_{timeframe}.csv", text.getvalue())
                manifest.append({"symbol": symbol, "timeframe": timeframe, "status": "ok", "candle_count": len(candles),
                                 "start_utc": datetime.fromtimestamp(start_ts, timezone.utc).isoformat(),
                                 "end_utc": datetime.fromtimestamp(end_ts, timezone.utc).isoformat(),
                                 "provider": "Exness Trader API"})
            except Exception as exc:
                # Error text is provider-validated and must never include credential material.
                manifest.append({"symbol": symbol, "timeframe": timeframe, "status": "error",
                                 "reason": str(exc)[:400]})
        archive.writestr("manifest.json", json.dumps({"source": "Exness Trader API", "groups": manifest}, indent=2))
    return output.getvalue()
