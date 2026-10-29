from app.backtest import _prepare_candles


def _bar(time, open_=100.0, high=101.0, low=99.0, close=100.5, volume=10):
    return {"time": time, "open": open_, "high": high, "low": low, "close": close, "volume": volume}


def test_prepare_candles_removes_duplicate_timestamp_and_sorts():
    bars, quality = _prepare_candles([
        _bar(1800000900),
        _bar(1800000000),
        _bar(1800000900, close=100.8),
    ], "15m")
    assert [bar["time"] for bar in bars] == [1800000000, 1800000900]
    assert bars[-1]["close"] == 100.8
    assert quality["duplicate_timestamps_removed"] == 1


def test_prepare_candles_removes_invalid_ohlc():
    bars, quality = _prepare_candles([
        _bar(1800000000),
        _bar(1800000900, open_=100, high=98, low=99, close=99.5),
    ], "15m")
    assert len(bars) == 1
    assert quality["invalid_candles_removed"] == 1


def test_prepare_candles_reports_gaps():
    bars, quality = _prepare_candles([
        _bar(1800000000),
        _bar(1800000900),
        _bar(1800003600),
    ], "15m")
    assert len(bars) == 3
    assert quality["time_gaps_over_1_5_bars"] == 1
    assert quality["longest_gap_minutes"] == 45
