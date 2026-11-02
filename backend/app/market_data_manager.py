"""Isolated background quote trackers for each supported instrument.

Each symbol owns its task and latest state. Provider errors are caught within
that symbol's loop, so one failed feed cannot stop other trackers.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from app.market import MarketUnavailable, fetch_live_quote

SYMBOLS = ("XAUUSD", "BTCUSD", "EURUSD", "GBPUSD")
POLL_SECONDS = 15
STALE_AFTER_SECONDS = 180

_tasks: dict[str, asyncio.Task] = {}
_quotes: dict[str, dict[str, Any]] = {
    symbol: {
        "symbol": symbol, "status": "OFFLINE", "price": None, "bid": None,
        "ask": None, "spread": None, "updated_at": None, "provider": None,
        "detail": "Tracker is starting; waiting for the first provider quote.",
        "tracker": "independent",
    }
    for symbol in SYMBOLS
}
_running = False


def _offline(symbol: str, detail: str) -> dict[str, Any]:
    return {
        "symbol": symbol, "status": "OFFLINE", "price": None, "bid": None,
        "ask": None, "spread": None, "updated_at": None, "provider": None,
        "detail": detail, "tracker": "independent",
    }


async def _track_symbol(symbol: str) -> None:
    while _running:
        try:
            quote = await asyncio.to_thread(fetch_live_quote, symbol)
            quote = dict(quote)
            quote["tracker"] = "independent"
            quote["tracker_updated_at"] = datetime.now(timezone.utc).isoformat()
            _quotes[symbol] = quote
        except MarketUnavailable as exc:
            _quotes[symbol] = _offline(symbol, str(exc))
        except Exception as exc:
            # Keep failures local to this symbol; don't let an unexpected
            # provider exception cancel the other tracker tasks.
            _quotes[symbol] = _offline(symbol, f"Unexpected tracker error: {type(exc).__name__}")
        await asyncio.sleep(POLL_SECONDS)


async def start_market_data_manager() -> None:
    global _running
    if _running:
        return
    _running = True
    for symbol in SYMBOLS:
        task = _tasks.get(symbol)
        if task is None or task.done():
            _tasks[symbol] = asyncio.create_task(_track_symbol(symbol), name=f"quote-tracker-{symbol}")


async def stop_market_data_manager() -> None:
    global _running
    _running = False
    tasks = list(_tasks.values())
    _tasks.clear()
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def get_tracked_quote(symbol: str) -> dict[str, Any]:
    quote = dict(_quotes.get(symbol, _offline(symbol, "No tracker state found.")))
    stamp = quote.get("updated_at")
    if quote.get("status") == "LIVE" and stamp:
        try:
            age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(
                str(stamp).replace("Z", "+00:00")
            ).timestamp()
            if age > STALE_AFTER_SECONDS or age < -30:
                return _offline(symbol, f"Last quote is stale ({int(age)} seconds old).")
            quote["quote_age_seconds"] = max(0, int(age))
        except (TypeError, ValueError, OverflowError):
            return _offline(symbol, "Quote timestamp is invalid.")
    return quote
