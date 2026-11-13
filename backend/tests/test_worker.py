import asyncio

import pytest

from app import worker


@pytest.mark.asyncio
async def test_worker_starts_and_stops_services(monkeypatch):
    stop_event = asyncio.Event()
    calls = []

    monkeypatch.setattr(worker, "database_configured", lambda: True)

    async def start_quotes():
        calls.append("start_quotes")

    async def start_recorder():
        calls.append("start_recorder")

    async def stop_recorder():
        calls.append("stop_recorder")

    async def stop_quotes():
        calls.append("stop_quotes")

    monkeypatch.setattr(worker, "start_market_data_manager", start_quotes)
    monkeypatch.setattr(worker, "start_recorder", start_recorder)
    monkeypatch.setattr(worker, "stop_recorder", stop_recorder)
    monkeypatch.setattr(worker, "stop_market_data_manager", stop_quotes)
    monkeypatch.setattr(worker, "recorder_status", lambda: {"running": True})

    task = asyncio.create_task(worker.run_worker(stop_event))
    await asyncio.sleep(0)
    stop_event.set()
    await task

    assert calls == [
        "start_quotes",
        "start_recorder",
        "stop_recorder",
        "stop_quotes",
    ]


@pytest.mark.asyncio
async def test_worker_requires_database(monkeypatch):
    monkeypatch.setattr(worker, "database_configured", lambda: False)

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        await worker.run_worker()
