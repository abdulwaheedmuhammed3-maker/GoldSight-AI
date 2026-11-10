"""Non-blocking instrument audit with PostgreSQL-backed resumable progress."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from threading import Lock, Thread
from uuid import uuid4

import psycopg

from app.market import fetch_market, normalize_candles
from app.market_data_manager import SYMBOLS, get_tracked_quote
from app.setup_history import database_configured, _database_url

LIVE_QUOTE_MAX_AGE_SECONDS = 60
TIMEFRAMES = ("5m", "15m", "30m", "1h", "4h")
TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
FRESHNESS_GRACE = {"5m": 600, "15m": 900, "30m": 1200, "1h": 1500, "4h": 4500}
_LOCK = Lock()
_JOBS: dict[str, dict] = {}
_LOCAL_RUNNING: set[str] = set()
_ACTIVE_JOB: str | None = None
_TABLE_READY = False


def _ensure_store() -> bool:
    global _TABLE_READY
    if not database_configured():
        return False
    if _TABLE_READY:
        return True
    with psycopg.connect(_database_url(), connect_timeout=3) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_instrument_audits (
                audit_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                state JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS goldsight_instrument_audits_recent_idx
            ON goldsight_instrument_audits (updated_at DESC)
        """)
        conn.commit()
    _TABLE_READY = True
    return True


def _save_job(job: dict) -> bool:
    try:
        if not _ensure_store():
            return False
        with psycopg.connect(_database_url(), connect_timeout=3) as conn:
            conn.execute("""
                INSERT INTO goldsight_instrument_audits (audit_id, status, state, updated_at)
                VALUES (%s, %s, %s::jsonb, NOW())
                ON CONFLICT (audit_id) DO UPDATE SET
                    status=EXCLUDED.status, state=EXCLUDED.state, updated_at=NOW()
            """, (job["audit_id"], job["status"], json.dumps({**job, "_persisted": True})))
            conn.commit()
        return True
    except Exception:
        return False


def _load_job(job_id: str) -> dict | None:
    try:
        if not _ensure_store():
            return None
        with psycopg.connect(_database_url(), connect_timeout=3) as conn:
            row = conn.execute(
                "SELECT state FROM goldsight_instrument_audits WHERE audit_id=%s",
                (job_id,),
            ).fetchone()
        if not row:
            return None
        state = row[0]
        return json.loads(state) if isinstance(state, str) else state
    except Exception:
        return None


