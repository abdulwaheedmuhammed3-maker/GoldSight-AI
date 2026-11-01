"""Read-only NGX stock intelligence using Kobo Terminal delayed market data."""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

BASE = "https://koboterminal.com"
# Kobo refreshes NGX equities/market data about every 20 minutes. Cache longer
# than the provider cadence to stay within the Personal tier's 100 requests/day.
CACHE_TTL_SECONDS = 1200
WATCHLIST = {
    "GTCO": "Guaranty Trust Holding Company Plc",
    "ZENITHBANK": "Zenith Bank Plc",
    "UBA": "United Bank for Africa Plc",
    "FIDELITYBK": "Fidelity Bank Plc",
    "DANGCEM": "Dangote Cement Plc",
    "BUACEMENT": "BUA Cement Plc",
    "MTNN": "MTN Nigeria Communications Plc",
    "AIRTELAFRI": "Airtel Africa Plc",
    "PRESCO": "Presco Plc",
    "SEPLAT": "Seplat Energy Plc",
}
CACHE: dict[str, Any] = {"at": 0.0, "data": None}


def _get(path: str) -> Any:
    headers = {"Accept": "application/json", "User-Agent": "TradeSight/1.0"}
    key = os.getenv("NGX_KOBO_API_KEY", "").strip()
    if key:
        headers["X-API-Key"] = key
    request = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read(2_000_000).decode("utf-8"))


def _unwrap_rows(payload: Any) -> list[dict]:
    """Accept Kobo's documented array and common success/data envelopes."""
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    candidates = [
        payload.get("data"),
        payload.get("stocks"),
        payload.get("equities"),
        payload.get("results"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)]
        if isinstance(candidate, dict):
            for key in ("stocks", "equities", "items", "results", "data"):
                nested = candidate.get(key)
                if isinstance(nested, list):
                    return [row for row in nested if isinstance(row, dict)]
    return []


def _unwrap_market(payload: Any) -> dict:
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    # Market responses may be a direct object or {success: true, data: {...}}.
    if isinstance(data, dict):
        return data
    return payload


def _symbol(value: Any) -> str:
    text = str(value or "").strip().upper()
    for suffix in (".NG", ".NGX", ":NGX"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    return text.replace(" ", "").replace("-", "")


def _num(value):
    try:
        n = float(value)
        return n if n == n and abs(n) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _score(stock: dict) -> dict:
    # Personal tier includes prices/market overview, not fundamentals. Never
    # infer a BUY from a delayed snapshot or manufacture financial ratios.
    return {
        "score": None,
        "status": "WAIT — FUNDAMENTALS NOT INCLUDED",
        "suggested_horizon": "Not assigned",
        "checks": [],
        "missing": ["Verified fundamentals", "Multi-session price history"],
        "entry": None,
        "stop_loss": None,
        "take_profit": None,
        "reason": "Delayed snapshot data alone cannot justify a BUY. Require verified financial statements, multi-session history, liquidity and a defensible entry/exit plan.",
        "data_quality": "INSUFFICIENT",
    }


def get_ngx_intelligence(force: bool = False) -> dict:
    now = time.time()
    if not force and CACHE["data"] is not None and now - CACHE["at"] < CACHE_TTL_SECONDS:
        return CACHE["data"]

    key_configured = bool(os.getenv("NGX_KOBO_API_KEY", "").strip())
    errors: dict[str, str] = {}
    raw_stocks: Any = None
    raw_market: Any = None

    # Fetch independently: a failure in one endpoint must not discard the
    # successful response from the other.
    try:
        raw_stocks = _get("/api/ngxdata/stocks")
    except Exception as exc:
        errors["stocks"] = str(exc)[:180]
    try:
        raw_market = _get("/api/ngxdata/market")
    except Exception as exc:
        errors["market"] = str(exc)[:180]

    by_symbol = {
        _symbol(row.get("symbol") or row.get("ticker")): row
        for row in _unwrap_rows(raw_stocks)
        if row.get("symbol") or row.get("ticker")
    }
    rows = []
    for symbol, fallback_name in WATCHLIST.items():
        quote = by_symbol.get(symbol)
        if not quote:
            continue
        rows.append({
            "symbol": symbol,
            "name": quote.get("name") or fallback_name,
            "sector": quote.get("sector"),
            "price": _num(quote.get("current_price", quote.get("price", quote.get("close")))),
            "change_percent": _num(quote.get("change_percent", quote.get("changePercentage"))),
            "volume": _num(quote.get("volume")),
            "market_cap": _num(quote.get("market_cap", quote.get("marketCap"))),
            "pe_ratio": _num(quote.get("pe_ratio", quote.get("peRatio"))),
            "fundamentals_updated_at": None,
            "analysis": _score(quote),
        })

    market = _unwrap_market(raw_market)
    market_ok = any(_num(market.get(field)) is not None for field in ("asi", "market_cap", "volume"))
    if rows and market_ok:
        status = "LIVE"
    elif rows or market_ok:
        status = "PARTIAL"
    else:
        status = "OFFLINE"

    data = {
        "status": status,
        "provider": "Kobo Terminal NGX data (delayed snapshot)",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "market": market,
        "watchlist": rows,
        "coverage": {"requested": len(WATCHLIST), "returned": len(rows)},
        "endpoint_status": {
            "stocks": "LIVE" if rows else ("ERROR" if "stocks" in errors else "EMPTY"),
            "market": "LIVE" if market_ok else ("ERROR" if "market" in errors else "EMPTY"),
        },
        "errors": errors,
        "data_entitlement": "API key configured" if key_configured else "Public snapshot only; configure NGX_KOBO_API_KEY for authenticated access",
        "note": "Delayed market data · research only · no broker orders.",
    }
    if status == "PARTIAL":
        data["note"] += " One NGX data component is unavailable; available market data is still shown."
    elif status == "OFFLINE":
        data["note"] += " No usable NGX market or stock data was returned. No sample prices or recommendations are shown."

    CACHE.update({"at": now, "data": data})
    return data
