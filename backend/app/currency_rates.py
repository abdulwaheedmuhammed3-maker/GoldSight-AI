"""Cached public reference FX rates for the GoldSight currency converter."""
from __future__ import annotations
import re, time
from datetime import datetime, timezone
from typing import Any
import httpx
_PROVIDER_URL = "https://open.er-api.com/v6/latest/{base}"
_CACHE_TTL_SECONDS = 900
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_CODE_RE = re.compile(r"^[A-Z]{3}$")
def get_currency_rates(base_currency: str) -> dict[str, Any]:
    base = base_currency.strip().upper()
    if not _CODE_RE.fullmatch(base):
        raise ValueError("Currency must be a three-letter ISO currency code, such as USD, EUR or NGN.")
    now = time.monotonic()
    cached = _cache.get(base)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return {**cached[1], "cache_status": "CACHED"}
    try:
        response = httpx.get(_PROVIDER_URL.format(base=base), timeout=10.0, headers={"User-Agent": "GoldSight-AI/1.0"})
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        if cached:
            return {**cached[1], "status": "STALE", "cache_status": "STALE", "warning": "FX provider unavailable; showing the last successful reference rates."}
        raise RuntimeError("Currency rates are temporarily unavailable. Please retry shortly.") from exc
    rates = payload.get("rates")
    if payload.get("result") != "success" or not isinstance(rates, dict) or base not in rates:
        raise RuntimeError("The FX provider returned an invalid or unsupported currency response.")
    clean_rates = {str(code).upper(): float(rate) for code, rate in rates.items() if _CODE_RE.fullmatch(str(code).upper()) and isinstance(rate, (int, float)) and float(rate) > 0}
    if not clean_rates:
        raise RuntimeError("No usable exchange rates were returned by the FX provider.")
    result = {"status": "LIVE", "base": base, "rates": clean_rates, "currency_count": len(clean_rates), "provider": "open.er-api.com (latest reference rates)", "provider_updated_at": payload.get("time_last_update_utc"), "next_update_at": payload.get("time_next_update_utc"), "fetched_at": datetime.now(timezone.utc).isoformat(), "refresh_interval_seconds": _CACHE_TTL_SECONDS, "cache_status": "FRESH", "disclaimer": "Reference exchange rates for conversion and display only; not broker execution, remittance or card rates."}
    _cache[base] = (now, result)
    return result
