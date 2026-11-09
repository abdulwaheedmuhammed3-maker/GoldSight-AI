"""Gold-API.com spot quote adapter for XAU/USD.

This adapter supplies an indicative spot midpoint only. It is not a broker
bid/ask quote and it does not provide the OHLC candles used by GoldSight's
structure/signal engine. Cache for 30 seconds per provider guidance.
"""
from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from typing import Any
import json
import math
import time
import urllib.error
import urllib.request

from .market import MarketUnavailable

_ENDPOINT = "https://api.gold-api.com/price/XAU"
_CACHE_TTL_SECONDS = 30
_CACHE_LOCK = Lock()
_CACHE: dict[str, Any] | None = None
_CACHE_AT = 0.0


def gold_api_quote() -> dict[str, Any]:
    """Return a validated, cached XAU/USD spot quote; never fabricate a quote."""
    global _CACHE, _CACHE_AT
    now = time.monotonic()
    with _CACHE_LOCK:
        if _CACHE is not None and now - _CACHE_AT < _CACHE_TTL_SECONDS:
            return dict(_CACHE)

        request = urllib.request.Request(
            _ENDPOINT,
            headers={"Accept": "application/json", "User-Agent": "GoldSightAI/1.0"},
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise MarketUnavailable(f"Gold-API.com XAU spot request failed: {exc}") from exc

        if not isinstance(payload, dict):
            raise MarketUnavailable("Gold-API.com returned an invalid XAU payload.")

        raw_price = payload.get("price")
        if isinstance(raw_price, bool) or raw_price is None:
            raise MarketUnavailable("Gold-API.com returned no valid XAU price.")
        try:
            price = float(raw_price)
        except (TypeError, ValueError, OverflowError) as exc:
            raise MarketUnavailable("Gold-API.com returned an invalid XAU price.") from exc
        if not math.isfinite(price) or price <= 0:
            raise MarketUnavailable("Gold-API.com returned a non-finite or nonpositive XAU price.")

        raw_updated = payload.get("updatedAt") or payload.get("updated_at")
        if not isinstance(raw_updated, str) or not raw_updated.strip():
            raise MarketUnavailable("Gold-API.com returned no quote timestamp.")
        try:
            stamp = datetime.fromisoformat(raw_updated.replace("Z", "+00:00"))
            if stamp.tzinfo is None or stamp.utcoffset() is None:
                raise ValueError("timezone missing")
            stamp = stamp.astimezone(timezone.utc)
        except (ValueError, TypeError, OverflowError) as exc:
            raise MarketUnavailable("Gold-API.com returned an invalid quote timestamp.") from exc

        age = (datetime.now(timezone.utc) - stamp).total_seconds()
        if not math.isfinite(age) or age < -30 or age > 120:
            raise MarketUnavailable(f"Gold-API.com XAU spot quote is stale ({max(0, int(age))}s old).")

        quote = {
            "symbol": "XAUUSD",
            "provider_symbol": "XAU/USD",
            "provider": "Gold-API.com · indicative spot",
            "status": "LIVE",
            "price": price,
            "bid": None,
            "ask": None,
            "spread": None,
            "digits": 2,
            "updated_at": stamp.isoformat(),
            "quote_type": "indicative_spot",
        }
        _CACHE = quote
        _CACHE_AT = time.monotonic()
        return dict(quote)
