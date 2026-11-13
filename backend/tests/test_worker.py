import asyncio

import pytest

from app import worker


def test_worker_starts_and_stops_services(monkeypatch):
    stop_event = asyncio.Event()
    stop_event.set()
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

    asyncio.run(worker.run_worker(stop_event))

    assert calls == [
        "start_quotes",
        "start_recorder",
        "stop_recorder",
        "stop_quotes",
    ]


def test_worker_requires_database(monkeypatch):
    monkeypatch.setattr(worker, "database_configured", lambda: False)

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        asyncio.run(worker.run_worker())
