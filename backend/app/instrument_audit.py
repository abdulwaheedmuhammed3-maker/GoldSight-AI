"""Non-blocking, bounded all-instrument market-data audit."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from threading import Lock, Thread
from uuid import uuid4

from app.market import fetch_market, normalize_candles
from app.market_data_manager import SYMBOLS, get_tracked_quote

LIVE_QUOTE_MAX_AGE_SECONDS = 60
TIMEFRAMES = ("5m", "15m", "30m", "1h", "4h")
TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
FRESHNESS_GRACE = {"5m": 600, "15m": 900, "30m": 1200, "1h": 1500, "4h": 4500}
_LOCK = Lock()
_JOBS: dict[str, dict] = {}
_ACTIVE_JOB: str | None = None


def _quote_snapshot() -> dict:
    output = {}
    for symbol in SYMBOLS:
        quote = get_tracked_quote(symbol)
        age = quote.get("quote_age_seconds")
        status = quote.get("status", "OFFLINE")
        if status == "LIVE" and (age is None or age > LIVE_QUOTE_MAX_AGE_SECONDS):
            status = "STALE"
        output[symbol] = {
            "symbol": symbol,
            "quote": {
                "status": status, "provider": quote.get("provider"),
                "provider_symbol": quote.get("provider_symbol"),
                "price": quote.get("price"), "updated_at": quote.get("updated_at"),
                "age_seconds": age, "error": quote.get("detail"),
            },
            "timeframes": {},
        }
    return output


def _run_audit(job_id: str) -> None:
    global _ACTIVE_JOB
    checked_at = datetime.now(timezone.utc)
    results = _quote_snapshot()
    tasks = {}
    executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="market-audit")
    try:
        for symbol in SYMBOLS:
            for timeframe in TIMEFRAMES:
                future = executor.submit(fetch_market, symbol, timeframe, 120)
                tasks[future] = (symbol, timeframe)
        for future in as_completed(tasks):
            symbol, timeframe = tasks[future]
            try:
                data = future.result()
                candles = normalize_candles(data.get("candles", []))
                latest = candles[-1] if candles else None
                age = max(0.0, checked_at.timestamp() - (int(latest["time"]) + TIMEFRAME_SECONDS[timeframe])) if latest else None
                grace = FRESHNESS_GRACE[timeframe]
                status = "OFFLINE" if latest is None else ("LIVE" if age is not None and age <= grace else "STALE")
                results[symbol]["timeframes"][timeframe] = {
                    "status": status, "provider": data.get("provider"),
                    "provider_symbol": data.get("provider_symbol"),
                    "candle_count": len(candles),
                    "latest_candle_at": datetime.fromtimestamp(int(latest["time"]), timezone.utc).isoformat() if latest else None,
                    "age_seconds": round(age, 1) if age is not None else None,
                    "freshness_grace_seconds": grace, "error": None,
                }
            except Exception as exc:
                results[symbol]["timeframes"][timeframe] = {
                    "status": "OFFLINE", "provider": None, "provider_symbol": None,
                    "candle_count": 0, "latest_candle_at": None, "age_seconds": None,
                    "freshness_grace_seconds": FRESHNESS_GRACE[timeframe], "error": str(exc)[:300],
                }
            with _LOCK:
                _JOBS[job_id]["completed_checks"] += 1
                _JOBS[job_id]["results"] = results
        for symbol, item in results.items():
            states = [item["timeframes"].get(tf, {}).get("status", "PENDING") for tf in TIMEFRAMES]
            item["candle_summary"] = {state: states.count(state) for state in ("LIVE", "STALE", "OFFLINE", "PENDING")}
            item["overall_status"] = (
                "LIVE" if item["quote"]["status"] == "LIVE" and all(s == "LIVE" for s in states)
                else "PARTIAL" if item["quote"]["status"] == "LIVE" or any(s == "LIVE" for s in states)
                else "OFFLINE"
            )
        summary = {
            "instruments": len(results),
            "live_quotes": sum(v["quote"]["status"] == "LIVE" for v in results.values()),
            "stale_quotes": sum(v["quote"]["status"] == "STALE" for v in results.values()),
            "offline_quotes": sum(v["quote"]["status"] == "OFFLINE" for v in results.values()),
            "fully_live_instruments": sum(v["overall_status"] == "LIVE" for v in results.values()),
        }
        with _LOCK:
            _JOBS[job_id].update(status="complete", checked_at=checked_at.isoformat(),
                                 summary=summary, instruments=list(results.values()))
    except Exception as exc:
        with _LOCK:
            _JOBS[job_id].update(status="failed", error=str(exc)[:300])
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
        with _LOCK:
            if _ACTIVE_JOB == job_id:
                _ACTIVE_JOB = None


def start_or_get_audit() -> dict:
    global _ACTIVE_JOB
    with _LOCK:
        if _ACTIVE_JOB and _ACTIVE_JOB in _JOBS and _JOBS[_ACTIVE_JOB]["status"] == "running":
            return dict(_JOBS[_ACTIVE_JOB])
        job_id = uuid4().hex
        _ACTIVE_JOB = job_id
        _JOBS[job_id] = {"audit_id": job_id, "status": "running", "completed_checks": 0,
                         "total_checks": len(SYMBOLS) * len(TIMEFRAMES),
                         "instruments": _quote_snapshot(), "timeframes": list(TIMEFRAMES)}
    Thread(target=_run_audit, args=(job_id,), daemon=True, name="instrument-audit").start()
    with _LOCK:
        return dict(_JOBS[job_id])


def get_audit(job_id: str) -> dict | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else None
