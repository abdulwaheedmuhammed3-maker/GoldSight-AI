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

from app.setup_history import database_configured, record_setup, refresh_setup_outcomes

logger = logging.getLogger(__name__)
POLL_SECONDS = max(60, int(os.getenv("SETUP_RECORDER_INTERVAL_SECONDS", "60")))
# Keep the fast management loop frequent while staggering slower signal scans.
# A 5m market request already fetches 15m confirmation internally.
FIFTEEN_MINUTE_EVERY = max(1, 300 // POLL_SECONDS)
ONE_HOUR_EVERY = max(1, 900 // POLL_SECONDS)
FOUR_HOUR_EVERY = max(1, 3600 // POLL_SECONDS)
_poll_count = 0
_last_poll_at: str | None = None
_last_poll_started_at: str | None = None
_last_poll_duration_seconds: float | None = None
_last_poll_cycles_completed = 0
_last_error: str | None = None
_recorded_last_poll = 0
_task: asyncio.Task | None = None


def recorder_status() -> dict[str, Any]:
    return {
        "enabled": database_configured(),
        "running": _task is not None and not _task.done(),
        "poll_interval_seconds": POLL_SECONDS,
        "scan_schedule": {
            "5m": "every poll",
            "15m": f"every {FIFTEEN_MINUTE_EVERY} polls",
            "1h": f"every {ONE_HOUR_EVERY} polls",
            "4h": f"every {FOUR_HOUR_EVERY} polls",
        },
        "last_poll_at": _last_poll_at,
        "last_poll_started_at": _last_poll_started_at,
        "last_poll_duration_seconds": _last_poll_duration_seconds,
        "poll_cycles_completed": _last_poll_cycles_completed,
        "last_error": _last_error,
        "recorded_last_poll": _recorded_last_poll,
        "note": "Monitoring runs on the server, not in the browser. A sleeping host pauses polling.",
    }


async def _poll_once(
    include_15m: bool = False,
    include_1h: bool = False,
    include_4h: bool = False,
) -> None:
    global _last_poll_at, _last_poll_started_at, _last_poll_duration_seconds
    global _last_poll_cycles_completed, _last_error, _recorded_last_poll
    from app.main import market

    poll_started = datetime.now(timezone.utc)
    _last_poll_started_at = poll_started.isoformat()
    recorded = 0
    errors: list[str] = []
    # 5m is polled every cycle for timely demo management. Slower standalone
    # signal scans are staggered to avoid repeatedly fetching unchanged candles.
    # Each market endpoint still obtains its own higher-timeframe confirmation.
    timeframes = ["5m"]
    if include_15m:
        timeframes.append("15m")
    if include_1h:
        timeframes.append("1h")
    if include_4h:
        timeframes.append("4h")
    for symbol in ("XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"):
        for timeframe in timeframes:
            try:
                result = await asyncio.to_thread(market, symbol, timeframe)
                if isinstance(result, dict):
                    try:
                        from app.demo_trading import process_demo_market
                        await asyncio.to_thread(process_demo_market, symbol, timeframe, result)
                    except Exception as demo_exc:
                        logger.warning("Demo trading update failed for %s %s: %s", symbol, timeframe, demo_exc)
                if isinstance(result, dict):
                    recorded += int(record_setup(symbol, timeframe, result))
                    await asyncio.to_thread(refresh_setup_outcomes, symbol, timeframe, result)
            except Exception as exc:  # keep one provider failure from stopping all monitoring
                logger.warning("Setup recorder poll failed for %s %s: %s", symbol, timeframe, exc)
                errors.append(f"{symbol} {timeframe}: {str(exc)[:180]}")
    poll_finished = datetime.now(timezone.utc)
    _last_poll_at = poll_finished.isoformat()
    _last_poll_duration_seconds = round((poll_finished - poll_started).total_seconds(), 2)
    _last_poll_cycles_completed += 1
    _recorded_last_poll = recorded
    _last_error = "; ".join(errors[:3]) if errors else None


async def _run() -> None:
    # Poll 5m every cycle; stagger 15m, 1h and 4h scans at their natural
    # monitoring cadence to reduce duplicate Exness requests and rate-limit risk.
    global _last_error, _poll_count
    while True:
        try:
            _poll_count += 1
            await _poll_once(
                include_15m=(_poll_count % FIFTEEN_MINUTE_EVERY == 1),
                include_1h=(_poll_count % ONE_HOUR_EVERY == 1),
                include_4h=(_poll_count % FOUR_HOUR_EVERY == 1),
            )
            news_every = max(1, 300 // POLL_SECONDS)
            if _poll_count % news_every == 1:
                try:
                    from app.fundamentals import get_fundamental_news
                    news = await asyncio.to_thread(get_fundamental_news, 100, True)
                    if news.get("status") == "LIVE":
                        from app.push_notifications import send_news_notification
                        # Let the preference matcher decide per device whether region
                        # or topic approval permits this headline. Do not pre-filter to
                        # Nigeria/high-impact: that drops ordinary African and football news.
                        for item in news.get("items", []):
                            await asyncio.to_thread(send_news_notification, item)
                except Exception:
                    logger.exception("High-impact news notification polling failed")
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
