from datetime import datetime, timezone

import pytest

from app import market


def _tick(age_seconds=1):
    stamp_ms = int((datetime.now(timezone.utc).timestamp() - age_seconds) * 1000)
    return {
        "price": 4321.5, "bid": 4321.4, "ask": 4321.6,
        "timestamp_ms": stamp_ms,
        "timestamp": datetime.fromtimestamp(stamp_ms / 1000, timezone.utc).isoformat(),
    }


def test_xau_quote_uses_fresh_websocket_tick(monkeypatch):
    from app import siftingio_stream

    monkeypatch.setattr(siftingio_stream, "get_xau_stream_status", lambda: {"last_tick": _tick(2)})
    quote = market._quote_from_provider("XAUUSD", "siftingio")

    assert quote["status"] == "LIVE"
    assert quote["quote_type"] == "live_websocket_tick"
    assert quote["provider"] == "SiftingIO WebSocket com ticks"
    assert quote["bid"] == pytest.approx(4321.4)
    assert quote["ask"] == pytest.approx(4321.6)
    assert quote["quote_age_seconds"] <= 30


def test_xau_quote_refuses_websocket_tick_older_than_30_seconds(monkeypatch):
    from app import siftingio_stream

    monkeypatch.setattr(siftingio_stream, "get_xau_stream_status", lambda: {"last_tick": _tick(31)})
    with pytest.raises(market.MarketUnavailable, match="maximum 30s"):
        market._quote_from_provider("XAUUSD", "siftingio")


def test_xau_quote_does_not_fall_back_to_rest_when_websocket_missing(monkeypatch):
    from app import siftingio_stream

    monkeypatch.setattr(siftingio_stream, "get_xau_stream_status", lambda: {"last_tick": None})
    monkeypatch.setattr(market, "_siftingio_json", lambda *args, **kwargs: pytest.fail("REST quote fallback must not run"))
    with pytest.raises(market.MarketUnavailable, match="has not delivered a tick"):
        market.fetch_live_quote("XAUUSD")


def test_xau_stream_candles_override_historical_same_timestamp(monkeypatch):
    from app import siftingio_stream

    historical = [{"time": 300, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1}]
    live = [{"time": 300, "open": 10, "high": 12, "low": 9, "close": 11, "tick_count": 8, "closed": True}]
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": live, "active_candle": None,
    })

    merged, added = market._merge_siftingio_stream_candles(historical, "5m")

    assert len(merged) == 1
    assert merged[0]["close"] == 11
    assert merged[0]["source"] == "SiftingIO WebSocket com ticks"
    assert added == 0


def test_xau_stream_candles_add_only_completed_bars_and_never_active(monkeypatch):
    from app import siftingio_stream

    historical = [{"time": 300, "open": 10, "high": 11, "low": 9, "close": 10}]
    completed = {"time": 600, "open": 11, "high": 13, "low": 10, "close": 12, "closed": True, "tick_count": 5}
    active = {"time": 900, "open": 12, "high": 14, "low": 11, "close": 13, "closed": False}
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": [completed], "active_candle": active,
    })

    merged, added = market._merge_siftingio_stream_candles(historical, "5m")

    assert [row["time"] for row in merged] == [300, 600]
    assert added == 1
