"""Live market adapters and transparent rule-based signal analysis.

Gold quotes come only from a connected MetaTrader 5 terminal (e.g. Exness).
BTC can use the public Binance spot feed when MT5 is unavailable. No synthetic
prices or candles are returned from these providers.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from threading import Lock

from .supply_demand import detect_supply_demand_zones

TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
BINANCE_INTERVAL = {"5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h"}
MT5_LOCK = Lock()


class MarketUnavailable(RuntimeError):
    pass


def _quote_midpoint_spread(bid: float, ask: float, provider: str) -> tuple[float, float]:
    """Calculate quote midpoint and spread only when derived values stay finite."""
    midpoint = (bid + ask) / 2
    spread = ask - bid
    if not math.isfinite(midpoint) or not math.isfinite(spread):
        raise MarketUnavailable(f"{provider} quote midpoint or spread is non-finite.")
    return midpoint, spread


def _parse_quote_pair(raw_bid: Any, raw_ask: Any, provider: str) -> tuple[float, float]:
    """Parse and validate provider bid/ask fields without leaking parsing errors."""
    if isinstance(raw_bid, bool) or isinstance(raw_ask, bool):
        raise MarketUnavailable(f"{provider} returned an invalid bid/ask.")
    try:
        bid, ask = float(raw_bid), float(raw_ask)
    except (TypeError, ValueError, OverflowError) as exc:
        raise MarketUnavailable(f"{provider} returned an invalid bid/ask.") from exc
    if not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask <= 0 or ask < bid:
        raise MarketUnavailable(f"{provider} returned an invalid bid/ask.")
    _quote_midpoint_spread(bid, ask, provider)
    return bid, ask


_NOW_TS_UNSET = object()


def _utc_iso(value: int | float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def normalize_candles(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return unique valid OHLC candles in ascending timestamp order.

    Invalid price geometry and non-finite values are discarded before they can
    poison EMA, ATR, structure, or batch trend calculations. Latest duplicate
    valid candle wins.
    """
    by_time: dict[int, dict[str, Any]] = {}
    for candle in candles:
        try:
            raw_time = candle["time"]
            raw_prices = (candle["open"], candle["high"], candle["low"], candle["close"])
            raw_volume = candle.get("volume")
            # Python bool is an int subclass; reject booleans before numeric
            # conversion so malformed provider fields cannot become 1/1.0.
            if (
                isinstance(raw_time, bool)
                or any(isinstance(value, bool) for value in raw_prices)
                or isinstance(raw_volume, bool)
            ):
                continue
            if raw_volume is not None:
                volume = float(raw_volume)
                if not math.isfinite(volume) or volume < 0:
                    continue
            else:
                volume = None
            # Timestamps must be numeric epoch seconds. Reject strings and other
            # coercible objects instead of silently accepting provider corruption.
            if not isinstance(raw_time, (int, float)):
                continue
            if isinstance(raw_time, float) and (
                not math.isfinite(raw_time) or not raw_time.is_integer()
            ):
                continue
            stamp = int(raw_time)
            if stamp < 0:
                continue
            open_price, high, low, close = (float(value) for value in raw_prices)
            prices = (open_price, high, low, close)
            if not all(__import__("math").isfinite(value) and value > 0 for value in prices):
                continue
            if high < max(open_price, close, low) or low > min(open_price, close, high):
                continue
            normalized = dict(candle)
            normalized.update({
                "time": stamp, "open": open_price, "high": high,
                "low": low, "close": close,
                **({"volume": volume} if volume is not None else {}),
            })
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        by_time[stamp] = normalized
    return [by_time[stamp] for stamp in sorted(by_time)]

def completed_candles(
    candles: list[dict[str, Any]],
    timeframe: str,
    now_ts: float | None | object = _NOW_TS_UNSET,
) -> list[dict[str, Any]]:
    """Select bars whose full timeframe has elapsed; never treat future bars as closed."""
    seconds = TIMEFRAME_SECONDS.get(timeframe)
    if seconds is None:
        raise MarketUnavailable(f"Unsupported timeframe for candle completion: {timeframe}.")
    if now_ts is _NOW_TS_UNSET:
        now = datetime.now(timezone.utc).timestamp()
    else:
        if isinstance(now_ts, bool) or not isinstance(now_ts, (int, float)):
            raise MarketUnavailable("Candle completion clock must be a finite numeric timestamp.")
        now = float(now_ts)
        if not math.isfinite(now):
            raise MarketUnavailable("Candle completion clock must be a finite numeric timestamp.")
    ordered = normalize_candles(candles)
    return [
        candle for candle in ordered
        if int(candle["time"]) + seconds <= now
        and candle.get("closed") is not False
    ]


def _http_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "GoldSightAI/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise MarketUnavailable(f"Live provider request failed: {exc}") from exc


def _mt5():
    """Return an initialized MT5 module or raise a clear offline reason."""
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError as exc:
        raise MarketUnavailable(
            "MetaTrader5 Python package is not installed. Run the feed on Windows "
            "with the Exness MT5 terminal installed and logged in."
        ) from exc
    # Optional explicit terminal path is useful when Exness MT5 is installed
    # in a non-default directory. Authentication stays inside the logged-in terminal.
    terminal_path = os.getenv("MT5_TERMINAL_PATH", "").strip()
    initialized = mt5.initialize(terminal_path) if terminal_path else mt5.initialize()
    if not initialized:
        raise MarketUnavailable(
            f"MT5 initialize failed (code {mt5.last_error()}). Open Exness MT5, "
            "sign in to the intended account, check Algo Trading permissions if "
            "your terminal requires them, and verify MT5_TERMINAL_PATH."
        )
    return mt5


def mt5_connection_status() -> dict[str, Any]:
    """Read-only diagnostic; never returns account number, balance or credentials."""
    mt5 = _mt5()
    try:
        terminal = mt5.terminal_info()
        if terminal is None:
            raise MarketUnavailable(f"MT5 terminal_info failed: {mt5.last_error()}.")
        connected = bool(getattr(terminal, "connected", False))
        version = mt5.version()
        return {
            "provider": "Exness MT5 terminal",
            "status": "CONNECTED" if connected else "NOT_CONNECTED",
            "terminal_connected": connected,
            "terminal_version": list(version) if version else None,
            "read_only": True,
            "order_execution_enabled": False,
        }
    finally:
        mt5.shutdown()


