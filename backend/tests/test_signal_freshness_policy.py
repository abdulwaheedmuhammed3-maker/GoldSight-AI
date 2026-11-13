import pytest

from app.main import _signal_freshness_grace_seconds, _signal_freshness_window_seconds


@pytest.mark.parametrize(
    ("timeframe", "expected_seconds"),
    [
        ("5m", 600),
        ("15m", 900),
        ("1h", 1500),
        ("4h", 4500),
    ],
)
def test_signal_freshness_grace_windows_are_bounded(timeframe, expected_seconds):
    assert _signal_freshness_grace_seconds(timeframe) == expected_seconds


@pytest.mark.parametrize("timeframe", ["1m", "1d", "unknown", ""])
def test_unsupported_timeframes_have_no_freshness_grace(timeframe):
    assert _signal_freshness_grace_seconds(timeframe) == 0


@pytest.mark.parametrize(
    ("timeframe", "expected_seconds"),
    [
        ("5m", 900),
        ("15m", 1800),
        ("1h", 5100),
        ("4h", 18900),
    ],
)
def test_signal_freshness_window_includes_current_candle_duration(timeframe, expected_seconds):
    # The newest completed candle remains valid while the next candle is forming.
    assert _signal_freshness_window_seconds(timeframe) == expected_seconds


def test_unsupported_timeframes_have_no_freshness_window():
    assert _signal_freshness_window_seconds("unknown") == 0
