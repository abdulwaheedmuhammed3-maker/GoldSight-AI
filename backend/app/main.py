from datetime import datetime, timezone
import os
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.market import MarketUnavailable, analyze, fetch_market, no_setup
from app.backtest import run_backtest

app = FastAPI(title="GoldSight AI API", version="0.2.0", description="Live market data and explainable rule-based signals. No order execution.")
origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in origins if x.strip()], allow_credentials=False, allow_methods=["GET", "OPTIONS"], allow_headers=["*"])

@app.get("/")
def root():
    return {"name": "GoldSight AI API", "docs": "/docs", "status": "ready"}

@app.get("/api/v1/health")
def health():
    return {"status": "ok", "service": "goldsight-api", "timestamp": datetime.now(timezone.utc).isoformat(), "provider_mode": os.getenv("MARKET_DATA_PROVIDER", "exness"), "providers": {"XAUUSD": "configured provider; live status requires a fresh quote", "BTCUSD": "configured provider; live status requires a fresh quote"}}

@app.get("/api/v1/backtest/{symbol}")
def backtest(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|1h|4h)$"),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
):
    """Run a walk-forward backtest on the provider's available recent candle sample."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise HTTPException(status_code=404, detail="Only XAUUSD and BTCUSD are supported.")
    try:
        data = fetch_market(symbol, timeframe)
        higher_map = {"5m": "15m", "15m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        if higher_tf:
            higher_data = fetch_market(symbol, higher_tf)
            higher_candles = higher_data.get("candles", [])
        return run_backtest(
            data.get("candles", []), symbol, timeframe, data.get("spread"),
            higher_candles=higher_candles, target_r=target_r, max_hold_bars=max_hold_bars,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Backtest data unavailable: {exc}") from exc


@app.get("/api/v1/market/{symbol}")
def market(symbol: str, timeframe: str = Query("15m", pattern="^(5m|15m|1h|4h)$")):
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise HTTPException(status_code=404, detail="Only XAUUSD and BTCUSD are supported.")
    try:
        data = fetch_market(symbol, timeframe)
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

        signal = analyze(data["candles"], symbol, timeframe, data.get("spread"), higher_candles)
        if higher_error and timeframe != "4h":
            signal = no_setup(f"Higher-timeframe data unavailable ({higher_tf}); refusing to issue a trade signal.")
            signal["higher_timeframe_trend"] = "UNKNOWN"

        # A signal must be based on a recently completed candle, not just a fresh quote.
        candles = data.get("candles", [])
        seconds = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}[timeframe]
        if len(candles) >= 2:
            completed = candles[-2]
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
        data["signal"] = signal
        return data
    except MarketUnavailable as exc:
        return JSONResponse(status_code=503, content={"symbol": symbol, "timeframe": timeframe, "status": "OFFLINE", "provider": "none", "price": None, "bid": None, "ask": None, "spread": None, "updated_at": None, "candles": [], "signal": {"status": "NO SETUP", "side": "NO SETUP", "entry": None, "stop_loss": None, "take_profits": [], "rr": None, "confidence": None, "reasons": [str(exc)], "invalidation": "No setup is available while live data is offline.", "signal_time": None, "trend": "UNKNOWN"}})
