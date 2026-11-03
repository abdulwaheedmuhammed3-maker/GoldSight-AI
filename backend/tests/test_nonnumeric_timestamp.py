from app.market import normalize_candles


def test_normalize_candles_rejects_non_numeric_timestamps():
    valid = {"time": 100, "open": 10, "high": 12, "low": 9, "close": 11}
    string_timestamp = {"time": "100", "open": 10, "high": 12, "low": 9, "close": 11}
    null_timestamp = {"time": None, "open": 10, "high": 12, "low": 9, "close": 11}

    normalized = normalize_candles([valid, string_timestamp, null_timestamp])

    assert [row["time"] for row in normalized] == [100]
