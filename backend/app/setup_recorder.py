"""Background sampler that records setups without an open browser tab.

The service must remain running for continuous monitoring. On a sleeping/free
web service, polling pauses while the process is asleep; use an always-on worker
or scheduled worker for dependable 24/7 monitoring.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any

from app.setup_history import database_configured, record_setup

logger = logging.getLogger(__name__)
POLL_SECONDS = max(60, int(os.getenv("SETUP_RECORDER_INTERVAL_SECONDS", "60")))
SLOW_TIMEFRAME_EVERY = max(1, 300 // POLL_SECONDS)
_poll_count = 0
_last_poll_at: str | None = None
_last_error: str | None = None
_recorded_last_poll = 0
_task: asyncio.Task | None = None


def recorder_status() -> dict[str, Any]:
    return {
        "enabled": database_configured(),
        "running": _task is not None and not _task.done(),
        "poll_interval_seconds": POLL_SECONDS,
        "last_poll_at": _last_poll_at,
        "last_error": _last_error,
        "recorded_last_poll": _recorded_last_poll,
        "note": "Monitoring runs on the server, not in the browser. A sleeping host pauses polling.",
    }


async def _poll_once(include_slow_timeframes: bool = False) -> None:
    global _last_poll_at, _last_error, _recorded_last_poll
    from app.main import market

    recorded = 0
    errors: list[str] = []
    # Check the same supported symbols/timeframes as the dashboard. The market
    # endpoint itself enforces candle freshness and higher-timeframe confirmation.
    for symbol in ("XAUUSD", "BTCUSD"):
        timeframes = ("5m", "15m", "1h", "4h") if include_slow_timeframes else ("5m",)
        for timeframe in timeframes:
            try:
                result = await asyncio.to_thread(market, symbol, timeframe)
                if isinstance(result, dict):
                    try:
                        from app.demo_trading import process_demo_market
                        await asyncio.to_thread(process_demo_market, symbol, timeframe, result)
                    except Exception as demo_exc:
                        logger.warning("Demo trading update failed for %s %s: %s", symbol, timeframe, demo_exc)
                if isinstance(result, dict) and record_setup(symbol, timeframe, result):
                    recorded += 1
            except Exception as exc:  # keep one provider failure from stopping all monitoring
                logger.warning("Setup recorder poll failed for %s %s: %s", symbol, timeframe, exc)
                errors.append(f"{symbol} {timeframe}: {str(exc)[:180]}")
    _last_poll_at = datetime.now(timezone.utc).isoformat()
    _recorded_last_poll = recorded
    _last_error = "; ".join(errors[:3]) if errors else None


async def _run() -> None:
    # Poll 5m setups every minute to reduce missed short-lived setups; scan slower
    # timeframes every five minutes to avoid excessive provider requests.
    global _last_error, _poll_count
    while True:
        try:
            _poll_count += 1
            await _poll_once(include_slow_timeframes=(_poll_count % SLOW_TIMEFRAME_EVERY == 1))
        except Exception:
            logger.exception("Unexpected setup recorder loop error")
            _last_error = "Unexpected polling error; check backend logs."
        await asyncio.sleep(POLL_SECONDS)


async def start_recorder() -> None:
    global _task
    if not database_configured():
        logger.warning("Setup history recorder is disabled: DATABASE_URL is not configured.")
        return
    from app.setup_history import initialize_history_store
    try:
        await asyncio.to_thread(initialize_history_store)
        from app.demo_trading import initialize_demo_store
        await asyncio.to_thread(initialize_demo_store)
    except Exception:
        logger.exception("Could not initialize persistent setup history store")
        return
    if _task is None or _task.done():
        _task = asyncio.create_task(_run(), name="goldsight-setup-recorder")


async def stop_recorder() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
