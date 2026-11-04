import pytest

from app.exness import TIMEFRAMES, _b64url, _private_key
from app.market import MarketUnavailable


def test_exness_timeframes_match_documented_candle_api():
    assert TIMEFRAMES["5m"] == ("M5", 300)
    assert TIMEFRAMES["15m"] == ("M15", 900)
    assert TIMEFRAMES["30m"] == ("M30", 1800)
    assert TIMEFRAMES["1h"] == ("H1", 3600)
    assert TIMEFRAMES["4h"] == ("H4", 14400)


def test_base64url_is_unpadded():
    assert "=" not in _b64url(b"goldsight")


def test_private_key_missing_fails_closed(monkeypatch):
    monkeypatch.delenv("EXN_PRIVATE_KEY", raising=False)
    with pytest.raises(MarketUnavailable, match="EXN_PRIVATE_KEY"):
        _private_key()


def test_private_key_invalid_fails_closed(monkeypatch):
    monkeypatch.setenv("EXN_PRIVATE_KEY", "not-a-valid-key")
    with pytest.raises(MarketUnavailable, match="format rejected"):
        _private_key()


def test_hexadecimal_private_key_seed_is_accepted(monkeypatch):
    # Deterministic test vector; this is not a real credential.
    monkeypatch.setenv("EXN_PRIVATE_KEY", "00" * 32)
    key = _private_key()
    assert key.private_bytes_raw() == bytes(32)


def test_128_hex_seed_public_key_pair_is_accepted(monkeypatch):
    # Deterministic non-secret test vector using a zeroed seed.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    seed = bytes(32)
    private = Ed25519PrivateKey.from_private_bytes(seed)
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    monkeypatch.setenv("EXN_PRIVATE_KEY", (seed + public).hex())
    parsed = _private_key()
    assert parsed.private_bytes_raw() == seed


def test_128_hex_mismatched_public_half_is_rejected(monkeypatch):
    monkeypatch.setenv("EXN_PRIVATE_KEY", "00" * 64)
    with pytest.raises(MarketUnavailable, match="format rejected"):
        _private_key()



def test_exness_historical_candles_pages_forward_without_live_tick(monkeypatch):
    from datetime import datetime, timezone
    import app.exness as exness

    monkeypatch.setenv("EXN_ACCOUNT_ID", "12345")
    monkeypatch.setenv("EXN_INSTRUMENT_XAUUSD", "XAUUSD")
    monkeypatch.setattr(exness, "_access_point", lambda: "https://example.test")
    calls = []
    start = 1_700_000_000
    def fake_request(base, path):
        calls.append(path)
        if "/configuration/" in path:
            return {"instruments": ["XAUUSD"]}
        if len([p for p in calls if "/candles?" in p]) == 1:
            stamps = [start, start + 300]
        else:
            stamps = [start + 600]
        return {"candles": [
            {"time": datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z"),
             "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000.5}, "volume": 10}
            for t in stamps
        ]}
    monkeypatch.setattr(exness, "_json_request", fake_request)
    result = exness.exness_historical_candles("XAUUSD", "5m", start, start + 900, page_size=50)
    assert [c["time"] for c in result] == [start, start + 300, start + 600]
    assert len([p for p in calls if "/candles?" in p]) == 2


@pytest.mark.parametrize("tick", [
    {"bid": "NaN", "ask": "2000", "timestamp": "2026-11-03T12:00:00Z"},
    {"bid": "2000", "ask": "Infinity", "timestamp": "2026-11-03T12:00:00Z"},
    {"bid": "2000", "ask": "2001", "timestamp": "2026-11-03T12:00:00"},
    {"bid": True, "ask": "2001", "timestamp": "2026-11-03T12:00:00Z"},
    {"bid": "2001", "ask": "2000", "timestamp": "2026-11-03T12:00:00Z"},
    {"bid": "2000", "ask": "2001", "timestamp": "not-a-timestamp"},
    {"bid": "2000", "ask": "2001", "timestamp": None},
])
def test_exness_tick_rejects_nonfinite_prices_and_naive_timestamps(monkeypatch, tick):
    import json
    import app.exness as exness

    class FakeConnection:
        def send(self, _message):
            pass

        def recv(self):
            return json.dumps({"instrument": "XAUUSD", **tick})

        def close(self):
            pass

    class FakeWebSocket:
        @staticmethod
        def create_connection(*args, **kwargs):
            return FakeConnection()

    monkeypatch.setattr(exness, "websocket", FakeWebSocket)
    monkeypatch.setattr(exness, "_access_point", lambda: "https://example.test")
    monkeypatch.setattr(exness, "_signed_headers", lambda *args: {})
    # End the receive loop after one malformed provider tick without waiting.
    clock = iter([0.0, 0.0, 9.0])
    monkeypatch.setattr(exness.time, "monotonic", lambda: next(clock))

    with pytest.raises(MarketUnavailable, match="No fresh Exness tick"):
        exness._tick("XAUUSD", timeout=8.0)


@pytest.mark.parametrize("candle", [
    {"time": "2026-11-03T12:00:00", "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000}},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": "NaN", "low": 1999, "close": 2000}},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": 1999, "low": 1998, "close": 2000}},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": 2001, "low": 2002, "close": 2000}},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000}, "volume": -1},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000}, "volume": True},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000}, "volume": float("nan")},
    {"time": "2026-11-03T12:00:00Z", "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000}, "volume": 10.5},
])
def test_exness_candle_parser_rejects_invalid_timezone_ohlc_and_volume(candle):
    import app.exness as exness

    with pytest.raises((ValueError, OverflowError)):
        exness._validated_candle(candle)


