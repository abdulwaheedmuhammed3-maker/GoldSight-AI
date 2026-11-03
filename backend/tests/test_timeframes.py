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


def test_45m_aggregation_rejects_boolean_timestamp_and_ohlcv():
    start = (1_800_000_000 // 2700) * 2700
    valid = [
        {"time": start + i * 900, "open": 100, "high": 102, "low": 99, "close": 101, "volume": 1}
        for i in range(3)
    ]
    bad_timestamp = [dict(row) for row in valid]
    bad_timestamp[0]["time"] = True
    bad_ohlc = [dict(row) for row in valid]
    bad_ohlc[1]["high"] = True
    bad_volume = [dict(row) for row in valid]
    bad_volume[2]["volume"] = True

    assert aggregate_15m_to_45m(bad_timestamp) == []
    assert aggregate_15m_to_45m(bad_ohlc) == []
    assert aggregate_15m_to_45m(bad_volume) == []


def test_45m_aggregation_rejects_invalid_ohlc_geometry():
    start = (1_800_000_000 // 2700) * 2700
    candles = [
        {"time": start + i * 900, "open": 100, "high": 99, "low": 98, "close": 101, "volume": 1}
        for i in range(3)
    ]
    assert aggregate_15m_to_45m(candles) == []
