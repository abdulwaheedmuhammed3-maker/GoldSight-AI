from app.timeframes import aggregate_15m_to_45m


def test_aggregates_three_aligned_15m_candles():
    start = (1_800_000_000 // 2700) * 2700
    candles = [
        {"time": start, "open": 100, "high": 103, "low": 99, "close": 102, "volume": 10},
        {"time": start + 900, "open": 102, "high": 105, "low": 101, "close": 104, "volume": 20},
        {"time": start + 1800, "open": 104, "high": 106, "low": 102, "close": 103, "volume": 30},
    ]
    assert aggregate_15m_to_45m(candles) == [{"time": start, "open": 100, "high": 106, "low": 99, "close": 103, "volume": 60}]


def test_omits_incomplete_45m_bucket():
    start = (1_800_000_000 // 2700) * 2700
    candles = [{"time": start + i * 900, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1} for i in range(2)]
    assert aggregate_15m_to_45m(candles) == []


def test_omits_bucket_with_missing_middle_candle():
    start = (1_800_000_000 // 2700) * 2700
    candles = [
        {"time": start, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1},
        {"time": start + 1800, "open": 100, "high": 102, "low": 99, "close": 101, "volume": 1},
    ]
    assert aggregate_15m_to_45m(candles) == []
