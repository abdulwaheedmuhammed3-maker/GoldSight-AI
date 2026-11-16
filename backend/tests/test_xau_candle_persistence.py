import app.xau_candle_store as store
from app import siftingio_stream as stream


def _reset_stream():
    for timeframe in stream.TIMEFRAME_SECONDS:
        stream._candles[timeframe].clear()
    stream._active_candles.clear()
    stream._last_tick_ms = 0
    stream._last_provider_tick_ms = None
    stream._state["partial_candles_discarded"] = 0


def test_only_signal_eligible_completed_candles_are_sent_to_persistence(monkeypatch):
    _reset_stream()
    saved = []
    monkeypatch.setattr(
        store, "save_completed_candle",
        lambda timeframe, candle: saved.append((timeframe, dict(candle))) or True,
    )
    base = 1_800_000_000

    # First bucket begins at process startup and is intentionally discarded.
    # The next bucket is continuously observed and is the only one persisted.
    for offset in range(10, 611, 20):
        stream._record_tick_as_candles({
            "timestamp_ms": (base + offset) * 1000,
            "price": 4050.0 + offset / 1000,
        })

    five_minute = [candle for timeframe, candle in saved if timeframe == "5m"]
    assert len(five_minute) == 1
    assert five_minute[0]["time"] == base + 300
    assert five_minute[0]["closed"] is True
    assert five_minute[0]["signal_eligible"] is True
    assert five_minute[0]["open"] == 4050.31
    assert five_minute[0]["close"] == 4050.59


def test_restore_replaces_memory_and_quarantines_persisted_active_candles(monkeypatch):
    _reset_stream()
    expected = {
        timeframe: [{
            "time": 1_800_000_000, "open": 4050.0, "high": 4051.0,
            "low": 4049.0, "close": 4050.5, "volume": 0.0,
            "tick_count": 10, "closed": True, "source": "SiftingIO WebSocket com ticks",
        }]
        for timeframe in stream.TIMEFRAME_SECONDS
    }
    active = {
        "5m": {
            "time": 1_800_000_000, "open": 4050.0, "high": 4051.0,
            "low": 4049.0, "close": 4050.5, "volume": 0.0,
            "tick_count": 10, "last_tick_ms": 1_800_000_055_000,
            "source": "SiftingIO WebSocket com ticks",
        }
    }
    monkeypatch.setattr(store, "load_recent_candles", lambda limit: expected)
    monkeypatch.setattr(store, "load_active_candles", lambda: active)
    counts = stream.restore_xau_stream_candles(now_ts=1_800_000_060)

    assert counts == {timeframe: 1 for timeframe in stream.TIMEFRAME_SECONDS}
    assert stream.get_xau_stream_candles("15m")["candles"][0]["close"] == 4050.5
    recovered = stream.get_xau_stream_candles("5m")["active_candle"]
    assert recovered["recovered_after_restart"] is True
    assert recovered["signal_eligible"] is False


def test_completed_storage_rejects_partial_or_untrusted_candle(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://test")

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, *args, **kwargs):
            raise AssertionError("Untrusted candles must not reach PostgreSQL.")

    monkeypatch.setattr(store.psycopg, "connect", lambda *args, **kwargs: FakeConnection())
    partial = {
        "time": 1_800_000_000, "open": 4050.0, "high": 4052.0,
        "low": 4049.0, "close": 4051.0, "tick_count": 5,
        "closed": True, "signal_eligible": False,
    }
    assert store.save_completed_candle("5m", partial) is False
