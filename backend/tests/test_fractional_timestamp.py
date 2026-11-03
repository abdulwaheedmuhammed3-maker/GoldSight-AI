from app.market import normalize_candles


def test_normalize_candles_rejects_fractional_numeric_timestamps():
    candles = [
        {"time": 100, "open": 10, "high": 12, "low": 9, "close": 11},
        {"time": 100.75, "open": 10, "high": 12, "low": 9, "close": 11},
    ]

    normalized = normalize_candles(candles)

    assert len(normalized) == 1
    assert normalized[0]["time"] == 100
