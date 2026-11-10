import app.xau_candle_store as store
from app import siftingio_stream as stream


def test_completed_live_candle_is_sent_to_persistence(monkeypatch):
    for timeframe in stream.TIMEFRAME_SECONDS:
        stream._candles[timeframe].clear()
    stream._active_candles.clear()
    saved = []
    monkeypatch.setattr(store, "save_completed_candle", lambda timeframe, candle: saved.append((timeframe, dict(candle))) or True)
    base = 1_800_000_000
    stream._record_tick_as_candles({"timestamp_ms": (base + 5) * 1000, "price": 4050.0})
    stream._record_tick_as_candles({"timestamp_ms": (base + 305) * 1000, "price": 4052.0})
    assert any(tf == "5m" for tf, _ in saved)
    five_minute = next(candle for tf, candle in saved if tf == "5m")
    assert five_minute["closed"] is True
    assert five_minute["open"] == 4050.0
    assert five_minute["close"] == 4050.0


def test_restore_replaces_memory_with_persisted_completed_candles(monkeypatch):
    expected = {
        timeframe: [{
            "time": 1_800_000_000, "open": 4050.0, "high": 4051.0,
            "low": 4049.0, "close": 4050.5, "volume": 0.0,
            "tick_count": 10, "closed": True, "source": "SiftingIO WebSocket com ticks",
        }]
        for timeframe in stream.TIMEFRAME_SECONDS
    }
    monkeypatch.setattr(store, "load_recent_candles", lambda limit: expected)
    counts = stream.restore_xau_stream_candles()
    assert counts == {timeframe: 1 for timeframe in stream.TIMEFRAME_SECONDS}
    assert stream.get_xau_stream_candles("15m")["candles"][0]["close"] == 4050.5