def test_exness_candle_parser_accepts_valid_timezone_aware_ohlc():
    import app.exness as exness

    candle = exness._validated_candle({
        "time": "2026-11-03T12:00:00Z",
        "bid": {"open": 2000, "high": 2002, "low": 1998, "close": 2001},
        "volume": 10,
    })
    assert candle == {"time": 1793707200, "open": 2000.0, "high": 2002.0, "low": 1998.0, "close": 2001.0, "volume": 10}


def test_exness_market_requires_40_distinct_valid_candles(monkeypatch):
    import app.exness as exness
    from datetime import datetime, timezone

    monkeypatch.setenv("EXN_ACCOUNT_ID", "12345")
    monkeypatch.setenv("EXN_INSTRUMENT_XAUUSD", "XAUUSD")
    monkeypatch.setattr(exness, "_access_point", lambda: "https://example.test")
    monkeypatch.setattr(exness, "_available_instruments", lambda *args: {"XAUUSD"})
    stamp = datetime.fromtimestamp(1_700_000_000, timezone.utc).isoformat().replace("+00:00", "Z")
    duplicate_rows = [
        {"time": stamp, "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000.5}, "volume": 10}
        for _ in range(40)
    ]
    monkeypatch.setattr(exness, "_json_request", lambda *args: {"candles": duplicate_rows})
    monkeypatch.setattr(exness, "_tick", lambda *args: {
        "instrument": "XAUUSD", "bid": 2000, "ask": 2001, "timestamp": stamp,
    })

    with pytest.raises(MarketUnavailable, match="40 distinct valid OHLC candles"):
        exness.exness_market("XAUUSD", "5m", limit=45)


def test_exness_market_keeps_real_candles_when_tick_stream_is_unavailable(monkeypatch):
    import app.exness as exness
    from datetime import datetime, timezone

    monkeypatch.setenv("EXN_ACCOUNT_ID", "12345")
    monkeypatch.setenv("EXN_INSTRUMENT_XAUUSD", "XAUUSD")
    monkeypatch.setattr(exness, "_access_point", lambda: "https://example.test")
    monkeypatch.setattr(exness, "_available_instruments", lambda *args: {"XAUUSD"})
    now = int(datetime.now(timezone.utc).timestamp())
    rows = [
        {"time": datetime.fromtimestamp(now - (45 - index) * 300, timezone.utc).isoformat().replace("+00:00", "Z"),
         "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000.5}, "volume": 10}
        for index in range(45)
    ]
    monkeypatch.setattr(exness, "_json_request", lambda *args: {"candles": rows})
    monkeypatch.setattr(exness, "_tick", lambda *args: (_ for _ in ()).throw(MarketUnavailable("tick auth failed")))

    result = exness.exness_market("XAUUSD", "5m", limit=45)

    assert result["status"] == "LIVE"
    assert result["candle_status"] == "LIVE"
    assert result["quote_status"] == "OFFLINE"
    assert result["price"] is None and result["spread"] is None
    assert len(result["candles"]) == 45
    assert result["quote_error"] == "tick auth failed"


@pytest.mark.parametrize("field", ["open", "high", "low", "close"])
def test_exness_candle_parser_rejects_boolean_ohlc(field):
    import app.exness as exness

    candle = {
        "time": "2026-11-03T12:00:00Z",
        "bid": {"open": 2000, "high": 2001, "low": 1999, "close": 2000},
        "volume": 10,
    }
    candle["bid"][field] = True
    with pytest.raises(ValueError, match="boolean"):
        exness._validated_candle(candle)

