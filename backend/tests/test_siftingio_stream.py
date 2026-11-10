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
