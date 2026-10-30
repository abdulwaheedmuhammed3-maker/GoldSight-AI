from datetime import datetime, timezone, timedelta
import os
import hmac
from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.market import MarketUnavailable, analyze, fetch_market, no_setup, normalize_candles, completed_candles, calculate_trend
from app.backtest import run_backtest
from app.timeframes import aggregate_15m_to_45m
from app.exness import exness_historical_candles
from app.setup_history import database_configured, list_setups
from app.setup_recorder import recorder_status, start_recorder, stop_recorder
from app.fundamentals import get_fundamental_news, classify_trade_context
from app.risk_calculator import calculate_position_size
from app.currency_rates import get_currency_rates

app = FastAPI(title="GoldSight AI API", version="0.3.0", description="Live market data and explainable rule-based signals. No order execution.")
# The API is public/read-only, so allow the deployed static frontend even if a
# Render environment variable has not yet been synced from render.yaml.
# CORS_ORIGINS may add explicit origins; credentials are intentionally disabled.
configured_origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "").split(",") if x.strip()]
default_origins = [
    "https://goldsight-ai-web.onrender.com",
    "https://tradesight-web.onrender.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
origins = ["*"] if "*" in configured_origins else list(dict.fromkeys(default_origins + configured_origins))
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def start_setup_history_recorder():
    await start_recorder()


@app.on_event("shutdown")
async def stop_setup_history_recorder():
    await stop_recorder()




@app.get("/api/v1/push/public-key")
def push_public_key():
    from app.push_notifications import public_key
    key = public_key()
    return {"enabled": bool(key), "public_key": key}


@app.post("/api/v1/push/subscribe")
def push_subscribe(subscription: dict):
    from app.push_notifications import save_subscription
    try:
        save_subscription(subscription)
        return {"status": "subscribed"}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.delete("/api/v1/push/subscribe")
def push_unsubscribe(payload: dict):
    from app.push_notifications import remove_subscription
    endpoint = payload.get("endpoint")
    if not isinstance(endpoint, str):
        raise HTTPException(status_code=400, detail="Subscription endpoint is required.")
    remove_subscription(endpoint)
    return {"status": "unsubscribed"}


@app.get("/api/v1/notifications")
def notification_history(limit: int = Query(50, ge=1, le=100)):
    from app.push_notifications import list_notifications
    if not database_configured():
        raise HTTPException(status_code=503, detail="Notification history requires DATABASE_URL.")
    try:
        items = list_notifications(limit)
        return {"status": "ok", "count": len(items), "items": items}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Notification history is unavailable.") from exc



@app.get("/api/v1/demo/account")
def demo_account():
    from app.demo_trading import get_demo_account
    try:
        return get_demo_account()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Demo account unavailable: {exc}") from exc


@app.post("/api/v1/demo/reset")
def demo_reset(x_demo_reset_token: str | None = Header(default=None, alias="X-Demo-Reset-Token")):
    # The demo account is shared at database level. Never expose a public reset.
    configured_token = os.getenv("DEMO_RESET_TOKEN", "")
    if len(configured_token) < 24:
        raise HTTPException(status_code=503, detail="Demo reset is locked. Configure a strong DEMO_RESET_TOKEN in the backend environment.")
    if not x_demo_reset_token or not hmac.compare_digest(x_demo_reset_token, configured_token):
        raise HTTPException(status_code=403, detail="Demo reset authorization failed.")
    from app.demo_trading import reset_demo_account
    try:
        return reset_demo_account()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Demo account reset failed: {exc}") from exc


@app.get("/api/v1/risk/profile")
def risk_profile():
    """GoldSight demo account and verified Exness XAUUSD sizing defaults."""
    return {
        "account_currency": "NGN",
        "account_balance": 100000,
        "leverage": 200,
        "default_risk_pct": 1,
        "maximum_risk_pct": 5,
        "max_open_demo_trades": 2,
        "symbols": {
            "XAUUSD": {
                "contract_size": 100, "minimum_volume": 0.01, "volume_step": 0.01, "maximum_volume": 1000,
                "digits": 2, "profit_currency": "USD", "margin_currency": "XAU",
                "margin_per_lot_usd_reference": 398.52,
                "margin_reference_side_values": {"buy": 398.52, "sell": 398.48},
                "margin_reference_is_indicative": True, "calculation_mode": "Forex"
            },
            "BTCUSD": {
                "contract_size": 1, "minimum_volume": 0.01, "volume_step": 0.01, "maximum_volume": 1000,
                "digits": 2, "profit_currency": "USD", "margin_currency": "BTC",
                "margin_per_lot_usd_reference": 234.54,
                "margin_reference_side_values": {"buy": 234.54, "sell": 234.36},
                "margin_reference_is_indicative": True, "calculation_mode": "Forex no leverage",
                "demo_execution_note": "Requires Exness BTCUSD quote feed; Binance BTCUSDT is analysis-only."
            }
        },
        "fx_conversion": "A current broker USD-to-NGN conversion rate is required; no rate is assumed."
    }


@app.post("/api/v1/risk/position-size")
def risk_position_size(payload: dict):
    """Calculate broker-configurable CFD volume; does not submit an order."""
    try:
        result = calculate_position_size(
            symbol=str(payload.get("symbol", "")),
            side=str(payload.get("side", "")),
            balance=float(payload.get("balance")),
            risk_pct=float(payload.get("risk_pct", 1)),
            entry=float(payload.get("entry")),
            stop_loss=float(payload.get("stop_loss")),
            leverage=float(payload.get("leverage", 200)),
            contract_size=float(payload.get("contract_size")),
            quote_to_account_rate=float(payload.get("quote_to_account_rate")),
            volume_step=float(payload.get("volume_step", 0.01)),
            min_volume=float(payload.get("min_volume", 0.01)),
            max_volume=float(payload.get("max_volume", 1000)),
            margin_per_lot_quote=float(payload["margin_per_lot_quote"]) if payload.get("margin_per_lot_quote") is not None else None,
        )
        return result
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc



@app.get("/api/v1/currencies/{base_currency}")
def currency_rates(base_currency: str):
    """Latest reference FX rates for all currencies supported by the provider."""
    try:
        return get_currency_rates(base_currency)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

@app.get("/api/v1/setups/recorder-status")
def setup_recorder_status():
    return recorder_status()


@app.get("/api/v1/setups/history")
def setup_history(limit: int = Query(50, ge=1, le=200)):
    if not database_configured():
        raise HTTPException(status_code=503, detail="Persistent setup history is not configured. Set DATABASE_URL to a persistent PostgreSQL database.")
    try:
        items = list_setups(limit)
        return {"status": "ok", "count": len(items), "items": items}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Setup history database is unavailable.") from exc


@app.get("/api/v1/fundamentals/news")
def fundamental_news(limit: int = Query(30, ge=1, le=100), refresh: bool = False):
    """Curated RSS headlines with source links; not a full economic calendar."""
    return get_fundamental_news(limit=limit, force_refresh=refresh)


@app.get("/")
def root():
    return {"name": "GoldSight AI API", "docs": "/docs", "status": "ready"}

@app.get("/api/v1/health")
def health():
    return {"status": "ok", "service": "goldsight-api", "timestamp": datetime.now(timezone.utc).isoformat(), "provider_mode": os.getenv("MARKET_DATA_PROVIDER", "exness"), "providers": {"XAUUSD": "configured signal provider; live status requires fresh candles", "XAUUSD_spot_reference": "XAUS indicative spot endpoint; separate from signal candles", "BTCUSD": "configured provider; live status requires a fresh quote"}}

@app.get("/api/v1/spot/XAUUSD")
def gold_spot_reference():
    """Indicative spot reference only; intentionally not a signal/candle endpoint."""
    from app.spot_data import fetch_xaus_spot
    try:
        return fetch_xaus_spot()
    except MarketUnavailable as exc:
        return JSONResponse(
            status_code=503,
            content={
                "symbol": "XAUUSD",
                "provider": "XAUS indicative gold spot API",
                "status": "OFFLINE",
                "price": None,
                "bid": None,
                "ask": None,
                "spread": None,
                "tradable_quote": False,
                "candles_available": False,
                "detail": str(exc),
            },
        )

def fetch_timeframe_market(symbol: str, timeframe: str, limit: int = 240):
    """Fetch provider bars or aggregate aligned 45m candles from 15m bars."""
    if timeframe != "45m":
        return fetch_market(symbol, timeframe, limit=limit)
    base = fetch_market(symbol, "15m", limit=min(1000, limit * 3 + 3))
    candles = aggregate_15m_to_45m(base.get("candles", []), limit=limit)
    if len(candles) < 45:
        raise MarketUnavailable(
            f"Only {len(candles)} complete 45m candles could be built from 15m data; at least 45 are required."
        )
    base["candles"] = candles
    base["timeframe"] = "45m"
    base["provider_timeframe"] = "15m candles aggregated into aligned 45m candles"
    return base


@app.get("/api/v1/backtest/{symbol}")
def backtest(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|45m|1h|4h)$"),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
):
    """Run a walk-forward backtest on up to 1000 provider candles; not multi-year history."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise HTTPException(status_code=404, detail="Only XAUUSD and BTCUSD are supported.")
    try:
        data = fetch_timeframe_market(symbol, timeframe, limit=candles_limit)
        higher_map = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        if higher_tf:
            higher_data = fetch_market(symbol, higher_tf, limit=candles_limit)
            higher_candles = higher_data.get("candles", [])
        return run_backtest(
            data.get("candles", []), symbol, timeframe, data.get("spread"),
            higher_candles=higher_candles, target_r=target_r, max_hold_bars=max_hold_bars,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Backtest data unavailable: {exc}") from exc


@app.get("/api/v1/compare/{symbol}")
def compare_timeframes(
    symbol: str,
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
    comparison_mode: str = Query("available_history", pattern="^(available_history|common_window)$"),
    history_months: int = 0,
):
    """Compare timeframes; optionally fetch up to 12 months of paginated Exness history."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise HTTPException(status_code=404, detail="Only XAUUSD and BTCUSD are supported.")

    higher_map = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}
    timeframes = ["5m", "15m", "45m", "1h", "4h"]
    prepared = []
    history_end = int(datetime.now(timezone.utc).timestamp())
    history_start = int((datetime.now(timezone.utc) - timedelta(days=round(30.4375 * history_months))).timestamp()) if history_months else None
    historical_provider = os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower()
    historical_spread = None
    spread_cost_note = "Historical spread adjustment unavailable: Exness current quote could not be assumed for the entire six-month period. Net R equals gross R until spread is supplied; do not treat this as cost-adjusted performance."
    if history_months:
        if historical_provider != "exness":
            raise HTTPException(status_code=400, detail="Multi-month historical comparison currently requires MARKET_DATA_PROVIDER=exness.")
        # Do not block historical data retrieval on a live quote. Exness may rate-limit
        # the tick/candle endpoints separately; if a quote is unavailable, continue with
        # explicit zero spread-cost adjustment and disclose that limitation.
        try:
            live_quote = fetch_market(symbol, "5m", limit=45)
            historical_spread = live_quote.get("spread")
            if historical_spread is not None:
                spread_cost_note = "Current observed spread is applied as a rough proxy to historical trades; actual historical spreads, slippage and commission are not modeled."
        except MarketUnavailable:
            historical_spread = None

    def load_historical(tf: str):
        source_tf = "15m" if tf == "45m" else tf
        candles = exness_historical_candles(symbol, source_tf, history_start, history_end)
        if tf == "45m":
            candles = aggregate_15m_to_45m(candles, limit=100000)
        return candles

    for timeframe in timeframes:
        try:
            if history_months:
                candles = load_historical(timeframe)
                data = {"candles": candles, "spread": historical_spread, "provider": "Exness paginated historical candles"}
            else:
                data = fetch_timeframe_market(symbol, timeframe, limit=candles_limit)
                candles = data.get("candles", [])
            higher_tf = higher_map.get(timeframe)
            higher_candles = None
            if higher_tf:
                if history_months:
                    higher_candles = load_historical(higher_tf)
                else:
                    higher_data = fetch_market(symbol, higher_tf, limit=candles_limit)
                    higher_candles = higher_data.get("candles", [])
            times = [int(c["time"]) for c in candles if "time" in c]
            prepared.append({
                "timeframe": timeframe, "data": data, "candles": candles,
                "higher_candles": higher_candles, "error": None,
                "start": min(times) if times else None, "end": max(times) if times else None,
            })
        except MarketUnavailable as exc:
            prepared.append({
                "timeframe": timeframe, "data": {}, "candles": [],
                "higher_candles": None, "error": f"Data unavailable: {exc}",
                "start": None, "end": None,
            })

    common_start = common_end = None
    if comparison_mode == "common_window":
        available = [x for x in prepared if x["start"] is not None and x["end"] is not None]
        if len(available) >= 2:
            common_start = max(x["start"] for x in available)
            common_end = min(x["end"] for x in available)
            if common_start > common_end:
                common_start = common_end = None

    results = []
    for item in prepared:
        timeframe = item["timeframe"]
        if item["error"]:
            results.append({
                "symbol": symbol, "timeframe": timeframe, "trades": 0,
                "win_rate_pct": None, "net_r_total": None, "average_net_r": None,
                "profit_factor": None, "max_drawdown_r": None, "error": item["error"],
            })
            continue
        candles = item["candles"]
        higher_candles = item["higher_candles"]
        if comparison_mode == "common_window":
            if common_start is None or common_end is None:
                # Never silently fall back to incomparable full-history samples.
                candles = []
                higher_candles = []
            else:
                candles = [c for c in candles if common_start <= int(c.get("time", 0)) <= common_end]
                # Keep earlier higher-timeframe candles for indicator warm-up, but never
                # allow higher-timeframe bars after the shared comparison end.
                if higher_candles is not None:
                    higher_candles = [c for c in higher_candles if int(c.get("time", 0)) <= common_end]
        result = run_backtest(
            candles, symbol, timeframe, item["data"].get("spread"),
            higher_candles=higher_candles, target_r=target_r, max_hold_bars=max_hold_bars,
        )
        results.append(result)

    # Do not crown a winner from a tiny sample or a non-positive result.
    eligible = [
        item for item in results
        if item.get("trades", 0) >= 20
        and isinstance(item.get("net_r_total"), (int, float))
        and isinstance(item.get("profit_factor"), (int, float))
        and item["net_r_total"] > 0
        and item["profit_factor"] > 1
    ]
    eligible.sort(
        key=lambda item: (
            item.get("average_net_r") if isinstance(item.get("average_net_r"), (int, float)) else float("-inf"),
            item.get("profit_factor") if isinstance(item.get("profit_factor"), (int, float)) else float("-inf"),
            item.get("win_rate_pct") if isinstance(item.get("win_rate_pct"), (int, float)) else float("-inf"),
        ),
        reverse=True,
    )
    common_window = None
    if comparison_mode == "common_window":
        common_window = {
            "start": datetime.fromtimestamp(common_start, timezone.utc).isoformat() if common_start is not None else None,
            "end": datetime.fromtimestamp(common_end, timezone.utc).isoformat() if common_end is not None else None,
            "span_days": round((common_end - common_start) / 86400, 2) if common_start is not None and common_end is not None else 0,
            "note": "All primary timeframe candles are restricted to this overlap. Higher-timeframe candles before the start are retained only for indicator warm-up; bars after the end are excluded. Short overlaps may leave slower timeframes with too few bars to test.",
        }
    return {
        "symbol": symbol,
        "comparison_mode": comparison_mode,
        "requested_history_months": history_months,
        "spread_cost_note": spread_cost_note if history_months else "Available-history mode uses provider-reported current spread as a rough historical proxy; slippage and commission are not modeled.",
        "common_window": common_window,
        "method": "Shared-date comparisons restrict all primary timeframe candles to the common overlap; available-history mode uses each provider's full available sample. Results remain provisional.",
        "ranking_rule": "A provisional candidate must have at least 20 trades, positive net R, and profit factor above 1. Candidates are ordered by average net R, then profit factor, then win rate.",
        "provisional_best_timeframe": eligible[0]["timeframe"] if eligible else None,
        "winner_status": "PROVISIONAL_ONLY" if eligible else "NO_VALIDATED_WINNER",
        "warning": "The highest win rate alone is not enough. Provider history may be short, costs omit slippage and commission, and shared-window tests may be too short for higher timeframes. Validate finalists on longer historical data before using real money.",
        "results": results,
    }


