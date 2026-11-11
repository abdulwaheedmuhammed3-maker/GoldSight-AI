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


def test_siftingio_quote_does_not_fall_back_to_rest_when_websocket_missing(monkeypatch):
    from app import siftingio_stream

    monkeypatch.setattr(siftingio_stream, "get_xau_stream_status", lambda: {"last_tick": None})
    monkeypatch.setattr(market, "_siftingio_json", lambda *args, **kwargs: pytest.fail("REST quote fallback must not run"))
    with pytest.raises(market.MarketUnavailable, match="has not delivered a tick"):
        market._quote_from_provider("XAUUSD", "siftingio")


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


def test_xau_signal_gate_requires_fresh_completed_websocket_candle(monkeypatch):
    from app import siftingio_stream

    now = datetime.now(timezone.utc)
    fresh = {
        "time": int(now.timestamp()) - 300,
        "open": 4320, "high": 4325, "low": 4318, "close": 4323,
        "closed": True, "tick_count": 17,
    }
    calls = []
    def fake_stream(timeframe, limit):
        calls.append(timeframe)
        return {"candles": [fresh], "active_candle": None}
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", fake_stream)

    result = market._require_fresh_siftingio_stream_candle("5m", now)

    assert calls == ["5m"]
    assert result["source"] == "SiftingIO WebSocket com ticks"
    assert result["tick_count"] == 17


def test_stale_websocket_candle_blocks_even_if_rest_history_exists(monkeypatch):
    from app import siftingio_stream

    now = datetime.now(timezone.utc)
    stale = {
        "time": int(now.timestamp()) - 900,
        "open": 4320, "high": 4325, "low": 4318, "close": 4323,
        "closed": True, "tick_count": 17,
    }
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": [stale], "active_candle": None,
    })

    # REST history is deliberately irrelevant to this source-freshness gate.
    with pytest.raises(market.MarketUnavailable, match="WebSocket candle is stale"):
        market._require_fresh_siftingio_stream_candle("5m", now)


def test_four_hour_signal_gate_checks_direct_four_hour_websocket_candle(monkeypatch):
    from app import siftingio_stream

    now = datetime.now(timezone.utc)
    fresh = {
        "time": int(now.timestamp()) - 4 * 3600,
        "open": 4320, "high": 4325, "low": 4318, "close": 4323,
        "closed": True, "tick_count": 500,
    }
    calls = []
    def fake_stream(timeframe, limit):
        calls.append(timeframe)
        return {"candles": [fresh], "active_candle": None}
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", fake_stream)

    market._require_fresh_siftingio_stream_candle("4h", now)

    assert calls == ["4h"]


def test_xau_completed_candle_freshness_window_accounts_for_next_bar_close(monkeypatch):
    from app import siftingio_stream

    now = datetime.now(timezone.utc)
    # A completed 5m candle is timestamped at its OPEN. At the end of the
    # following 5m interval it is about 10 minutes old, but still the latest
    # completed bar while the current 5m candle is forming.
    latest_completed = {
        "time": int(now.timestamp()) - 600,
        "open": 4320, "high": 4325, "low": 4318, "close": 4323,
        "closed": True, "tick_count": 17,
    }
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": [latest_completed], "active_candle": {"time": int(now.timestamp()) - 300, "closed": False},
    })

    result = market._require_fresh_siftingio_stream_candle("5m", now)
    assert result["age_seconds"] == pytest.approx(600, abs=1)


def test_xau_completed_candle_still_expires_after_extended_freshness_window(monkeypatch):
    from app import siftingio_stream

    now = datetime.now(timezone.utc)
    stale = {
        "time": int(now.timestamp()) - 721,
        "open": 4320, "high": 4325, "low": 4318, "close": 4323,
        "closed": True, "tick_count": 17,
    }
    monkeypatch.setattr(siftingio_stream, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": [stale], "active_candle": None,
    })

    with pytest.raises(market.MarketUnavailable, match="WebSocket candle is stale"):
        market._require_fresh_siftingio_stream_candle("5m", now)
