"""Provider-pure date-range candle retrieval for historical research.

This module is deliberately separate from live quote/signal adapters. It never
falls back between providers and never manufactures candles.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import math
import os
import urllib.parse

from .market import (
    MarketUnavailable, _http_json, _oanda_json, _validated_oanda_candle,
    _validated_mt5_candle, normalize_candles, TIMEFRAME_SECONDS,
)

SUPPORTED = {
    "XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD",
    "USDCAD", "USDCHF", "NZDUSD", "USDNGN", "EURGBP",
}
OANDA_GRANULARITY = {"5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4"}
BINANCE_INTERVAL = {"5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h"}
MT5_TIMEFRAME = {"5m": "TIMEFRAME_M5", "15m": "TIMEFRAME_M15", "30m": "TIMEFRAME_M30", "1h": "TIMEFRAME_H1", "4h": "TIMEFRAME_H4"}


def _provider_for(symbol: str) -> str:
    if symbol == "XAUUSD":
        return os.getenv("MARKET_DATA_PROVIDER_XAUUSD", "").strip().lower() or "exness"
    defaults = {
        "BTCUSD": "exness", "EURUSD": "oanda", "GBPUSD": "oanda",
        "USDJPY": "oanda", "AUDUSD": "oanda", "USDCAD": "oanda",
        "USDCHF": "oanda", "NZDUSD": "oanda", "USDNGN": "biquote",
        "EURGBP": "oanda",
    }
    return os.getenv(f"MARKET_DATA_PROVIDER_{symbol}", defaults[symbol]).strip().lower()


def _range_check(symbol: str, timeframe: str, start_ts: int, end_ts: int) -> int:
    if symbol not in SUPPORTED:
        raise MarketUnavailable("Unsupported historical symbol.")
    seconds = TIMEFRAME_SECONDS.get(timeframe)
    if seconds is None:
        raise MarketUnavailable("Unsupported historical timeframe.")
    if isinstance(start_ts, bool) or isinstance(end_ts, bool) or not isinstance(start_ts, int) or not isinstance(end_ts, int):
        raise MarketUnavailable("Historical timestamps must be integer UTC epoch seconds.")
    now = int(datetime.now(timezone.utc).timestamp())
    if start_ts < 0 or end_ts <= start_ts or end_ts > now + seconds:
        raise MarketUnavailable("Historical range must be valid UTC timestamps and cannot extend materially into the future.")
    return seconds


def _exness(symbol: str, timeframe: str, start_ts: int, end_ts: int, page_size: int) -> list[dict[str, Any]]:
    from app.exness import exness_historical_candles
    return exness_historical_candles(symbol, timeframe, start_ts, end_ts, page_size=page_size)


def _oanda(symbol: str, timeframe: str, start_ts: int, end_ts: int, page_size: int) -> list[dict[str, Any]]:
    account = os.getenv("OANDA_ACCOUNT_ID", "").strip()
    if not account or not os.getenv("OANDA_API_TOKEN", "").strip():
        raise MarketUnavailable("OANDA historical credentials are not configured.")
    defaults = {
        "XAUUSD":"XAU_USD", "BTCUSD":"BTC_USD", "EURUSD":"EUR_USD",
        "GBPUSD":"GBP_USD", "USDJPY":"USD_JPY", "AUDUSD":"AUD_USD",
        "USDCAD":"USD_CAD", "USDCHF":"USD_CHF", "NZDUSD":"NZD_USD",
        "USDNGN":"USD_NGN", "EURGBP":"EUR_GBP",
    }
    instrument = os.getenv("OANDA_INSTRUMENT_" + symbol, defaults[symbol]).strip().upper()
    account_path = urllib.parse.quote(account, safe="")
    listed = _oanda_json(f"/v3/accounts/{account_path}/instruments")
    if instrument not in {item.get("name") for item in listed.get("instruments", [])}:
        raise MarketUnavailable(f"{instrument} is not available on this OANDA account.")
    path = f"/v3/accounts/{account_path}/instruments/{urllib.parse.quote(instrument, safe='')}/candles"
    seconds = TIMEFRAME_SECONDS[timeframe]
    cursor = start_ts
    by_time: dict[int, dict[str, Any]] = {}
    pages = 0
    while cursor < end_ts and pages < 100:
        params = {
            "granularity": OANDA_GRANULARITY[timeframe],
            "from": datetime.fromtimestamp(cursor, timezone.utc).isoformat().replace("+00:00", "Z"),
            "to": datetime.fromtimestamp(end_ts, timezone.utc).isoformat().replace("+00:00", "Z"),
            "price": "M",
            "includeFirst": "true" if pages == 0 else "false",
            "count": str(min(page_size, 500)),
        }
        payload = _oanda_json(path, params)
        rows = payload.get("candles")
        if not isinstance(rows, list) or not rows:
            break
        page_times = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                candle = _validated_oanda_candle(row)
                stamp = candle["time"]
                if start_ts <= stamp <= end_ts and row.get("complete", False):
                    by_time[stamp] = candle
                    page_times.append(stamp)
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
        pages += 1
        newest = max(page_times, default=None)
        if newest is None or newest + seconds <= cursor:
            break
        cursor = newest + seconds
    if pages >= 100 and cursor < end_ts:
        raise MarketUnavailable("OANDA historical request exceeded 100 pages; narrow the date range.")
    return [by_time[t] for t in sorted(by_time)]


def _binance(start_ts: int, end_ts: int, timeframe: str, page_size: int) -> list[dict[str, Any]]:
    seconds = TIMEFRAME_SECONDS[timeframe]
    cursor_ms, end_ms = start_ts * 1000, end_ts * 1000
    by_time: dict[int, dict[str, Any]] = {}
    for base in ("https://data-api.binance.vision", "https://api.binance.com"):
        try:
            cursor = cursor_ms
            pages = 0
            by_time.clear()
            while cursor <= end_ms and pages < 100:
                params = urllib.parse.urlencode({
                    "symbol": "BTCUSDT", "interval": BINANCE_INTERVAL[timeframe],
                    "startTime": cursor, "endTime": end_ms,
                    "limit": min(page_size, 1000),
                })
                rows = _http_json(f"{base}/api/v3/klines?{params}")
                if not isinstance(rows, list) or not rows:
                    break
                latest_ms = None
                for row in rows:
                    if not isinstance(row, (list, tuple)) or len(row) < 7:
                        continue
                    try:
                        stamp_ms, close_ms = int(row[0]), int(row[6])
                        values = [float(v) for v in row[1:6]]
                        opening, high, low, close, volume = values
                        if stamp_ms < cursor_ms or stamp_ms > end_ms or close_ms < stamp_ms:
                            continue
                        if not all(math.isfinite(v) for v in values) or min(opening, high, low, close) <= 0 or volume < 0:
                            continue
                        if high < max(opening, close, low) or low > min(opening, close):
                            continue
                        stamp = stamp_ms // 1000
                        by_time[stamp] = {"time": stamp, "open": opening, "high": high, "low": low, "close": close, "volume": volume, "closed": close_ms < int(datetime.now(timezone.utc).timestamp() * 1000)}
                        latest_ms = max(latest_ms or stamp_ms, stamp_ms)
                    except (TypeError, ValueError, OverflowError):
                        continue
                pages += 1
                if latest_ms is None:
                    break
                next_cursor = latest_ms + seconds * 1000
                if next_cursor <= cursor:
                    break
                cursor = next_cursor
            if pages >= 100 and cursor <= end_ms:
                raise MarketUnavailable("Binance historical request exceeded 100 pages; narrow the date range.")
            return [by_time[t] for t in sorted(by_time)]
        except Exception:
            if base == "https://api.binance.com":
                raise
    return [by_time[t] for t in sorted(by_time)]


def _mt5(symbol: str, timeframe: str, start_ts: int, end_ts: int) -> list[dict[str, Any]]:
    from .market import MT5_LOCK, _mt5, _mt5_symbol
    with MT5_LOCK:
        mt5 = _mt5()
        try:
            actual = _mt5_symbol(mt5, symbol)
            tf = getattr(mt5, MT5_TIMEFRAME[timeframe])
            rows = mt5.copy_rates_range(
                actual, tf,
                datetime.fromtimestamp(start_ts, timezone.utc),
                datetime.fromtimestamp(end_ts, timezone.utc),
            )
            if rows is None:
                raise MarketUnavailable(f"MT5 historical retrieval failed: {mt5.last_error()}.")
            candles = []
            for row in rows:
                try:
                    candle = _validated_mt5_candle(row)
                    if start_ts <= candle["time"] <= end_ts:
                        candles.append(candle)
                except (KeyError, TypeError, ValueError, OverflowError):
                    continue
            return normalize_candles(candles)
        finally:
            mt5.shutdown()


def fetch_historical_candles(
    symbol: str, timeframe: str, start_ts: int, end_ts: int, page_size: int = 500,
) -> dict[str, Any]:
    """Fetch a single-provider historical window with source provenance."""
    _range_check(symbol, timeframe, start_ts, end_ts)
    if not isinstance(page_size, int) or isinstance(page_size, bool) or not 50 <= page_size <= 1000:
        raise MarketUnavailable("Historical page size must be between 50 and 1000.")
    provider = _provider_for(symbol)
    if provider == "exness" and symbol in {"XAUUSD", "BTCUSD"}:
        candles = _exness(symbol, timeframe, start_ts, end_ts, page_size)
        provider_symbol = os.getenv("EXN_INSTRUMENT_" + symbol, symbol).strip()
    elif provider == "oanda":
        candles = _oanda(symbol, timeframe, start_ts, end_ts, page_size)
        provider_symbol = os.getenv("OANDA_INSTRUMENT_" + symbol, symbol.replace("USD", "_USD")).strip().upper()
    elif provider == "binance" and symbol == "BTCUSD":
        candles = _binance(start_ts, end_ts, timeframe, page_size)
        provider_symbol = "BTCUSDT"
    elif provider == "mt5":
        candles = _mt5(symbol, timeframe, start_ts, end_ts)
        provider_symbol = os.getenv("MT5_SYMBOL_" + symbol, symbol).strip()
    elif provider == "biquote" and symbol == "USDNGN":
        raise MarketUnavailable("BiQuote date-range history is not supported by the current adapter; only its bounded recent-candle endpoint is verified.")
    elif provider == "siftingio" and symbol == "XAUUSD":
        raise MarketUnavailable("SiftingIO date-range research retrieval is not yet exposed by the current adapter.")
    else:
        raise MarketUnavailable(f"Configured provider '{provider}' does not support historical retrieval for {symbol}.")
    normalized = normalize_candles(candles)
    normalized = [bar for bar in normalized if start_ts <= int(bar["time"]) <= end_ts]
    return {
        "symbol": symbol, "provider": provider, "provider_symbol": provider_symbol,
        "timeframe": timeframe, "requested_from": start_ts, "requested_to": end_ts,
        "actual_from": normalized[0]["time"] if normalized else None,
        "actual_to": normalized[-1]["time"] if normalized else None,
        "count": len(normalized), "duplicates_removed": max(0, len(candles) - len(normalized)),
        "candles": normalized,
        "history_complete": bool(normalized and normalized[0]["time"] <= start_ts + TIMEFRAME_SECONDS[timeframe] and normalized[-1]["time"] >= end_ts - TIMEFRAME_SECONDS[timeframe]),
    }
