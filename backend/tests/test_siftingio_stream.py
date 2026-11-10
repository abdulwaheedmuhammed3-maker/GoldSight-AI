from app import siftingio_stream as stream


def test_valid_siftingio_xau_tick_is_normalized(monkeypatch):
    monkeypatch.setattr(stream, "_last_tick_ms", 0)
    tick = stream._valid_tick({
        "f": "tick", "s": "XAUUSD", "p": 4050.5,
        "b": 4050.4, "a": 4050.6, "t": 1_800_000_000_000,
    }, now_ms=1_800_000_000_000)
    assert tick is not None
    assert tick["symbol"] == "XAUUSD"
    assert tick["price"] == 4050.5
    assert tick["timestamp_ms"] == 1_800_000_000_000


def test_rejects_wrong_symbol_and_stale_tick(monkeypatch):
    monkeypatch.setattr(stream, "_last_tick_ms", 0)
    base = {"f": "tick", "s": "XAUUSD", "p": 4050.5,
            "b": 4050.4, "a": 4050.6, "t": 1_800_000_000_000}
    wrong = dict(base, s="BTCUSD")
    assert stream._valid_tick(wrong, now_ms=1_800_000_000_000) is None
    assert stream._valid_tick(base, now_ms=1_800_000_100_000) is None


def test_rejects_future_and_out_of_order_ticks(monkeypatch):
    monkeypatch.setattr(stream, "_last_tick_ms", 0)
    base = {"f": "tick", "s": "XAUUSD", "p": 4050.5,
            "b": 4050.4, "a": 4050.6, "t": 1_800_000_000_000}
    assert stream._valid_tick(base, now_ms=1_799_999_990_000) is None
    assert stream._valid_tick(base, now_ms=1_800_000_000_000) is not None
    older = dict(base, t=1_799_999_999_000)
    assert stream._valid_tick(older, now_ms=1_800_000_000_000) is None


def test_rejects_invalid_price_geometry(monkeypatch):
    monkeypatch.setattr(stream, "_last_tick_ms", 0)
    bad = {"f": "tick", "s": "XAUUSD", "p": 4050.5,
           "b": 4051.0, "a": 4050.0, "t": 1_800_000_000_000}
    assert stream._valid_tick(bad, now_ms=1_800_000_000_000) is None


def test_valid_tick_rejection_reason_is_counted(monkeypatch):
    monkeypatch.setattr(stream, "_last_tick_ms", 0)
    monkeypatch.setattr(stream, "_state", {"rejected_ticks": 0, "validation_rejections_by_reason": {}})
    bad = {"f": "tick", "s": "XAUUSD", "p": 4050.5, "b": 4051.0, "a": 4050.0, "t": 1_800_000_000_000}
    assert stream._valid_tick(bad, now_ms=1_800_000_000_000) is None
    status = stream.get_xau_stream_status()
    assert status["validation_rejections_by_reason"] == {"invalid_bid_ask_geometry": 1}
    assert status["rejected_ticks"] == 1


def test_tick_feed_telemetry_tracks_arrival_and_provider_gaps(monkeypatch):
    monkeypatch.setattr(stream, "_last_arrival_monotonic", None)
    monkeypatch.setattr(stream, "_last_provider_tick_ms", None)
    monkeypatch.setattr(stream, "_state", {"rejected_ticks": 0, "validation_rejections_by_reason": {}, "max_arrival_gap_seconds": 0.0, "max_provider_timestamp_gap_seconds": 0.0, "provider_timestamp_gap_events": 0})
    times = iter([10.0, 25.0])
    monkeypatch.setattr(stream.time, "monotonic", lambda: next(times))
    monkeypatch.setattr(stream, "_valid_tick", lambda message: {"timestamp_ms": message["t"], "timestamp": "2026-11-10T00:00:00+00:00", "age_seconds": 0.0, "symbol": "XAUUSD", "price": 4050.0})
    monkeypatch.setattr(stream, "_record_tick_as_candles", lambda tick: None)
    class FakeWS: pass
    stream._on_message(FakeWS(), '{"f":"tick","s":"XAUUSD","t":1000000}')
    stream._on_message(FakeWS(), '{"f":"tick","s":"XAUUSD","t":1015000}')
    status=stream.get_xau_stream_status()
    assert status["last_arrival_gap_seconds"] == 15.0
    assert status["last_provider_timestamp_gap_seconds"] == 15.0
    assert status["provider_timestamp_gap_events"] == 1
