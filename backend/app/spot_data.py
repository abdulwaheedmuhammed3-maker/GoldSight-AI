"""Free indicative XAU/USD spot reference adapter.

This is intentionally separate from the signal-grade candle provider. XAUS
quotes are indicative mid-market spot references, not broker bid/ask quotes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite
from typing import Any
import json
import urllib.error
import urllib.request

from app.market import MarketUnavailable

XAUS_SPOT_URL = "https://xaus.com/api/v1/spot?compact=1"
MAX_SPOT_AGE_SECONDS = 180


def fetch_xaus_spot() -> dict[str, Any]:
    request = urllib.request.Request(
        XAUS_SPOT_URL,
        headers={"Accept": "application/json", "User-Agent": "GoldSightAI/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise MarketUnavailable(f"XAUS spot request failed: {exc}") from exc

    if not isinstance(payload, dict):
        raise MarketUnavailable("XAUS returned an invalid response payload.")

    price = payload.get("spot_usd_oz")
    price_as_of = payload.get("price_as_of") or payload.get("updated_at")
    state = payload.get("data_state") or {}
    if not isinstance(state, dict):
        raise MarketUnavailable("XAUS returned invalid data-state metadata.")
    if (
        isinstance(price, bool)
        or not isinstance(price, (int, float))
        or not isfinite(float(price))
        or float(price) <= 0
    ):
        raise MarketUnavailable("XAUS did not return a valid XAU/USD spot price.")
    if not isinstance(price_as_of, str):
        raise MarketUnavailable("XAUS did not return a source timestamp.")

    try:
        parsed = datetime.fromisoformat(price_as_of.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise MarketUnavailable("XAUS source timestamp has no timezone.")
        age_seconds = (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds()
    except ValueError as exc:
        raise MarketUnavailable("XAUS returned an invalid source timestamp.") from exc

    if age_seconds < -5 or age_seconds > MAX_SPOT_AGE_SECONDS or state.get("status") == "unavailable":
        raise MarketUnavailable(f"XAUS spot quote is stale or unavailable (age {int(age_seconds)} seconds).")

    return {
        "symbol": "XAUUSD",
        "provider": "XAUS indicative gold spot API",
        "provider_symbol": "XAU/USD spot",
        "status": "LIVE",
        "price": float(price),
        "bid": None,
        "ask": None,
        "spread": None,
        "digits": 2,
        "updated_at": parsed.astimezone(timezone.utc).isoformat(),
        "age_seconds": max(0, int(age_seconds)),
        "data_state": state.get("status", "unknown"),
        "tradable_quote": False,
        "candles_available": False,
        "note": "Indicative spot mid-price only; not a broker CFD quote. No signal-grade intraday OHLC candles or bid/ask spread are supplied by this endpoint.",
    }
