from app import backtest


def _bars(count, step, start, rising=True):
    rows = []
    for index in range(count):
        close = 100.0 + index * 0.2 if rising else 200.0 - index * 0.2
        rows.append({
            "time": start + index * step,
            "open": close,
            "high": close + 0.5,
            "low": close - 0.5,
            "close": close,
            "volume": 100,
        })
    return rows


def test_additional_four_hour_filter_blocks_countertrend_entries(monkeypatch):
    four_hour = _bars(60, 14_400, 1_700_000_000, rising=False)
    first_entry_time = four_hour[-1]["time"] + 1
    fifteen_minute = _bars(55, 900, first_entry_time, rising=True)

    monkeypatch.setattr(
        backtest,
        "analyze",
        lambda *args, **kwargs: {
            "side": "BUY",
            "signal_time": "test",
            "stop_loss": 90.0,
            "take_profits": [110.0, 120.0, 130.0],
        },
    )

    result = backtest.run_backtest(
        fifteen_minute,
        "XAUUSD",
        "15m",
        0.0,
        higher_candles=_bars(60, 3_600, 1_700_000_000, rising=True),
        trend_filter_candles=four_hour,
        target_r=2,
        max_hold_bars=2,
    )

    assert result["additional_trend_filter"] == "4h EMA 9/21 alignment"
    assert result["trend_filter_data_quality"]["valid_candles"] == 60
    assert result["trades"] == 0
