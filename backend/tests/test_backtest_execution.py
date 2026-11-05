from app.backtest import run_backtest
import app.backtest as backtest_module


def _candles(count=50, step=14400):
    return [
        {"time": 1_800_000_000 + i * step, "open": 100.0, "high": 100.5,
         "low": 99.5, "close": 100.0, "volume": 100}
        for i in range(count)
    ]


def test_backtest_stop_gap_fills_at_next_bar_open(monkeypatch):
    candles = _candles()
    # First simulated entry is at index 41; next candle gaps below the BUY stop.
    candles[42].update({"open": 98.5, "high": 99.0, "low": 98.0, "close": 98.7})

    def always_buy(*args, **kwargs):
        return {
            "status": "BUY", "side": "BUY", "entry": 100.0,
            "stop_loss": 99.0, "take_profits": [101.0, 102.0, 103.0],
            "signal_time": "2027-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr(backtest_module, "analyze", always_buy)
    result = run_backtest(candles, "XAUUSD", "4h", 0.0, target_r=2, max_hold_bars=2)
    assert result["trades"] > 0
    first = result["trade_details"][0]
    assert first["outcome"] == "STOP_GAP"
    assert first["exit"] == 98.5
    assert first["gross_r"] == -1.5


def test_backtest_same_candle_stop_target_collision_assumes_stop(monkeypatch):
    candles = _candles()
    candles[41].update({"open": 100.0, "high": 103.0, "low": 98.0, "close": 100.0})

    def always_buy(*args, **kwargs):
        return {
            "status": "BUY", "side": "BUY", "entry": 100.0,
            "stop_loss": 99.0, "take_profits": [101.0, 102.0, 103.0],
            "signal_time": "2027-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr(backtest_module, "analyze", always_buy)
    result = run_backtest(candles, "XAUUSD", "4h", 0.0, target_r=2, max_hold_bars=2)
    assert result["trades"] > 0
    assert result["trade_details"][0]["outcome"] == "STOP_AND_TARGET_SAME_BAR_STOP_ASSUMED"
    assert result["trade_details"][0]["gross_r"] == -1.0



def test_backtest_deducts_configured_spread_slippage_and_commission(monkeypatch):
    candles = _candles()
    def always_buy(*args, **kwargs):
        return {
            "status": "BUY", "side": "BUY", "entry": 100.0,
            "stop_loss": 99.0, "take_profits": [101.0, 102.0, 103.0],
            "signal_time": "2027-01-01T00:00:00+00:00",
        }
    monkeypatch.setattr(backtest_module, "analyze", always_buy)
    result = run_backtest(
        candles, "XAUUSD", "4h", spread=0.1, target_r=2, max_hold_bars=2,
        commission_r=0.2, slippage_price=0.05,
    )
    trade = result["trade_details"][0]
    assert trade["gross_r"] == 2.0
    assert trade["estimated_spread_cost_r"] == 0.1
    assert trade["estimated_round_trip_slippage_cost_r"] == 0.1
    assert trade["estimated_commission_cost_r"] == 0.2
    assert trade["net_r"] == 1.6


def test_backtest_rejects_negative_or_nonfinite_execution_costs():
    candles = _candles()
    import pytest
    with pytest.raises(ValueError, match="commission_r"):
        run_backtest(candles, "XAUUSD", "4h", spread=0, commission_r=-0.1)
    with pytest.raises(ValueError, match="slippage_price"):
        run_backtest(candles, "XAUUSD", "4h", spread=0, slippage_price=float("inf"))
    with pytest.raises(ValueError, match="spread"):
        run_backtest(candles, "XAUUSD", "4h", spread=-0.1)