def _mt5_symbol(mt5, symbol: str) -> str:
    configured = os.getenv("MT5_SYMBOL_" + symbol.upper())
    candidates = [configured] if configured else []
    if symbol == "XAUUSD":
        candidates += ["XAUUSD", "XAUUSD.a", "XAUUSDm", "GOLD"]
    elif symbol == "BTCUSD":
        candidates += ["BTCUSD", "BTCUSDm", "BTCUSD.a"]
    else:
        # FX brokers commonly append an account-specific suffix to major pairs.
        # Prefer the exact market name, then only well-known suffix variants.
        candidates += [symbol, f"{symbol}.a", f"{symbol}m", f"{symbol}.r"]
    for name in candidates:
        if not name:
            continue
        info = mt5.symbol_info(name)
        if info is not None:
            if not info.visible:
                mt5.symbol_select(name, True)
            return name
    raise MarketUnavailable(
        f"No matching {symbol} symbol found in MT5. Set MT5_SYMBOL_{symbol} to the exact "
        "symbol shown in Market Watch."
    )


def _validated_mt5_candle(row: Any) -> dict[str, Any]:
    """Validate an MT5 rate before exposing it as a market candle."""
    raw_time = row["time"]
    raw_volume = row["tick_volume"]
    if isinstance(raw_time, bool) or isinstance(raw_volume, bool):
        raise ValueError("MT5 candle timestamp and volume must be numeric.")
    stamp_value = float(raw_time)
    volume_value = float(raw_volume)
    if (
        not math.isfinite(stamp_value) or not stamp_value.is_integer()
        or not math.isfinite(volume_value) or volume_value < 0
        or not volume_value.is_integer()
    ):
        raise ValueError("MT5 candle timestamp or volume is invalid.")
    raw_prices = tuple(row[key] for key in ("open", "high", "low", "close"))
    if any(isinstance(value, bool) for value in raw_prices):
        raise ValueError("MT5 candle OHLC values must be numeric, not boolean.")
    opening, high, low, close = (float(value) for value in raw_prices)
    prices = (opening, high, low, close)
    if (
        not all(math.isfinite(value) and value > 0 for value in prices)
        or high < max(opening, close, low)
        or low > min(opening, close, high)
    ):
        raise ValueError("MT5 candle OHLC geometry is invalid.")
    return {
        "time": int(stamp_value), "open": opening, "high": high,
        "low": low, "close": close, "volume": int(volume_value),
    }


