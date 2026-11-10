from datetime import datetime, timezone

from app import main


def test_xau_stream_diagnostics_compares_websocket_and_rest(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    candles = [
        {"time": now - 900, "open": 10, "high": 11, "low": 9, "close": 10,
         "closed": True, "tick_count": 12, "source": "SiftingIO WebSocket com ticks"},
        {"time": now - 300, "open": 10, "high": 12, "low": 9, "close": 11,
         "closed": True, "tick_count": 20, "source": "SiftingIO WebSocket com ticks"},
    ]
    active = {"time": now, "tick_count": 4, "closed": False}
    monkeypatch.setattr(main, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": candles, "active_candle": active,
    })
    monkeypatch.setattr(main, "get_xau_stream_status", lambda: {
        "status": "LIVE", "connected": True, "subscribed": True,
        "last_tick_at": "2026-11-10T22:00:00+00:00",
        "last_tick_age_seconds": 0.2, "ticks_received": 100,
        "rejected_ticks": 0, "last_error": None,
    })
    monkeypatch.setattr(main, "siftingio_history_diagnostics", lambda timeframe, limit: {
        "newest_valid_candle_at": datetime.fromtimestamp(now - 600, timezone.utc).isoformat(),
        "newest_valid_candle_age_seconds": 600, "valid_unique_rows": 240,
        "gap_count": 2, "history_pages_fetched": 1,
    })

    result = main.xau_stream_candle_diagnostics("5m")

    assert result["tick_stream"]["status"] == "LIVE"
    assert result["websocket_candles"]["completed_count"] == 2
    assert result["websocket_candles"]["latest_completed_tick_count"] == 20
    assert result["websocket_candles"]["freshness_gate_passes"] is True
    assert result["websocket_candles"]["active_candle"]["closed"] is False
    assert result["websocket_candles"]["gap_count_in_last_100_completed"] == 1
    assert result["rest_history"]["valid_unique_rows"] == 240
    assert result["signal_generation"] == "NOT_RUN"


def test_xau_stream_diagnostics_reports_stale_websocket_and_gaps(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    stale = {"time": now - 1800, "open": 10, "high": 11, "low": 9,
             "close": 10, "closed": True, "tick_count": 12}
    monkeypatch.setattr(main, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": [stale], "active_candle": None,
    })
    monkeypatch.setattr(main, "get_xau_stream_status", lambda: {
        "status": "LIVE", "connected": True, "subscribed": True,
        "last_tick_at": None, "last_tick_age_seconds": 0.2,
        "ticks_received": 100, "rejected_ticks": 0, "last_error": None,
    })
    monkeypatch.setattr(main, "siftingio_history_diagnostics", lambda timeframe, limit: {
        "newest_valid_candle_at": None, "newest_valid_candle_age_seconds": None,
        "valid_unique_rows": 0, "gap_count": 3, "history_pages_fetched": 0,
    })

    result = main.xau_stream_candle_diagnostics("5m")

    assert result["websocket_candles"]["freshness_gate_passes"] is False
    assert result["websocket_candles"]["gap_count_in_last_100_completed"] == 0
    assert result["rest_history"]["gap_count"] == 3
