from app import siftingio_stream as stream


def _tick(stamp_seconds, price):
    return {
        "timestamp_ms": int(stamp_seconds * 1000),
        "price": float(price),
    }


def test_ticks_aggregate_into_completed_and_active_ohlc(monkeypatch):
    for timeframe in stream.TIMEFRAME_SECONDS:
        stream._candles[timeframe].clear()
    stream._active_candles.clear()
    base = 1_800_000_000
    stream._record_tick_as_candles(_tick(base + 10, 4050.0))
    stream._record_tick_as_candles(_tick(base + 20, 4053.0))
    stream._record_tick_as_candles(_tick(base + 310, 4051.0))

    result = stream.get_xau_stream_candles("5m")
    assert result["completed_candles"] == 1
    candle = result["candles"][0]
    assert candle["time"] == base
    assert candle["open"] == 4050.0
    assert candle["high"] == 4053.0
    assert candle["low"] == 4050.0
    assert candle["close"] == 4053.0
    assert candle["tick_count"] == 2
    assert candle["closed"] is True
    assert result["active_candle"]["time"] == base + 300
    assert result["active_candle"]["closed"] is False


def test_aggregator_does_not_fill_missing_time_buckets():
    for timeframe in stream.TIMEFRAME_SECONDS:
        stream._candles[timeframe].clear()
    stream._active_candles.clear()
    base = 1_800_000_000
    stream._record_tick_as_candles(_tick(base + 5, 4050.0))
    stream._record_tick_as_candles(_tick(base + 605, 4060.0))
    result = stream.get_xau_stream_candles("5m")
    assert result["completed_candles"] == 1
    assert result["candles"][0]["time"] == base
    assert result["active_candle"]["time"] == base + 600


def test_candle_endpoint_data_is_timeframe_specific():
    try:
        stream.get_xau_stream_candles("1m")
    except ValueError as exc:
        assert "Unsupported timeframe" in str(exc)
    else:
        raise AssertionError("Unsupported timeframe must be rejected")
