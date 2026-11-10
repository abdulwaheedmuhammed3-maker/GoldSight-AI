from app.xau_candle_integrity import inspect_candle_rows


def test_aligned_candle_rows_report_ok():
    rows = [
        {"candle_time": 1_800_000_000, "open": 10, "high": 12, "low": 9, "close": 11},
        {"candle_time": 1_800_000_300, "open": 11, "high": 13, "low": 10, "close": 12},
    ]
    result = inspect_candle_rows("5m", rows)
    assert result["misaligned_count"] == 0
    assert result["invalid_ohlc_count"] == 0
    assert result["gap_count"] == 0
    assert result["integrity"] == "OK"


def test_misaligned_timestamp_and_invalid_ohlc_are_reported():
    rows = [
        {"candle_time": 1_800_000_001, "open": 10, "high": 9, "low": 11, "close": 12},
    ]
    result = inspect_candle_rows("5m", rows)
    assert result["misaligned_timestamps"] == [1_800_000_001]
    assert result["invalid_ohlc_count"] == 1
    assert result["integrity"] == "ISSUES_FOUND"


def test_missing_intervals_are_reported_not_fabricated():
    rows = [
        {"candle_time": 1_800_000_000, "open": 10, "high": 12, "low": 9, "close": 11},
        {"candle_time": 1_800_000_900, "open": 11, "high": 13, "low": 10, "close": 12},
    ]
    result = inspect_candle_rows("5m", rows)
    assert result["gap_count"] == 1
    assert result["gaps"][0]["missing_intervals"] == 2
