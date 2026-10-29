from datetime import datetime, timezone
import os
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.market import MarketUnavailable, analyze, fetch_market

app = FastAPI(title="GoldSight AI API", version="0.2.0", description="Live market data and explainable rule-based signals. No order execution.")
origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in origins if x.strip()], allow_credentials=False, allow_methods=["GET", "OPTIONS"], allow_headers=["*"])

@app.get("/")
def root():
    return {"name": "GoldSight AI API", "docs": "/docs", "status": "ready"}

@app.get("/api/v1/health")
def health():
    return {"status": "ok", "service": "goldsight-api", "timestamp": datetime.now(timezone.utc).isoformat(), "provider_mode": os.getenv("MARKET_DATA_PROVIDER", "exness"), "providers": {"XAUUSD": "configured provider; live status requires a fresh quote", "BTCUSD": "configured provider; live status requires a fresh quote"}}

@app.get("/api/v1/market/{symbol}")
def market(symbol: str, timeframe: str = Query("15m", pattern="^(5m|15m|1h|4h)$")):
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise HTTPException(status_code=404, detail="Only XAUUSD and BTCUSD are supported.")
    try:
        data = fetch_market(symbol, timeframe)
        data["timeframe"] = timeframe
        data["signal"] = analyze(data["candles"], symbol, timeframe, data.get("spread"))
        return data
    except MarketUnavailable as exc:
        return JSONResponse(status_code=503, content={"symbol": symbol, "timeframe": timeframe, "status": "OFFLINE", "provider": "none", "price": None, "bid": None, "ask": None, "spread": None, "updated_at": None, "candles": [], "signal": {"status": "NO SETUP", "side": "NO SETUP", "entry": None, "stop_loss": None, "take_profits": [], "rr": None, "confidence": None, "reasons": [str(exc)], "invalidation": "No setup is available while live data is offline.", "signal_time": None, "trend": "UNKNOWN"}})
