from app.market import _directional_efficiency, _is_choppy_market


def _bars(closes):
    return [
        {"time": index, "open": price, "high": price + 0.1, "low": price - 0.1, "close": price}
        for index, price in enumerate(closes)
    ]


def test_directional_efficiency_identifies_choppy_close_path():
    bars = _bars([100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100])
    assert _directional_efficiency(bars, lookback=20) < 0.18
    assert _is_choppy_market(bars, lookback=20)


def test_directional_efficiency_allows_clean_directional_progress():
    bars = _bars([100 + index for index in range(21)])
    assert _directional_efficiency(bars, lookback=20) == 1.0
    assert not _is_choppy_market(bars, lookback=20)


def test_directional_efficiency_returns_zero_for_flat_market():
    bars = _bars([100] * 21)
    assert _directional_efficiency(bars, lookback=20) == 0.0
    assert _is_choppy_market(bars, lookback=20)


def test_choppy_filter_rejects_invalid_threshold():
    bars = _bars([100 + index for index in range(21)])
    try:
        _is_choppy_market(bars, threshold=1.1)
    except ValueError as error:
        assert "between 0 and 1" in str(error)
    else:
        raise AssertionError("Expected invalid threshold to raise ValueError")
