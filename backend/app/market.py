"""Live market adapters and transparent rule-based signal analysis.

Gold quotes come only from a connected MetaTrader 5 terminal (e.g. Exness).
BTC can use the public Binance spot feed when MT5 is unavailable. No synthetic
prices or candles are returned from these providers.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from threading import Lock

TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
BINANCE_INTERVAL = {"5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h"}
MT5_LOCK = Lock()


class MarketUnavailable(RuntimeError):
    pass


def _utc_iso(value: int | float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def normalize_candles(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return unique candles in ascending timestamp order; latest duplicate wins."""
    by_time: dict[int, dict[str, Any]] = {}
    for candle in candles:
        try:
            stamp = int(candle["time"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        by_time[stamp] = candle
    return [by_time[stamp] for stamp in sorted(by_time)]


def completed_candles(
    candles: list[dict[str, Any]],
    timeframe: str,
    now_ts: float | None = None,
) -> list[dict[str, Any]]:
    """Select bars whose full timeframe has elapsed; never treat future bars as closed."""
    seconds = TIMEFRAME_SECONDS.get(timeframe)
    if seconds is None:
        raise MarketUnavailable(f"Unsupported timeframe for candle completion: {timeframe}.")
    now = datetime.now(timezone.utc).timestamp() if now_ts is None else float(now_ts)
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
    if not mt5.initialize():
        raise MarketUnavailable(
            f"MT5 initialize failed (code {mt5.last_error()}). Open Exness MT5, "
            "sign in, enable algorithmic trading if required, then restart the API."
        )
    return mt5


def _mt5_symbol(mt5, symbol: str) -> str:
    configured = os.getenv("MT5_SYMBOL_" + symbol.upper())
    candidates = [configured] if configured else []
    candidates += [symbol, "XAUUSD.a", "XAUUSDm", "GOLD"] if symbol == "XAUUSD" else ["BTCUSD", "BTCUSDm", "BTCUSD.a"]
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
        candles = [{
            "time": int(row["time"]), "open": float(row["open"]),
            "high": float(row["high"]), "low": float(row["low"]),
            "close": float(row["close"]), "volume": int(row["tick_volume"]),
        } for row in ticks]
        tick = mt5.symbol_info_tick(actual)
        info = mt5.symbol_info(actual)
        if tick is None:
            raise MarketUnavailable(f"MT5 has no current tick for {actual}.")
        tick_age = datetime.now(timezone.utc).timestamp() - float(tick.time)
        if tick_age > 180 or tick_age < -30:
            raise MarketUnavailable(f"MT5 quote for {actual} is stale ({int(tick_age)} seconds old); waiting for a fresh tick.")
        bid, ask = float(tick.bid), float(tick.ask)
        if bid <= 0 or ask <= 0:
            raise MarketUnavailable(f"MT5 returned an invalid bid/ask for {actual}.")
        return {
            "symbol": symbol, "provider_symbol": actual, "provider": "Exness MT5 terminal",
            "status": "LIVE", "price": (bid + ask) / 2, "bid": bid, "ask": ask,
            "spread": ask - bid, "digits": int(info.digits) if info else 2,
            "updated_at": _utc_iso(int(tick.time)), "candles": candles,
        }
    finally:
        mt5.shutdown()


def mt5_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    # The MT5 Python API uses a shared terminal connection; serialize concurrent timeframe requests.
    with MT5_LOCK:
        return _mt5_market_locked(symbol, timeframe, limit)


def binance_market(timeframe: str, limit: int = 240) -> dict[str, Any]:
    """Free public BTCUSDT spot feed; no API key required."""
    base = "https://api.binance.com"
    q = urllib.parse.urlencode({"symbol": "BTCUSDT", "interval": BINANCE_INTERVAL[timeframe], "limit": min(limit, 1000)})
    rows = _http_json(f"{base}/api/v3/klines?{q}")
    ticker = _http_json(f"{base}/api/v3/ticker/bookTicker?symbol=BTCUSDT")
    bid, ask = float(ticker["bidPrice"]), float(ticker["askPrice"])
    candles = [{
        "time": int(r[0] / 1000), "open": float(r[1]), "high": float(r[2]),
        "low": float(r[3]), "close": float(r[4]), "volume": float(r[5]),
        "closed": int(r[6]) < int(datetime.now(timezone.utc).timestamp() * 1000),
    } for r in rows]
    return {
        "symbol": "BTCUSD", "provider_symbol": "BTCUSDT", "provider": "Binance public spot API",
        "status": "LIVE", "price": (bid + ask) / 2, "bid": bid, "ask": ask,
        "spread": ask - bid, "digits": 2, "updated_at": datetime.now(timezone.utc).isoformat(),
        "candles": candles,
    }



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

def _oanda_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    token = os.getenv("OANDA_API_TOKEN", "").strip()
    account = os.getenv("OANDA_ACCOUNT_ID", "").strip()
    if not token or not account:
        raise MarketUnavailable("OANDA is not configured. Add OANDA_API_TOKEN and OANDA_ACCOUNT_ID in Render Environment.")
    instrument_env = "OANDA_INSTRUMENT_" + symbol
    instrument = os.getenv(instrument_env, "XAU_USD" if symbol == "XAUUSD" else "BTC_USD").strip().upper()
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
        component = row.get("mid") or row.get("bid") or row.get("ask")
        if not component:
            continue
        stamp = datetime.fromisoformat(row["time"].replace("Z", "+00:00")).timestamp()
        candles.append({
            "time": int(stamp), "open": float(component["o"]), "high": float(component["h"]),
            "low": float(component["l"]), "close": float(component["c"]),
            "volume": int(row.get("volume", 0)), "closed": bool(row.get("complete", False))
        })
    if len(candles) < 40:
        raise MarketUnavailable(f"OANDA returned only {len(candles)} {timeframe} candles for {instrument}; at least 40 are required.")
    pricing = _oanda_json(f"/v3/accounts/{urllib.parse.quote(account, safe='')}/pricing", {"instruments": instrument})
    prices = pricing.get("prices", [])
    if not prices:
        raise MarketUnavailable(f"OANDA returned no current price for {instrument}.")
    quote = prices[0]
    bids = quote.get("bids") or []
    asks = quote.get("asks") or []
    if not bids or not asks:
        raise MarketUnavailable(f"OANDA quote for {instrument} has no valid bid/ask.")
    bid, ask = float(bids[0]["price"]), float(asks[0]["price"])
    updated = quote.get("time")
    if not updated:
        raise MarketUnavailable("OANDA quote has no timestamp.")
    age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp()
    if age > 180 or age < -30:
        raise MarketUnavailable(f"OANDA quote is stale ({int(age)} seconds old).")
    if bid <= 0 or ask <= 0 or ask < bid:
        raise MarketUnavailable("OANDA returned an invalid bid/ask.")
    return {
        "symbol": symbol, "provider_symbol": instrument, "provider": "OANDA v20 API",
        "status": "LIVE", "price": (bid + ask) / 2, "bid": bid, "ask": ask,
        "spread": ask - bid, "digits": 3 if instrument.startswith("XAU") else 2,
        "updated_at": updated, "candles": candles,
    }


def fetch_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise MarketUnavailable("Only XAUUSD and BTCUSD are supported.")
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

    fast, slow = ema(closes[-80:], 9), ema(closes[-120:], 21)
    prev_fast, prev_slow = ema(closes[:-1][-80:], 9), ema(closes[:-1][-120:], 21)
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
        higher_fast = higher_ema(higher_closes[-80:], 9)
        higher_slow = higher_ema(higher_closes[-120:], 21)
        higher_trend = "BULLISH" if higher_fast > higher_slow else "BEARISH" if higher_fast < higher_slow else "RANGE"
    recent_high, recent_low = max(highs[-21:-1]), min(lows[-21:-1])
    prev = bars[-2]
    last = bars[-1]
    bullish_bos = last["close"] > recent_high
    bearish_bos = last["close"] < recent_low
    bullish_choch = trend == "BULLISH" and previous_trend == "BEARISH"
    bearish_choch = trend == "BEARISH" and previous_trend == "BULLISH"
    bullish_sweep = last["low"] < min(lows[-11:-1]) and last["close"] > min(lows[-11:-1])
    bearish_sweep = last["high"] > max(highs[-11:-1]) and last["close"] < max(highs[-11:-1])
    bullish_candle = last["close"] > last["open"] and last["close"] > prev["high"]
    bearish_candle = last["close"] < last["open"] and last["close"] < prev["low"]
    atr = sum((bars[i]["high"] - bars[i]["low"]) for i in range(len(bars)-14, len(bars))) / 14
    price = last["close"]
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
        if bullish_bos: reasons.append("Confirmed-candle bullish break of recent 20-candle structure (BOS).")
        if bullish_sweep: reasons.append("Recent sell-side liquidity sweep and close back above the swept low.")
        if bullish_choch: reasons.append("EMA trend changed from bearish to bullish, a possible change of character (CHoCH).")
        reasons.append("Bullish candle confirmation closes above the prior candle high.")
        reasons.append("9-period EMA is above 21-period EMA on completed candles.")
        sl = min(last["low"], recent_low) - 0.15 * atr
        risk = price - sl
        tp1, tp2, tp3 = price + risk, price + 2*risk, price + 3*risk
    elif trend == "BEARISH" and (bearish_bos or bearish_sweep or bearish_choch) and bearish_candle:
        side = "SELL"
        if bearish_bos: reasons.append("Confirmed-candle bearish break of recent 20-candle structure (BOS).")
        if bearish_sweep: reasons.append("Recent buy-side liquidity sweep and close back below the swept high.")
        if bearish_choch: reasons.append("EMA trend changed from bullish to bearish, a possible change of character (CHoCH).")
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
    if spread is not None and spread > 0 and risk < spread * 2:
        return no_setup("Spread is too large relative to the proposed stop distance; no trade.")
    if risk <= 0 or not all(map(lambda x: x > 0, [tp1, tp2, tp3])):
        return no_setup("Calculated risk levels failed validation.")
    # This is a rule score, deliberately not represented as win probability.
    confidence = min(86, 52 + 8*len(reasons) + (6 if (bullish_bos if side == "BUY" else bearish_bos) else 0))
    return {
        "status": side, "side": side, "entry": price, "stop_loss": sl,
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