def _mt5_market_locked(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    mt5 = _mt5()
    try:
        actual = _mt5_symbol(mt5, symbol)
        tf_map = {
            "5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15,
            "1h": mt5.TIMEFRAME_H1, "4h": mt5.TIMEFRAME_H4,
        }
        ticks = mt5.copy_rates_from_pos(actual, tf_map[timeframe], 0, limit)
        if ticks is None or len(ticks) < 40:
            raise MarketUnavailable(f"MT5 returned insufficient {timeframe} candles for {actual}.")
        candles_by_time: dict[int, dict[str, Any]] = {}
        now_ts = datetime.now(timezone.utc).timestamp()
        for row in ticks:
            try:
                candle = _validated_mt5_candle(row)
                # Reject provider bars whose opening timestamp is in the future;
                # a small clock tolerance accommodates minor terminal skew.
                if candle["time"] > now_ts + 30:
                    continue
                candles_by_time[candle["time"]] = candle
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
        candles = [candles_by_time[stamp] for stamp in sorted(candles_by_time)]
        if len(candles) < 40:
            raise MarketUnavailable(
                f"MT5 returned fewer than 40 distinct valid {timeframe} candles for {actual}."
            )
        tick = mt5.symbol_info_tick(actual)
        info = mt5.symbol_info(actual)
        if tick is None:
            raise MarketUnavailable(f"MT5 has no current tick for {actual}.")
        _mt5_quote_age(tick.time)
        bid, ask = _parse_quote_pair(tick.bid, tick.ask, "MT5")
        return {
            "symbol": symbol, "provider_symbol": actual, "provider": "Exness MT5 terminal",
            "status": "LIVE", "price": _quote_midpoint_spread(bid, ask, "MT5")[0], "bid": bid, "ask": ask,
            "spread": _quote_midpoint_spread(bid, ask, "MT5")[1], "digits": int(info.digits) if info else 2,
            "updated_at": _utc_iso(int(float(tick.time))), "candles": candles,
        }
    finally:
        mt5.shutdown()


def mt5_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    # The MT5 Python API uses a shared terminal connection; serialize concurrent timeframe requests.
    with MT5_LOCK:
        return _mt5_market_locked(symbol, timeframe, limit)


def binance_market(timeframe: str, limit: int = 240) -> dict[str, Any]:
    """Free public BTCUSDT spot feed; tries Binance's alternate market-data host."""
    query = urllib.parse.urlencode({
        "symbol": "BTCUSDT",
        "interval": BINANCE_INTERVAL[timeframe],
        "limit": min(limit, 1000),
    })
    errors: list[str] = []
    # Some cloud regions receive HTTP 451 from api.binance.com. The Vision
    # host serves public market data and is a compatible fallback.
    for base in ("https://api.binance.com", "https://data-api.binance.vision"):
        try:
            rows = _http_json(f"{base}/api/v3/klines?{query}")
            ticker = _http_json(f"{base}/api/v3/ticker/bookTicker?symbol=BTCUSDT")
            if not isinstance(rows, list) or len(rows) < 40:
                raise MarketUnavailable(f"{base} returned insufficient BTCUSDT candles.")
            bid, ask = _parse_quote_pair(ticker["bidPrice"], ticker["askPrice"], "Binance")
            if (
                not math.isfinite(bid) or not math.isfinite(ask)
                or bid <= 0 or ask <= 0 or ask < bid
            ):
                raise MarketUnavailable(f"{base} returned an invalid BTCUSDT bid/ask.")
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            candles_by_time: dict[int, dict[str, Any]] = {}
            for row in rows:
                if not isinstance(row, (list, tuple)) or len(row) < 7:
                    continue
                try:
                    raw_stamp_ms, raw_close_ms = row[0], row[6]
                    if (
                        isinstance(raw_stamp_ms, bool) or isinstance(raw_close_ms, bool)
                        or not isinstance(raw_stamp_ms, (int, float))
                        or not isinstance(raw_close_ms, (int, float))
                        or not math.isfinite(raw_stamp_ms) or not math.isfinite(raw_close_ms)
                        or not float(raw_stamp_ms).is_integer()
                        or not float(raw_close_ms).is_integer()
                    ):
                        continue
                    stamp_ms, close_ms = int(raw_stamp_ms), int(raw_close_ms)
                    raw_values = row[1:6]
                    if any(isinstance(value, bool) for value in raw_values):
                        continue
                    opening, high, low, close, volume = (float(value) for value in raw_values)
                    values = (opening, high, low, close, volume)
                    if (
                        stamp_ms < 0 or close_ms < stamp_ms or stamp_ms > now_ms
                        or not all(math.isfinite(value) for value in values)
                        or opening <= 0 or low <= 0 or volume < 0
                        or high < low or low > min(opening, close) or high < max(opening, close)
                    ):
                        continue
                    stamp = stamp_ms // 1000
                    candles_by_time[stamp] = {
                        "time": stamp, "open": opening, "high": high, "low": low,
                        "close": close, "volume": volume, "closed": close_ms < now_ms,
                    }
                except (TypeError, ValueError, OverflowError):
                    continue
            candles = [candles_by_time[stamp] for stamp in sorted(candles_by_time)]
            if len(candles) < 40:
                raise MarketUnavailable(f"{base} returned fewer than 40 distinct valid BTCUSDT candles.")
            return {
                "symbol": "BTCUSD", "provider_symbol": "BTCUSDT",
                "provider": "Binance public spot API (Vision fallback)" if "vision" in base else "Binance public spot API",
                "status": "LIVE", "price": _quote_midpoint_spread(bid, ask, "Binance")[0], "bid": bid, "ask": ask,
                "spread": _quote_midpoint_spread(bid, ask, "Binance")[1], "digits": 2,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "candles": candles,
            }
        except (MarketUnavailable, KeyError, TypeError, ValueError) as exc:
            errors.append(f"{base}: {exc}")
    raise MarketUnavailable("All Binance BTC data hosts failed. " + " | ".join(errors))



OANDA_GRANULARITY = {"5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4"}

def _oanda_base() -> str:
    env = os.getenv("OANDA_ENVIRONMENT", "practice").strip().lower()
    if env in {"practice", "demo", "fxpractice"}:
        return "https://api-fxpractice.oanda.com"
    if env in {"live", "fxtrade"}:
        return "https://api-fxtrade.oanda.com"
    raise MarketUnavailable("OANDA_ENVIRONMENT must be 'practice' or 'live'.")

def _oanda_json(path: str, params: dict[str, str] | None = None) -> Any:
    token = os.getenv("OANDA_API_TOKEN", "").strip()
    account = os.getenv("OANDA_ACCOUNT_ID", "").strip()
    if not token or not account:
        raise MarketUnavailable("OANDA is not configured. Add OANDA_API_TOKEN and OANDA_ACCOUNT_ID in Render Environment.")
    base = _oanda_base()
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "GoldSightAI/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            detail = str(exc)
        if exc.code in (401, 403):
            raise MarketUnavailable("OANDA authentication/authorization failed. Check the token, account ID, and practice/live environment.") from exc
        if exc.code == 404:
            raise MarketUnavailable("OANDA account or instrument endpoint returned 404. Confirm the account supports the requested instrument.") from exc
        raise MarketUnavailable(f"OANDA HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise MarketUnavailable(f"OANDA request failed: {exc}") from exc

def _validated_oanda_candle(row: dict[str, Any]) -> dict[str, Any]:
    """Parse one OANDA candle, rejecting invalid timestamp, OHLC geometry, or volume."""
    stamp = datetime.fromisoformat(str(row["time"]).replace("Z", "+00:00"))
    if stamp.tzinfo is None or stamp.utcoffset() is None:
        raise ValueError("OANDA candle timestamp must include a timezone.")
    component = row.get("mid") or row.get("bid") or row.get("ask")
    if not isinstance(component, dict):
        raise ValueError("OANDA candle has no OHLC component.")
    raw_prices = tuple(component[key] for key in ("o", "h", "l", "c"))
    if any(isinstance(value, bool) for value in raw_prices):
        raise ValueError("OANDA candle OHLC values must be numeric, not boolean.")
    opening, high, low, close = (float(value) for value in raw_prices)
    if not all(math.isfinite(value) for value in (opening, high, low, close)):
        raise ValueError("OANDA candle OHLC values must be finite.")
    if low <= 0 or high < low or low > min(opening, close) or high < max(opening, close):
        raise ValueError("OANDA candle OHLC geometry is invalid.")
    raw_volume = row.get("volume", 0)
    if isinstance(raw_volume, bool):
        raise ValueError("OANDA candle volume must be a finite nonnegative integer.")
    volume_value = float(raw_volume)
    if (
        not math.isfinite(volume_value) or volume_value < 0
        or not volume_value.is_integer()
    ):
        raise ValueError("OANDA candle volume must be a finite nonnegative integer.")
    volume = int(volume_value)
    return {
        "time": int(stamp.timestamp()), "open": opening, "high": high,
        "low": low, "close": close, "volume": volume,
        "closed": bool(row.get("complete", False)),
    }


def _normalized_oanda_quote_timestamp(timestamp: Any) -> str:
    """Validate an ISO-8601 quote timestamp and return a canonical UTC string."""
    if not isinstance(timestamp, str) or not timestamp.strip():
        raise MarketUnavailable("OANDA returned an invalid quote timestamp.")
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("timestamp must include a timezone")
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, AttributeError) as exc:
        raise MarketUnavailable("OANDA returned an invalid quote timestamp.") from exc


def _oanda_quote_age(timestamp: Any) -> float:
    """Return quote age in seconds after validating freshness and timezone."""
    normalized = _normalized_oanda_quote_timestamp(timestamp)
    try:
        parsed = datetime.fromisoformat(normalized)
        age = datetime.now(timezone.utc).timestamp() - parsed.timestamp()
    except (ValueError, TypeError, OverflowError, AttributeError) as exc:
        raise MarketUnavailable("OANDA returned an invalid quote timestamp.") from exc
    if not math.isfinite(age):
        raise MarketUnavailable("OANDA returned an invalid quote timestamp.")
    if age > 180 or age < -30:
        raise MarketUnavailable(f"OANDA quote is stale ({int(age)} seconds old).")
    return age


def _oanda_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    token = os.getenv("OANDA_API_TOKEN", "").strip()
    account = os.getenv("OANDA_ACCOUNT_ID", "").strip()
    if not token or not account:
        raise MarketUnavailable("OANDA is not configured. Add OANDA_API_TOKEN and OANDA_ACCOUNT_ID in Render Environment.")
    instrument_env = "OANDA_INSTRUMENT_" + symbol
    instrument_defaults = {"XAUUSD": "XAU_USD", "BTCUSD": "BTC_USD", "EURUSD": "EUR_USD", "GBPUSD": "GBP_USD"}
    instrument = os.getenv(instrument_env, instrument_defaults[symbol]).strip().upper()
    # Verify availability for this account/region before fetching prices.
    listed = _oanda_json(f"/v3/accounts/{urllib.parse.quote(account, safe='')}/instruments")
    available = {item.get("name") for item in listed.get("instruments", [])}
    if instrument not in available:
        raise MarketUnavailable(f"{instrument} is not available on this OANDA account/region. Check the account's available instruments; set {instrument_env} only to a valid listed instrument.")
    candle_data = _oanda_json(
        f"/v3/accounts/{urllib.parse.quote(account, safe='')}/instruments/{urllib.parse.quote(instrument, safe='')}/candles",
        {"granularity": OANDA_GRANULARITY[timeframe], "count": str(min(limit, 500)), "price": "MBA"}
    )
    candles = []
    for row in candle_data.get("candles", []):
        if not isinstance(row, dict):
            continue
        try:
            candle = _validated_oanda_candle(row)
            if candle["time"] > datetime.now(timezone.utc).timestamp():
                continue
            candles.append(candle)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    candles = normalize_candles(candles)
    if len(candles) < 40:
        raise MarketUnavailable(f"OANDA returned only {len(candles)} distinct valid {timeframe} candles for {instrument}; at least 40 are required.")
    pricing = _oanda_json(f"/v3/accounts/{urllib.parse.quote(account, safe='')}/pricing", {"instruments": instrument})
    prices = pricing.get("prices", [])
    if not prices:
        raise MarketUnavailable(f"OANDA returned no current price for {instrument}.")
    quote = prices[0]
    bids = quote.get("bids") or []
    asks = quote.get("asks") or []
    if not bids or not asks:
        raise MarketUnavailable(f"OANDA quote for {instrument} has no valid bid/ask.")
    bid, ask = _parse_quote_pair(bids[0]["price"], asks[0]["price"], "OANDA")
    updated = quote.get("time")
    _oanda_quote_age(updated)
    if (
        not math.isfinite(bid) or not math.isfinite(ask)
        or bid <= 0 or ask <= 0 or ask < bid
    ):
        raise MarketUnavailable("OANDA returned an invalid bid/ask.")
    return {
        "symbol": symbol, "provider_symbol": instrument, "provider": "OANDA v20 API",
        "status": "LIVE", "price": _quote_midpoint_spread(bid, ask, "OANDA")[0], "bid": bid, "ask": ask,
        "spread": _quote_midpoint_spread(bid, ask, "OANDA")[1], "digits": 3 if instrument.startswith("XAU") else 5 if symbol in {"EURUSD", "GBPUSD"} else 2,
        "updated_at": updated, "candles": candles,
    }




def _mt5_quote_age(raw_timestamp: Any) -> float:
    """Validate an MT5 tick timestamp and return its age in seconds."""
    if isinstance(raw_timestamp, bool):
        raise MarketUnavailable("MT5 quote has an invalid tick timestamp.")
    try:
        tick_time = float(raw_timestamp)
        age = datetime.now(timezone.utc).timestamp() - tick_time
    except (TypeError, ValueError, OverflowError) as exc:
        raise MarketUnavailable("MT5 quote has an invalid tick timestamp.") from exc
    if not math.isfinite(tick_time) or not math.isfinite(age):
        raise MarketUnavailable("MT5 quote has an invalid tick timestamp.")
    if age > 180 or age < -30:
        raise MarketUnavailable(f"MT5 quote is stale ({int(age)} seconds old).")
    return age


def mt5_quote(symbol: str) -> dict[str, Any]:
    with MT5_LOCK:
        mt5 = _mt5()
        try:
            actual = _mt5_symbol(mt5, symbol)
            tick = mt5.symbol_info_tick(actual)
            info = mt5.symbol_info(actual)
            if tick is None:
                raise MarketUnavailable(f"MT5 has no current tick for {actual}.")
            _mt5_quote_age(tick.time)
            bid, ask = _parse_quote_pair(tick.bid, tick.ask, "MT5")
            midpoint, spread = _quote_midpoint_spread(bid, ask, "MT5")
            return {"symbol": symbol, "provider_symbol": actual, "provider": "Exness MT5 terminal · tick feed",
                "status": "LIVE", "price": midpoint, "bid": bid, "ask": ask, "spread": spread,
                "digits": int(info.digits) if info else 2, "updated_at": _utc_iso(int(float(tick.time))), "quote_type": "broker_quote"}
        finally:
            mt5.shutdown()


def _oanda_quote(symbol: str) -> dict[str, Any]:
    token = os.getenv("OANDA_API_TOKEN", "").strip()
    account = os.getenv("OANDA_ACCOUNT_ID", "").strip()
    if not token or not account:
        raise MarketUnavailable("OANDA quote credentials are not configured.")
    defaults = {"XAUUSD":"XAU_USD", "BTCUSD":"BTC_USD", "EURUSD":"EUR_USD", "GBPUSD":"GBP_USD"}
    instrument = os.getenv("OANDA_INSTRUMENT_" + symbol, defaults[symbol]).strip().upper()
    listed = _oanda_json(f"/v3/accounts/{urllib.parse.quote(account, safe='')}/instruments")
    if instrument not in {item.get("name") for item in listed.get("instruments", [])}:
        raise MarketUnavailable(f"{instrument} is not available on this OANDA account.")
    data = _oanda_json(f"/v3/accounts/{urllib.parse.quote(account, safe='')}/pricing", {"instruments": instrument})
    prices = data.get("prices", [])
    if not prices or not prices[0].get("bids") or not prices[0].get("asks"):
        raise MarketUnavailable(f"OANDA has no bid/ask for {instrument}.")
    q = prices[0]; bid, ask = _parse_quote_pair(q["bids"][0]["price"], q["asks"][0]["price"], "OANDA"); stamp=q.get("time")
    _oanda_quote_age(stamp)
    midpoint, spread = _quote_midpoint_spread(bid, ask, "OANDA")
    return {"symbol":symbol,"provider_symbol":instrument,"provider":"OANDA v20 API · pricing feed","status":"LIVE",
        "price":midpoint,"bid":bid,"ask":ask,"spread":spread,"digits":3 if symbol=="XAUUSD" else 5 if symbol in {"EURUSD","GBPUSD"} else 2,
        "updated_at":_normalized_oanda_quote_timestamp(stamp),"quote_type":"broker_quote"}


def fetch_live_quote(symbol: str) -> dict[str, Any]:
    """Fetch a quote independently of candles and signal analysis."""
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"}:
        raise MarketUnavailable("Unsupported symbol.")
    btc_provider = os.getenv("BTC_MARKET_DATA_PROVIDER", "").strip().lower()
    provider = btc_provider if symbol == "BTCUSD" and btc_provider else os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower()
    if symbol == "BTCUSD" and provider == "binance":
        query = urllib.parse.urlencode({"symbol": "BTCUSDT"})
        errors = []
        for base in ("https://api.binance.com", "https://data-api.binance.vision"):
            try:
                ticker = _http_json(f"{base}/api/v3/ticker/bookTicker?{query}")
                bid, ask = _parse_quote_pair(ticker["bidPrice"], ticker["askPrice"], "Binance")
                midpoint, spread = _quote_midpoint_spread(bid, ask, "Binance")
                return {"symbol": symbol, "provider_symbol": "BTCUSDT", "provider": "Binance public spot API",
                    "status": "LIVE", "price": midpoint, "bid": bid, "ask": ask, "spread": spread,
                    "digits": 2, "updated_at": datetime.now(timezone.utc).isoformat(), "quote_type": "spot_proxy"}
            except (MarketUnavailable, KeyError, TypeError, ValueError) as exc:
                errors.append(str(exc))
        raise MarketUnavailable("BTC quote feed unavailable: " + " | ".join(errors))
    if provider == "exness":
        from app.exness import exness_quote
        return exness_quote(symbol)
    if provider == "oanda":
        return _oanda_quote(symbol)
    if provider == "mt5":
        return mt5_quote(symbol)
    raise MarketUnavailable("Configured market quote provider is unsupported.")

def _fetch_market_unchecked(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"}:
        raise MarketUnavailable("Supported symbols: XAUUSD, BTCUSD, EURUSD and GBPUSD.")
    if timeframe not in TIMEFRAME_SECONDS:
        raise MarketUnavailable("Timeframe must be 5m, 15m, 1h, or 4h.")
    if not isinstance(limit, int) or limit < 45 or limit > 1000:
        raise MarketUnavailable("Candle limit must be an integer between 45 and 1000.")
    # BTC may use an explicitly selected independent spot feed while Gold
    # remains on the account's configured provider. Never silently substitute.
    provider = os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower()
    btc_provider = os.getenv("BTC_MARKET_DATA_PROVIDER", "").strip().lower()
    if symbol == "BTCUSD" and btc_provider:
        if btc_provider == "binance":
            return binance_market(timeframe, limit=limit)
        if btc_provider not in {"exness", "oanda", "mt5"}:
            raise MarketUnavailable(
                "BTC_MARKET_DATA_PROVIDER must be 'binance', 'exness', 'oanda', or 'mt5'."
            )
        provider = btc_provider
    if provider == "exness":
        from app.exness import exness_market
        return exness_market(symbol, timeframe, limit=limit)
    if provider == "oanda":
        return _oanda_market(symbol, timeframe, limit=limit)
    if provider == "mt5":
        return mt5_market(symbol, timeframe, limit=limit)
    raise MarketUnavailable("MARKET_DATA_PROVIDER must be 'exness', 'oanda', or 'mt5'.")



def validate_candle_continuity(
    candles: list[dict[str, Any]], timeframe: str, symbol: str,
) -> None:
    """Check timestamp order and preserve sparse non-crypto provider history.

    Crypto trades continuously, so every adjacent BTC candle must be exactly one
    timeframe apart. FX/metals providers may omit intervals with no ticks; keep
    those real bars for chart display rather than rejecting the whole feed or
    inventing flat candles. Signal callers separately require a live spread.
    """
    seconds = TIMEFRAME_SECONDS.get(timeframe)
    if seconds is None:
        raise MarketUnavailable(f"Unsupported timeframe for continuity check: {timeframe}.")
    ordered = normalize_candles(candles)
    if len(ordered) < 2:
        raise MarketUnavailable("Insufficient distinct candles for continuity validation.")
    crypto = symbol == "BTCUSD"
    for previous, current in zip(ordered, ordered[1:]):
        gap = int(current["time"]) - int(previous["time"])
        if gap <= 0:
            raise MarketUnavailable("Candle timestamps are not strictly increasing.")
        if gap == seconds:
            continue
        if crypto:
            raise MarketUnavailable(
                f"Missing {timeframe} candle interval for {symbol}: "
                f"expected {seconds}s between bars, received {gap}s."
            )


def fetch_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    """Fetch provider data and reject suspicious intraday candle gaps."""
    result = _fetch_market_unchecked(symbol, timeframe, limit)
    candles = result.get("candles")
    if not isinstance(candles, list):
        raise MarketUnavailable("Market provider returned no candle list.")
    validate_candle_continuity(candles, timeframe, symbol)
    return result


def calculate_trend(candles: list[dict[str, Any]], timeframe: str) -> str:
    """Return the 9/21 EMA trend using only fully completed, timestamp-verified candles."""
    bars = completed_candles(candles, timeframe)
    if len(bars) < 40:
        return "UNKNOWN"
    closes = [float(row["close"]) for row in bars]
    # Calculate both EMAs from the same history window to avoid a seed-window
    # bias that can falsely tilt the displayed trend.
    ema_window = closes[-120:]
    def ema(values: list[float], period: int) -> float:
        alpha = 2 / (period + 1)
        value = values[0]
        for item in values[1:]:
            value = alpha * item + (1 - alpha) * value
        return value
    fast, slow = ema(ema_window, 9), ema(ema_window, 21)
    return "BULLISH" if fast > slow else "BEARISH" if fast < slow else "RANGE"


def _average_true_range(bars: list[dict[str, Any]], period: int = 14) -> float:
    """Compute Wilder-style input True Range's simple average over the latest period.

    True Range includes gaps from the prior candle close; a range-only average
    understates volatility when price gaps between bars.
    """
    if period < 1 or len(bars) < period + 1:
        raise ValueError("ATR requires at least period + 1 candles.")
    true_ranges: list[float] = []
    for previous, current in zip(bars, bars[1:]):
        high = float(current["high"])
        low = float(current["low"])
        previous_close = float(previous["close"])
        true_ranges.append(max(
            high - low,
            abs(high - previous_close),
            abs(low - previous_close),
        ))
    latest = true_ranges[-period:]
    if not all(math.isfinite(value) and value >= 0 for value in latest):
        raise ValueError("ATR inputs must be finite nonnegative ranges.")
    return sum(latest) / period



def _directional_efficiency(bars: list[dict[str, Any]], lookback: int = 20) -> float:
    """Measure net directional progress against total close-to-close travel."""
    if lookback < 2 or len(bars) < lookback + 1:
        return 0.0
    closes = [float(bar["close"]) for bar in bars[-(lookback + 1):]]
    if not all(math.isfinite(value) and value > 0 for value in closes):
        return 0.0
    path = sum(abs(current - previous) for previous, current in zip(closes, closes[1:]))
    if path <= 0:
        return 0.0
    return abs(closes[-1] - closes[0]) / path


def _is_choppy_market(bars: list[dict[str, Any]], lookback: int = 20, threshold: float = 0.18) -> bool:
    """Flag low-efficiency price action; this is a conservative descriptive filter."""
    if not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError("Efficiency threshold must be between 0 and 1.")
    return _directional_efficiency(bars, lookback) < threshold


def _confirmed_swing_structure(
    bars: list[dict[str, Any]], left: int = 2, right: int = 2,
) -> dict[str, Any]:
    """Detect BOS/CHoCH only when pivot highs/lows are confirmed by right bars."""
    if left < 1 or right < 1:
        raise ValueError("Swing confirmation windows must be positive.")
    pivot_highs: list[tuple[int, float]] = []
    pivot_lows: list[tuple[int, float]] = []
    for index in range(left, len(bars) - right):
        high = float(bars[index]["high"])
        low = float(bars[index]["low"])
        neighborhood = bars[index-left:index+right+1]
        if all(high >= float(item["high"]) for item in neighborhood) and any(
            high > float(item["high"]) for item in neighborhood if item is not bars[index]
        ):
            pivot_highs.append((index, high))
        if all(low <= float(item["low"]) for item in neighborhood) and any(
            low < float(item["low"]) for item in neighborhood if item is not bars[index]
        ):
            pivot_lows.append((index, low))

    last_index = len(bars) - 1
    confirmed_highs = [item for item in pivot_highs if item[0] + right <= last_index]
    confirmed_lows = [item for item in pivot_lows if item[0] + right <= last_index]
    swing_high = confirmed_highs[-1][1] if confirmed_highs else float(bars[-1]["high"])
    swing_low = confirmed_lows[-1][1] if confirmed_lows else float(bars[-1]["low"])

    prior_bias = "RANGE"
    if len(confirmed_highs) >= 2 and len(confirmed_lows) >= 2:
        high_direction = confirmed_highs[-1][1] - confirmed_highs[-2][1]
        low_direction = confirmed_lows[-1][1] - confirmed_lows[-2][1]
        if high_direction > 0 and low_direction > 0:
            prior_bias = "BULLISH"
        elif high_direction < 0 and low_direction < 0:
            prior_bias = "BEARISH"

    close = float(bars[-1]["close"])
    bullish_break = bool(confirmed_highs and close > confirmed_highs[-1][1])
    bearish_break = bool(confirmed_lows and close < confirmed_lows[-1][1])
    bullish_choch = bullish_break and prior_bias == "BEARISH"
    bearish_choch = bearish_break and prior_bias == "BULLISH"
    return {
        "swing_high": swing_high, "swing_low": swing_low,
        "bullish_bos": bullish_break and not bullish_choch,
        "bearish_bos": bearish_break and not bearish_choch,
        "bullish_choch": bullish_choch, "bearish_choch": bearish_choch,
        "prior_bias": prior_bias,
    }



def _supply_demand_alignment_passes(context: dict[str, Any]) -> bool:
    """Require a meaningful matching zone within one ATR of the signal price."""
    zone = context.get("nearest_zone")
    strength = zone.get("strength_score") if isinstance(zone, dict) else None
    distance = context.get("distance_atr")
    return bool(
        context.get("status") in {"IN_ZONE", "NEAR_ZONE"}
        and isinstance(strength, (int, float)) and not isinstance(strength, bool)
        and math.isfinite(strength) and strength >= 40
        and isinstance(distance, (int, float)) and not isinstance(distance, bool)
        and math.isfinite(distance) and 0 <= distance <= 1.0
    )


def _supply_demand_context(bars: list[dict[str, Any]], *, price: float, side: str, atr: float) -> dict[str, Any]:
    """Summarize nearest confirmed zone on the signal side; context only, not a trigger."""
    detected = detect_supply_demand_zones(bars, atr=atr, left=3, right=3, tolerance_atr=0.5)
    key = "demand" if side == "BUY" else "supply"
    zones = detected[key]
    if not zones:
        return {"side": key.upper(), "status": "NO_CONFIRMED_ZONE", "nearest_zone": None, "distance_atr": None, "evidence_label": detected["evidence_label"]}
    def distance(zone: dict[str, Any]) -> float:
        if zone["lower"] <= price <= zone["upper"]:
            return 0.0
        return min(abs(price - zone["lower"]), abs(price - zone["upper"]))
    nearest = min(zones, key=distance)
    distance_atr = distance(nearest) / atr
    status = "IN_ZONE" if distance_atr == 0 else "NEAR_ZONE" if distance_atr <= 1.0 else "DISTANT"
    return {
        "side": key.upper(), "status": status,
        "nearest_zone": {"lower": nearest["lower"], "upper": nearest["upper"], "midpoint": nearest["midpoint"], "pivot_count": nearest["pivot_count"], "touch_count": nearest["touch_count"], "strength_score": nearest["strength_score"], "last_seen": nearest["last_seen"], "last_reaction": nearest["last_reaction"]},
        "distance_atr": round(distance_atr, 4), "evidence_label": detected["evidence_label"],
    }


def _is_late_displacement(candle: dict[str, Any], atr: float, max_range_atr: float = 2.5) -> bool:
    """Flag an entry candle whose full range is already excessively extended."""
    if not math.isfinite(atr) or atr <= 0 or not math.isfinite(max_range_atr) or max_range_atr <= 0:
        return True
    try:
        candle_range = float(candle["high"]) - float(candle["low"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return True
    if not math.isfinite(candle_range) or candle_range < 0:
        return True
    return candle_range >= atr * max_range_atr


def _validate_risk_levels(
    side: str, entry: float, stop_loss: float, risk: float,
    take_profits: list[float],
) -> bool:
    """Check finite, correctly sided stop and minimum 1R/2R/3R target distances."""
    values = [entry, stop_loss, risk, *take_profits]
    if len(take_profits) != 3 or not all(math.isfinite(value) for value in values):
        return False
    if risk <= 0 or (side == "BUY" and stop_loss >= entry) or (
        side == "SELL" and stop_loss <= entry
    ):
        return False
    if side not in {"BUY", "SELL"}:
        return False
    distances = (
        [target - entry for target in take_profits]
        if side == "BUY" else [entry - target for target in take_profits]
    )
    actual_rr = [distance / risk for distance in distances]
    return all(distance > 0 for distance in distances) and all(
        math.isfinite(actual) and actual + 1e-9 >= required
        for actual, required in zip(actual_rr, (1.0, 2.0, 3.0))
    )


def _validate_spread_risk(risk: float, spread: float | None) -> bool:
    """Require finite nonnegative spread and at least a 2x stop/spread buffer."""
    if not math.isfinite(risk) or risk <= 0:
        return False
    if spread is None:
        return True
    if not math.isfinite(spread) or spread < 0:
        return False
    return spread == 0 or risk >= spread * 2


def analyze(
    candles: list[dict[str, Any]],
    symbol: str,
    timeframe: str,
    spread: float | None,
    higher_timeframe_candles: list[dict[str, Any]] | None = None,
    *,
    include_last_completed: bool = False,
) -> dict[str, Any]:
    """Conservative setup detector. Live callers may pass only timestamp-verified closed bars."""
    # Backtests preserve the historical convention of excluding the final forming bar.
    # Live API callers explicitly pass a timestamp-filtered completed-bar series.
    bars = normalize_candles(candles) if include_last_completed else normalize_candles(candles)[:-1]
    if len(bars) < 40:
        return no_setup("Not enough completed candles to evaluate structure.")
    closes = [x["close"] for x in bars]
    highs = [x["high"] for x in bars]
    lows = [x["low"] for x in bars]

    def ema(values: list[float], period: int) -> float:
        alpha = 2 / (period + 1)
        value = values[0]
        for item in values[1:]:
            value = alpha * item + (1 - alpha) * value
        return value

    ema_window = closes[-120:]
    previous_ema_window = closes[:-1][-120:]
    fast, slow = ema(ema_window, 9), ema(ema_window, 21)
    prev_fast, prev_slow = ema(previous_ema_window, 9), ema(previous_ema_window, 21)
    trend = "BULLISH" if fast > slow else "BEARISH" if fast < slow else "RANGE"
    previous_trend = "BULLISH" if prev_fast > prev_slow else "BEARISH" if prev_fast < prev_slow else "RANGE"

    higher_trend = "NOT_REQUIRED"
    if timeframe != "4h":
        if not higher_timeframe_candles or len(higher_timeframe_candles) < 41:
            return no_setup("Higher-timeframe confirmation is unavailable; no trade until it can be checked.")
        higher_bars = normalize_candles(higher_timeframe_candles) if include_last_completed else normalize_candles(higher_timeframe_candles)[:-1]
        if len(higher_bars) < 40:
            return no_setup("Not enough completed higher-timeframe candles for trend confirmation.")
        higher_closes = [x["close"] for x in higher_bars]
        def higher_ema(values: list[float], period: int) -> float:
            alpha = 2 / (period + 1)
            value = values[0]
            for item in values[1:]:
                value = alpha * item + (1 - alpha) * value
            return value
        higher_ema_window = higher_closes[-120:]
        higher_fast = higher_ema(higher_ema_window, 9)
        higher_slow = higher_ema(higher_ema_window, 21)
        higher_trend = "BULLISH" if higher_fast > higher_slow else "BEARISH" if higher_fast < higher_slow else "RANGE"
    structure = _confirmed_swing_structure(bars)
    recent_high = structure["swing_high"]
    recent_low = structure["swing_low"]
    prev = bars[-2]
    last = bars[-1]
    bullish_bos = structure["bullish_bos"]
    bearish_bos = structure["bearish_bos"]
    bullish_choch = structure["bullish_choch"]
    bearish_choch = structure["bearish_choch"]
    bullish_sweep = last["low"] < min(lows[-11:-1]) and last["close"] > min(lows[-11:-1])
    bearish_sweep = last["high"] > max(highs[-11:-1]) and last["close"] < max(highs[-11:-1])
    bullish_candle = last["close"] > last["open"] and last["close"] > prev["high"]
    bearish_candle = last["close"] < last["open"] and last["close"] < prev["low"]
    atr = _average_true_range(bars, 14)
    price = last["close"]
    # For BOS/CHoCH triggers, avoid entries already extended far beyond the
    # confirmed pivot; favor waiting for a pullback/retest near that level.
    breakout_level = recent_high if trend == "BULLISH" else recent_low
    breakout_distance_atr = (
        (price - breakout_level) / atr if trend == "BULLISH"
        else (breakout_level - price) / atr
    )
    directional_bos = (bullish_bos or bullish_choch) if trend == "BULLISH" else (bearish_bos or bearish_choch)
    if directional_bos and breakout_distance_atr > 0.75:
        return no_setup(
            f"Breakout entry is extended {breakout_distance_atr:.2f} ATR beyond the confirmed structure level; "
            "wait for a pullback/retest near the breakout level."
        )
    # Avoid chasing a completed displacement candle that has already expanded
    # beyond a conservative ATR-based range. Wait for a pullback/retest instead.
    if _is_late_displacement(last, atr):
        return no_setup(
            "Late entry blocked: the completed displacement candle is at least 2.5 ATR wide; "
            "wait for a pullback or retest before considering a setup."
        )
    # Reject range-bound churn unless the completed candle delivers a confirmed
    # BOS/CHoCH. Sweeps alone are not enough to bypass this quality filter.
    has_confirmed_break = bullish_bos or bearish_bos or bullish_choch or bearish_choch
    if _is_choppy_market(bars) and not has_confirmed_break:
        return no_setup(
            "Recent price action is choppy (low directional efficiency); wait for a confirmed BOS/CHoCH."
        )
    zone_context = _supply_demand_context(bars, price=price, side=("BUY" if trend == "BULLISH" else "SELL"), atr=atr)
    reasons: list[str] = []
    side = None
    if timeframe != "4h" and higher_trend != trend:
        return {
            "status": "NO SETUP", "side": "NO SETUP", "entry": None, "stop_loss": None,
            "take_profits": [], "rr": None, "confidence": None,
            "reasons": [f"Timeframes disagree: {timeframe} trend is {trend}, higher timeframe trend is {higher_trend}."],
            "invalidation": "Wait until the entry timeframe and higher timeframe align.",
            "signal_time": _utc_iso(last["time"]), "trend": trend,
            "higher_timeframe_trend": higher_trend,
        }
    if trend == "BULLISH" and (bullish_bos or bullish_sweep or bullish_choch) and bullish_candle:
        side = "BUY"
        if bullish_bos: reasons.append("Confirmed-candle bullish break of a confirmed swing high (BOS).")
        if bullish_sweep: reasons.append("Recent sell-side liquidity sweep and close back above the swept low.")
        if bullish_choch: reasons.append("Confirmed bullish break against prior bearish swing structure (CHoCH).")
        reasons.append("Bullish candle confirmation closes above the prior candle high.")
        reasons.append("9-period EMA is above 21-period EMA on completed candles.")
        sl = min(last["low"], recent_low) - 0.15 * atr
        risk = price - sl
        tp1, tp2, tp3 = price + risk, price + 2*risk, price + 3*risk
    elif trend == "BEARISH" and (bearish_bos or bearish_sweep or bearish_choch) and bearish_candle:
        side = "SELL"
        if bearish_bos: reasons.append("Confirmed-candle bearish break of a confirmed swing low (BOS).")
        if bearish_sweep: reasons.append("Recent buy-side liquidity sweep and close back below the swept high.")
        if bearish_choch: reasons.append("Confirmed bearish break against prior bullish swing structure (CHoCH).")
        reasons.append("Bearish candle confirmation closes below the prior candle low.")
        reasons.append("9-period EMA is below 21-period EMA on completed candles.")
        sl = max(last["high"], recent_high) + 0.15 * atr
        risk = sl - price
        tp1, tp2, tp3 = price - risk, price - 2*risk, price - 3*risk
    else:
        return {
            "status": "NO SETUP", "side": "NO SETUP", "entry": None, "stop_loss": None,
            "take_profits": [], "rr": None, "confidence": None,
            "reasons": ["No aligned trend, structure break/liquidity sweep, and candle confirmation."],
            "invalidation": "No active setup to invalidate; wait for completed-candle confirmation.",
            "signal_time": _utc_iso(last["time"]), "trend": trend,
        }
    # Supply/demand is a setup filter, not merely card decoration: only take
    # structure-confirmed entries at/near a meaningful matching zone.
    zone = zone_context.get("nearest_zone")
    zone_aligned = _supply_demand_alignment_passes(zone_context)
    if not zone_aligned:
        return no_setup(
            "Structure and candle confirmation appeared, but no sufficiently strong "
            "matching supply/demand zone is within 1.0 ATR; wait for zone alignment."
        )
    reasons.append(
        f"Supply/demand alignment filter passed: matching {zone_context['side'].lower()} "
        f"zone strength {zone['strength_score']}/100 at {zone_context['distance_atr']:.2f} ATR."
    )
    if not _validate_risk_levels(side, price, sl, risk, [tp1, tp2, tp3]):
        return no_setup("Stop-loss or take-profit levels failed risk/reward validation.")
    if not _validate_spread_risk(risk, spread):
        return no_setup("Spread is invalid or too large relative to the proposed stop distance; no trade.")
    # This is a rule score, deliberately not represented as win probability.
    confidence = min(86, 52 + 8*len(reasons) + (6 if (bullish_bos if side == "BUY" else bearish_bos) else 0))
    # Sniper is a deliberately rare sub-class: same-candle liquidity sweep,
    # structural break, displacement confirmation, aligned higher trend and
    # enough room between spread and stop. Missing spread data cannot qualify.
    candle_range = max(float(last["high"]) - float(last["low"]), 1e-12)
    candle_body_ratio = abs(float(last["close"]) - float(last["open"])) / candle_range
    sniper_sweep = bullish_sweep if side == "BUY" else bearish_sweep
    sniper_bos = bullish_bos if side == "BUY" else bearish_bos
    sniper = bool(
        sniper_sweep and sniper_bos and candle_body_ratio >= 0.65
        and higher_trend == trend and spread is not None and spread > 0
        and risk >= spread * 4
    )
    if sniper:
        reasons.append("SNIPER qualification: liquidity sweep + structure break + strong displacement candle, aligned higher timeframe, and minimum 4:1 stop-distance-to-spread buffer.")
    if zone_context["status"] in {"IN_ZONE", "NEAR_ZONE"}:
        zone = zone_context["nearest_zone"]
        reasons.append(
            f"Supply/demand context: price is {zone_context['status'].lower().replace('_', ' ')} "
            f"the confirmed {zone_context['side'].lower()} zone {zone['lower']:.5f}–{zone['upper']:.5f} "
            f"({zone_context['distance_atr']:.2f} ATR away; evidence score {zone['strength_score']}/100, "
            "not a win probability)."
        )
    return {
        "status": side, "side": side, "entry_style": "SNIPER" if sniper else "STANDARD",
        "supply_demand_context": zone_context,
        "entry": price, "stop_loss": sl,
        "take_profits": [tp1, tp2, tp3], "rr": [1.0, 2.0, 3.0],
        "confidence": confidence, "confidence_label": "Rule-alignment score; not win probability",
        "reasons": reasons,
        "invalidation": f"Setup invalid if a completed {timeframe} candle closes beyond stop-loss {sl:.5f}.",
        "signal_time": _utc_iso(last["time"]), "trend": trend,
        "higher_timeframe_trend": higher_trend,
        "spread": spread,
    }


def no_setup(reason: str) -> dict[str, Any]:
    return {
        "status": "NO SETUP", "side": "NO SETUP", "entry": None, "stop_loss": None,
        "take_profits": [], "rr": None, "confidence": None, "reasons": [reason],
        "invalidation": "No active setup; wait for new completed candles.",
        "signal_time": datetime.now(timezone.utc).isoformat(), "trend": "UNKNOWN",
    }

