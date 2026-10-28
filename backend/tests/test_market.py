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
