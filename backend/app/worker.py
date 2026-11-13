"""Standalone always-on process for setup recording and notification delivery.

Run with: python -m app.worker
The API process can set TRADESIGHT_RECORDER_ENABLED=false to avoid running a
second recorder loop. Both processes must use the same DATABASE_URL and provider
/notification environment variables.
"""
from __future__ import annotations

import asyncio
import logging
import signal

from app.market_data_manager import start_market_data_manager, stop_market_data_manager
from app.setup_recorder import (
    database_configured,
    recorder_status,
    start_recorder,
    stop_recorder,
)

logger = logging.getLogger("tradesight.worker")


async def run_worker(stop_event: asyncio.Event | None = None) -> None:
    """Start the quote tracker and recorder, then stay alive until shutdown."""
    if not database_configured():
        raise RuntimeError("The TradeSight worker requires DATABASE_URL.")

    event = stop_event or asyncio.Event()
    await start_market_data_manager()
    try:
        await start_recorder()
        if not recorder_status().get("running"):
            raise RuntimeError(
                "The setup recorder did not start. Check DATABASE_URL and backend logs."
            )
        logger.info("TradeSight background worker started.")
        await event.wait()
    finally:
        await stop_recorder()
        await stop_market_data_manager()
        logger.info("TradeSight background worker stopped.")


async def main() -> None:
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(shutdown_signal, stop_event.set)
        except (NotImplementedError, RuntimeError):
            # asyncio.run still performs cleanup on KeyboardInterrupt/platform shutdown.
            pass
    await run_worker(stop_event)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
