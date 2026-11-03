import pytest

from app.market import MarketUnavailable, completed_candles


@pytest.mark.parametrize("invalid_now", [True, False, "3150", None, float("nan"), float("inf"), float("-inf")])
def test_completed_candles_rejects_invalid_clock_timestamp(invalid_now):
    with pytest.raises(MarketUnavailable, match="finite numeric timestamp"):
        completed_candles([], "15m", now_ts=invalid_now)


def test_completed_candles_uses_current_clock_when_omitted():
    assert completed_candles([], "15m") == []