@app.get("/api/v1/market/{symbol}")
def market(symbol: str, timeframe: str = Query("15m", pattern="^(5m|15m|1h|4h)$")):
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise HTTPException(status_code=404, detail="Only XAUUSD and BTCUSD are supported.")
    try:
        data = fetch_timeframe_market(symbol, timeframe)
        data["timeframe"] = timeframe

        # Require an aligned higher-timeframe trend for 5m, 15m, and 1h signals.
        higher_map = {"5m": "15m", "15m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        higher_error = None
        if higher_tf:
            try:
                higher_data = fetch_market(symbol, higher_tf)
                higher_candles = higher_data.get("candles", [])
                data["higher_timeframe"] = higher_tf
                data["higher_timeframe_status"] = higher_data.get("status", "UNKNOWN")
            except MarketUnavailable as exc:
                higher_error = str(exc)
                data["higher_timeframe"] = higher_tf
                data["higher_timeframe_status"] = "UNAVAILABLE"

        # Normalize provider ordering before charting or signal calculations.
        data["candles"] = normalize_candles(data.get("candles", []))
        if higher_candles is not None:
            higher_candles = normalize_candles(higher_candles)

        # Only bars whose full timeframe has elapsed can contribute to a live signal.
        signal_candles = completed_candles(data["candles"], timeframe)
        signal_higher_candles = (
            completed_candles(higher_candles, higher_tf)
            if higher_tf and higher_candles is not None else higher_candles
        )
        signal = analyze(
            signal_candles, symbol, timeframe, data.get("spread"),
            signal_higher_candles, include_last_completed=True,
        )
        if higher_error and timeframe != "4h":
            signal = no_setup(f"Higher-timeframe data unavailable ({higher_tf}); refusing to issue a trade signal.")
            signal["higher_timeframe_trend"] = "UNKNOWN"

        # A signal must be based on a recently completed candle, not just a fresh quote.
        candles = data.get("candles", [])
        seconds = {"5m": 300, "15m": 900, "45m": 2700, "1h": 3600, "4h": 14400}[timeframe]
        if signal_candles:
            completed = signal_candles[-1]
            candle_time = int(completed.get("time", 0))
            age = int(datetime.now(timezone.utc).timestamp() - (candle_time + seconds))
            signal["last_completed_candle_time"] = datetime.fromtimestamp(candle_time, timezone.utc).isoformat()
            signal["signal_age_seconds"] = max(0, age)
            signal["signal_fresh"] = -30 <= age <= seconds * 2
            if age > seconds * 2:
                signal = no_setup("Latest completed candle is stale; waiting for fresh candle data.")
                signal["last_completed_candle_time"] = datetime.fromtimestamp(candle_time, timezone.utc).isoformat()
                signal["signal_age_seconds"] = age
                signal["signal_fresh"] = False
                if higher_tf:
                    signal["higher_timeframe"] = higher_tf
                    signal["higher_timeframe_trend"] = "UNKNOWN" if higher_error else "CHECKED"
        else:
            signal = no_setup("Not enough candles to verify signal freshness.")
            signal["signal_fresh"] = False
            signal["signal_age_seconds"] = None
            signal["last_completed_candle_time"] = None
        if signal.get("status") in {"BUY", "SELL"}:
            # Enforce the same all-higher-timeframe alignment in the API itself.
            # The background recorder calls this exact endpoint, so alerts and Forecast
            # cannot disagree because of a frontend-only filter.
            rank = {"5m": 0, "15m": 1, "1h": 2, "4h": 3}
            expected = "BULLISH" if signal["status"] == "BUY" else "BEARISH"
            alignment = []
            alignment_error = None
            for upper_tf in ("5m", "15m", "1h", "4h"):
                if rank[upper_tf] <= rank[timeframe]:
                    continue
                try:
                    upper_data = fetch_market(symbol, upper_tf)
                    upper_trend = calculate_trend(upper_data.get("candles", []), upper_tf)
                except MarketUnavailable:
                    upper_trend = "UNKNOWN"
                alignment.append({"timeframe": upper_tf, "trend": upper_trend})
                if upper_trend != expected:
                    alignment_error = f"Setup rejected: {upper_tf} trend is {upper_trend}; {expected} alignment is required across all higher timeframes."
                    break
            signal["higher_timeframe_alignment"] = alignment
            if alignment_error:
                signal = no_setup(alignment_error)
                signal["trend"] = expected
                signal["higher_timeframe_alignment"] = alignment
            else:
                signal.update(classify_trade_context(symbol, signal))
        else:
            signal["trade_type"] = "NO TRADE"
            signal["news_context"] = None
            signal["news_context_status"] = "NO_ACTIVE_SETUP"
        data["signal"] = signal
        return data
    except MarketUnavailable as exc:
        return JSONResponse(status_code=503, content={"symbol": symbol, "timeframe": timeframe, "status": "OFFLINE", "provider": "none", "price": None, "bid": None, "ask": None, "spread": None, "updated_at": None, "candles": [], "signal": {"status": "NO SETUP", "side": "NO SETUP", "entry": None, "stop_loss": None, "take_profits": [], "rr": None, "confidence": None, "reasons": [str(exc)], "invalidation": "No setup is available while live data is offline.", "signal_time": None, "trend": "UNKNOWN"}})
