from app.backtest import run_backtest


def _flat_candles(count=50, step=900):
    return [
        {"time": 1_800_000_000 + i * step, "open": 100.0, "high": 101.0,
         "low": 99.0, "close": 100.0, "volume": 100}
        for i in range(count)
    ]


def test_backtest_reports_sample_span_for_valid_history():
    result = run_backtest(_flat_candles(50), "XAUUSD", "4h", 0.1)
    assert result["candles_used"] == 50
    assert result["sample_span_days"] > 0
    assert result["sample_start"] < result["sample_end"]


def test_backtest_requires_minimum_history():
    result = run_backtest(_flat_candles(20), "XAUUSD", "15m", 0.1)
    assert result["trades"] == 0
    assert "At least 45 candles" in result["reason"]


def test_backtest_rejects_unsupported_target_multiple():
    try:
        run_backtest(_flat_candles(), "XAUUSD", "15m", 0.1, target_r=4)
    except ValueError as exc:
        assert "target_r" in str(exc)
    else:
        raise AssertionError("target_r outside 1..3 should be rejected")
