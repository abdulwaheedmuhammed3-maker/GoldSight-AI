from datetime import datetime, timezone

import app.market as market


def test_four_hour_market_uses_fresh_completed_one_hour_stream_and_rebuilds_bars(monkeypatch):
    now = datetime.now(timezone.utc)
    latest_closed_hour = int(now.timestamp() // 3600) * 3600 - 3600
    first_hour = latest_closed_hour - 199 * 3600
    rows = [
        {
            "t": (first_hour + index * 3600) * 1000,
            "o": 4000 + index,
            "h": 4002 + index,
            "l": 3999 + index,
            "c": 4001 + index,
            "v": 10,
        }
        for index in range(200)
    ]
    freshness_checks = []

    monkeypatch.setattr(
        market, "_siftingio_history_pages",
        lambda params: (rows, {"symbol": "XAUUSD", "interval": "1h", "as_of": now.isoformat()}, 1),
    )
    monkeypatch.setattr(
        market, "_merge_siftingio_stream_candles",
        lambda candles, timeframe: (candles, 0),
    )

    def require_fresh(timeframe, checked_at):
        freshness_checks.append(timeframe)
        return {"time": latest_closed_hour, "age_seconds": 60, "tick_count": 20,
                "source": "SiftingIO WebSocket com ticks"}

    monkeypatch.setattr(market, "_require_fresh_siftingio_stream_candle", require_fresh)
    monkeypatch.setattr(
        market, "_siftingio_stream_quote",
        lambda: {"symbol": "XAUUSD", "status": "LIVE", "price": 4200,
                 "bid": 4199.9, "ask": 4200.1, "spread": 0.2,
                 "updated_at": now.isoformat()},
    )

    result = market._siftingio_market("4h", limit=45)

    assert freshness_checks == ["1h"]
    assert result["timeframe"] == "4h"
    assert len(result["candles"]) >= 40
    assert all(int(candle["time"]) % 14400 == 0 for candle in result["candles"])
    assert result["history_diagnostics"]["latest_websocket_completed_candle"]["source"] == "SiftingIO WebSocket com ticks"
    diagnostics = result["history_diagnostics"]
    assert diagnostics["provider_rows_with_valid_timestamps"] == 200
    assert diagnostics["provider_rows_rejected_ohlc"] == 0
    assert diagnostics["provider_duplicate_timestamp_rows"] == 0
    assert diagnostics["provider_missing_interval_count"] == 0
    assert diagnostics["normalized_history_gap_count"] == 0
    assert diagnostics["merged_history_gap_count"] == 0
