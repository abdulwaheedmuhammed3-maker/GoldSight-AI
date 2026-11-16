from app import siftingio_stream as stream


def _tick(stamp_seconds, price):
    return {
        "timestamp_ms": int(stamp_seconds * 1000),
        "price": float(price),
    }


def _reset_stream():
    for timeframe in stream.TIMEFRAME_SECONDS:
        stream._candles[timeframe].clear()
    stream._active_candles.clear()
    stream._last_tick_ms = 0
    stream._last_provider_tick_ms = None
    stream._state["partial_candles_discarded"] = 0
    stream._state["recovered_active_candles"] = 0
    stream._state["active_candles_not_signal_eligible"] = 0


def _feed_ticks(start, end, step=20, price=4050.0):
    for stamp in range(start, end + 1, step):
        stream._record_tick_as_candles(_tick(stamp, price + (stamp - start) / 1000))


def test_cold_start_bucket_is_quarantined_then_next_complete_bucket_is_recorded(monkeypatch):
    _reset_stream()
    saved = []
    monkeypatch.setattr(
        "app.xau_candle_store.save_completed_candle",
        lambda timeframe, candle: saved.append((timeframe, dict(candle))) or True,
    )
    base = 1_800_000_000

    # The first observed bucket starts mid-period, so it cannot be trusted.
    _feed_ticks(base, base + 290)
    stream._record_tick_as_candles(_tick(base + 301, 4051.0))
    assert stream.get_xau_stream_candles("5m")["completed_candles"] == 0
    assert stream.get_xau_stream_candles("5m")["active_candle"]["signal_eligible"] is True

    # The next full bucket is observed continuously and is safe to complete.
    for offset in range(320, 600, 20):
        stream._record_tick_as_candles(_tick(base + offset, 4052.0 + offset / 1000))
    stream._record_tick_as_candles(_tick(base + 601, 4053.0))

    result = stream.get_xau_stream_candles("5m")
    assert result["completed_candles"] == 1
    candle = result["candles"][0]
    assert candle["time"] == base + 300
    assert candle["closed"] is True
    assert candle["signal_eligible"] is True
    assert candle["open"] == 4051.0
    assert candle["close"] == 4052.58
    assert any(tf == "5m" and bar["signal_eligible"] is True for tf, bar in saved)
    assert stream._state["partial_candles_discarded"] >= 1


def test_restored_active_bucket_is_quarantined_after_server_restart(monkeypatch):
    _reset_stream()
    base = 1_800_000_000
    persisted = {
        "5m": {
            "time": base, "open": 4050.0, "high": 4054.0,
            "low": 4049.0, "close": 4052.0, "tick_count": 50,
            "last_tick_ms": (base + 55) * 1000,
            "source": "SiftingIO WebSocket com ticks",
        }
    }
    monkeypatch.setattr(
        "app.xau_candle_store.load_recent_candles",
        lambda limit: {timeframe: [] for timeframe in stream.TIMEFRAME_SECONDS},
    )
    monkeypatch.setattr(
        "app.xau_candle_store.load_active_candles",
        lambda: persisted,
    )

    stream.restore_xau_stream_candles(now_ts=base + 60)
    active = stream.get_xau_stream_candles("5m")["active_candle"]
    assert active["recovered_after_restart"] is True
    assert active["signal_eligible"] is False
    assert active["integrity_reason"] == "recovered_after_process_restart"

    # Same-bucket ticks keep the bar visible but never re-enable its signal use.
    stream._record_tick_as_candles(_tick(base + 70, 4053.0))
    assert stream.get_xau_stream_candles("5m")["active_candle"]["signal_eligible"] is False

    # The recovered bucket is discarded at rollover. The new bucket can be used.
    stream._record_tick_as_candles(_tick(base + 301, 4055.0))
    result = stream.get_xau_stream_candles("5m")
    assert result["completed_candles"] == 0
    assert result["active_candle"]["time"] == base + 300
    assert result["active_candle"]["signal_eligible"] is False
    assert stream._state["partial_candles_discarded"] == 1


def test_provider_tick_gap_quarantines_current_candle():
    _reset_stream()
    base = 1_800_000_000
    _feed_ticks(base, base + 290)
    stream._record_tick_as_candles(_tick(base + 301, 4051.0))
    active = stream.get_xau_stream_candles("5m")["active_candle"]
    assert active["signal_eligible"] is True

    # A >30 second observation gap means the current OHLC may have missed an
    # extreme; it must not be promoted to a completed signal candle.
    stream._record_tick_as_candles(_tick(base + 340, 4060.0))
    active = stream.get_xau_stream_candles("5m")["active_candle"]
    assert active["signal_eligible"] is False
    assert active["integrity_reason"] == "provider_tick_gap"


def test_aggregator_does_not_fill_missing_time_buckets():
    _reset_stream()
    base = 1_800_000_000
    stream._record_tick_as_candles(_tick(base + 5, 4050.0))
    stream._record_tick_as_candles(_tick(base + 605, 4060.0))
    result = stream.get_xau_stream_candles("5m")
    assert result["completed_candles"] == 0
    assert result["active_candle"]["time"] == base + 600
    assert result["active_candle"]["signal_eligible"] is False


def test_candle_endpoint_data_is_timeframe_specific():
    try:
        stream.get_xau_stream_candles("1m")
    except ValueError as exc:
        assert "Unsupported timeframe" in str(exc)
    else:
        raise AssertionError("Unsupported timeframe must be rejected")