def _load_latest_job() -> dict | None:
    """Return the most recently updated audit, whether running or complete."""
    try:
        if not _ensure_store():
            return None
        with psycopg.connect(_database_url(), connect_timeout=3) as conn:
            row = conn.execute(
                "SELECT state FROM goldsight_instrument_audits ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        if not row:
            return None
        state = row[0]
        return json.loads(state) if isinstance(state, str) else state
    except Exception:
        return None


def _load_active_job() -> dict | None:
    try:
        if not _ensure_store():
            return None
        with psycopg.connect(_database_url(), connect_timeout=3) as conn:
            row = conn.execute("""
                SELECT state FROM goldsight_instrument_audits
                WHERE status='running' ORDER BY updated_at DESC LIMIT 1
            """).fetchone()
        if not row:
            return None
        state = row[0]
        return json.loads(state) if isinstance(state, str) else state
    except Exception:
        return None


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


def _public_snapshot(job: dict) -> dict:
    snapshot = dict(job)
    snapshot["persistence"] = "postgresql" if job.get("_persisted") else "memory_only"
    snapshot.pop("_persisted", None)
    return snapshot


def _run_audit(job_id: str) -> None:
    global _ACTIVE_JOB
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job or job_id not in _LOCAL_RUNNING:
            return
    executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="market-audit")
    try:
        results = job.get("results") or job.get("instruments") or _quote_snapshot()
        # Resume only missing symbol/timeframe checks after a process restart.
        pending = [
            (symbol, timeframe)
            for symbol in SYMBOLS for timeframe in TIMEFRAMES
            if timeframe not in results.get(symbol, {}).get("timeframes", {})
        ]
        tasks = {
            executor.submit(fetch_market, symbol, timeframe, 120): (symbol, timeframe)
            for symbol, timeframe in pending
        }
        for future in as_completed(tasks):
            symbol, timeframe = tasks[future]
            try:
                data = future.result()
                candles = normalize_candles(data.get("candles", []))
                latest = candles[-1] if candles else None
                checked_at = datetime.now(timezone.utc)
                age = max(0.0, checked_at.timestamp() - (int(latest["time"]) + TIMEFRAME_SECONDS[timeframe])) if latest else None
                grace = FRESHNESS_GRACE[timeframe]
                status = "OFFLINE" if latest is None else ("LIVE" if age is not None and age <= grace else "STALE")
                entry = {
                    "status": status, "provider": data.get("provider"),
                    "provider_symbol": data.get("provider_symbol"),
                    "candle_count": len(candles),
                    "latest_candle_at": datetime.fromtimestamp(int(latest["time"]), timezone.utc).isoformat() if latest else None,
                    "age_seconds": round(age, 1) if age is not None else None,
                    "freshness_grace_seconds": grace, "error": None,
                    # Preserve provider-side history diagnostics (especially SiftingIO
                    # raw ordering, interval, returned row count and newest source bar).
                    "provider_diagnostics": data.get("history_diagnostics"),
                }
            except Exception as exc:
                entry = {
                    "status": "OFFLINE", "provider": None, "provider_symbol": None,
                    "candle_count": 0, "latest_candle_at": None, "age_seconds": None,
                    "freshness_grace_seconds": FRESHNESS_GRACE[timeframe], "error": str(exc)[:300],
                }
            results.setdefault(symbol, {"symbol": symbol, "quote": {}, "timeframes": {}})
            results[symbol].setdefault("timeframes", {})[timeframe] = entry
            with _LOCK:
                job["completed_checks"] = sum(
                    timeframe_name in results.get(symbol_name, {}).get("timeframes", {})
                    for symbol_name in SYMBOLS for timeframe_name in TIMEFRAMES
                )
                job["results"] = results
                job["instruments"] = list(results.values())
                job["_persisted"] = _save_job(job)
                _JOBS[job_id] = job
        for symbol, item in results.items():
            states = [item["timeframes"].get(tf, {}).get("status", "PENDING") for tf in TIMEFRAMES]
            item["candle_summary"] = {state: states.count(state) for state in ("LIVE", "STALE", "OFFLINE", "PENDING")}
            item["overall_status"] = (
                "LIVE" if item.get("quote", {}).get("status") == "LIVE" and all(s == "LIVE" for s in states)
                else "PARTIAL" if item.get("quote", {}).get("status") == "LIVE" or any(s == "LIVE" for s in states)
                else "OFFLINE"
            )
        summary = {
            "instruments": len(results),
            "live_quotes": sum(v.get("quote", {}).get("status") == "LIVE" for v in results.values()),
            "stale_quotes": sum(v.get("quote", {}).get("status") == "STALE" for v in results.values()),
            "offline_quotes": sum(v.get("quote", {}).get("status") == "OFFLINE" for v in results.values()),
            "fully_live_instruments": sum(v.get("overall_status") == "LIVE" for v in results.values()),
        }
        with _LOCK:
            job.update(status="complete", checked_at=datetime.now(timezone.utc).isoformat(),
                       summary=summary, instruments=list(results.values()), results=results)
            job["_persisted"] = _save_job(job)
            _JOBS[job_id] = job
    except Exception as exc:
        with _LOCK:
            job.update(status="failed", error=str(exc)[:300])
            job["_persisted"] = _save_job(job)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
        with _LOCK:
            _LOCAL_RUNNING.discard(job_id)
            if _ACTIVE_JOB == job_id:
                _ACTIVE_JOB = None


def _launch(job_id: str) -> None:
    with _LOCK:
        if job_id in _LOCAL_RUNNING:
            return
        _LOCAL_RUNNING.add(job_id)
    Thread(target=_run_audit, args=(job_id,), daemon=True, name="instrument-audit").start()


def start_or_get_audit(force_new: bool = False) -> dict:
    global _ACTIVE_JOB
    if not force_new:
        with _LOCK:
            if _ACTIVE_JOB and _ACTIVE_JOB in _JOBS and _JOBS[_ACTIVE_JOB]["status"] == "running":
                return _public_snapshot(_JOBS[_ACTIVE_JOB])
            latest_local = max(_JOBS.values(), key=lambda item: item.get("started_at", ""), default=None)
            if latest_local and latest_local.get("status") == "complete":
                return _public_snapshot(latest_local)
        stored = _load_active_job()
        if stored and stored.get("status") == "running":
            with _LOCK:
                _JOBS[stored["audit_id"]] = stored
                _ACTIVE_JOB = stored["audit_id"]
            _launch(stored["audit_id"])
            return _public_snapshot(stored)
        latest = _load_latest_job()
        if latest and latest.get("status") == "complete":
            with _LOCK:
                _JOBS[latest["audit_id"]] = latest
            return _public_snapshot(latest)
    job_id = uuid4().hex
    initial_results = _quote_snapshot()
    job = {
        "audit_id": job_id, "status": "running", "completed_checks": 0,
        "total_checks": len(SYMBOLS) * len(TIMEFRAMES),
        "instruments": list(initial_results.values()), "results": initial_results,
        "timeframes": list(TIMEFRAMES),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    job["_persisted"] = _save_job(job)
    with _LOCK:
        _JOBS[job_id] = job
        _ACTIVE_JOB = job_id
    _launch(job_id)
    with _LOCK:
        return _public_snapshot(_JOBS[job_id])


def get_audit(job_id: str) -> dict | None:
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        job = _load_job(job_id)
        if job is None:
            return None
        with _LOCK:
            _JOBS[job_id] = job
    if job.get("status") == "running":
        _launch(job_id)
    with _LOCK:
        return _public_snapshot(_JOBS[job_id])
