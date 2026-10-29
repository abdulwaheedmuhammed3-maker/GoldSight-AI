from app.market import analyze, no_setup


def test_no_setup_is_explicit_and_has_no_fake_prices():
    result = no_setup("feed offline")
    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert result["stop_loss"] is None
    assert result["take_profits"] == []


def test_insufficient_candles_never_generates_signal():
    candles = [{"time": i, "open": 100, "high": 101, "low": 99, "close": 100} for i in range(10)]
    result = analyze(candles, "XAUUSD", "15m", 0.1)
    assert result["status"] == "NO SETUP"
    assert result["entry"] is None


def test_signal_engine_never_claims_confidence_is_probability():
    candles = [{"time": i*900, "open": 100, "high": 101, "low": 99, "close": 100} for i in range(50)]
    result = analyze(candles, "XAUUSD", "15m", 0.01)
    assert result["status"] == "NO SETUP"


def _candles_with_trend(count, start_time, seconds, rising):
    candles = []
    for i in range(count):
        base = 100 + i * (0.2 if rising else -0.2)
        candles.append({
            "time": start_time + i * seconds,
            "open": base - 0.05,
            "high": base + 0.3,
            "low": base - 0.2,
            "close": base + 0.1,
            "volume": 100,
        })
    return candles


def test_lower_timeframe_requires_higher_timeframe_confirmation():
    entry_candles = _candles_with_trend(60, 1_800_000_000, 900, rising=True)
    result = analyze(entry_candles, "XAUUSD", "15m", 0.1)
    assert result["status"] == "NO SETUP"
    assert "Higher-timeframe confirmation is unavailable" in result["reasons"][0]


def test_higher_timeframe_trend_disagreement_blocks_setup():
    entry_candles = _candles_with_trend(60, 1_800_000_000, 900, rising=True)
    higher_candles = _candles_with_trend(60, 1_800_000_000, 3600, rising=False)
    result = analyze(entry_candles, "XAUUSD", "15m", 0.1, higher_candles)
    assert result["status"] == "NO SETUP"
    assert result["higher_timeframe_trend"] == "BEARISH"
    assert "Timeframes disagree" in result["reasons"][0]


def test_four_hour_analysis_does_not_require_unavailable_higher_timeframe():
    candles = _candles_with_trend(60, 1_800_000_000, 14400, rising=True)
    result = analyze(candles, "XAUUSD", "4h", 0.1)
    assert "Higher-timeframe confirmation is unavailable" not in result["reasons"][0]
