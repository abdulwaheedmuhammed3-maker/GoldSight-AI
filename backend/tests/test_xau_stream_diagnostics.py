from datetime import datetime, timezone

from app import main, market


def test_xau_stream_diagnostics_compares_websocket_and_rest(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    candles = [
        {"time": now - 900, "open": 10, "high": 11, "low": 9, "close": 10, "closed": True, "tick_count": 12},
        {"time": now - 300, "open": 10, "high": 12, "low": 9, "close": 11, "closed": True, "tick_count": 20},
    ]
    active = {"time": now, "tick_count": 4, "closed": False}
    monkeypatch.setattr(main, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": candles, "active_candle": active,
    })
    monkeypatch.setattr(main, "get_xau_stream_status", lambda: {
        "status": "LIVE", "connected": True, "last_tick_at": "2026-11-10T22:00:00+00:00",
        "last_tick_age_seconds": 0.2,
    })
    monkeypatch.setattr(main, "xau_candle_store_status", lambda: {
        "enabled": True, "backend": "PostgreSQL",
    })
    monkeypatch.setattr(market, "siftingio_history_diagnostics", lambda timeframe, limit: {
        "newest_valid_candle_at": datetime.fromtimestamp(now - 600, timezone.utc).isoformat(),
        "newest_valid_candle_age_seconds": 600, "gap_count": 2,
    })

    result = main.xau_stream_candle_diagnostics("5m")

    assert result["signal_generation"] == "NOT_RUN"
    assert result["websocket"]["completed_candle_count"] == 2
    assert result["websocket"]["gap_count"] == 1
    assert result["websocket"]["recent_gaps"][0]["missing_intervals"] == 1
    assert result["websocket"]["active_candle_tick_count"] == 4
    assert result["rest_history"]["newest_candle_age_seconds"] == 600
    assert result["selection_diagnostic"]["websocket_candle_passes_freshness"] is True


def test_xau_stream_diagnostics_reports_stale_websocket_and_rest_gap(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    stale = {"time": now - 1800, "open": 10, "high": 11, "low": 9,
             "close": 10, "closed": True, "tick_count": 12}
    monkeypatch.setattr(main, "get_xau_stream_candles", lambda timeframe, limit: {
        "candles": [stale], "active_candle": None,
    })
    monkeypatch.setattr(main, "get_xau_stream_status", lambda: {
        "status": "LIVE", "connected": True, "last_tick_at": None,
        "last_tick_age_seconds": 0.2,
    })
    monkeypatch.setattr(main, "xau_candle_store_status", lambda: {"enabled": False})
    monkeypatch.setattr(market, "siftingio_history_diagnostics", lambda timeframe, limit: {
        "newest_valid_candle_at": None, "newest_valid_candle_age_seconds": None,
        "gap_count": 3,
    })

    result = main.xau_stream_candle_diagnostics("5m")

    assert result["selection_diagnostic"]["websocket_candle_passes_freshness"] is False
    assert result["websocket"]["gap_count"] == 0
    assert result["rest_history"]["gap_count"] == 3
