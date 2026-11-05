from app.walk_forward import run_walk_forward_validation


def _candles(count=200, step=900):
    return [
        {"time": 1_800_000_000 + i * step, "open": 100.0, "high": 101.0,
         "low": 99.0, "close": 100.0, "volume": 10}
        for i in range(count)
    ]


def _fake_backtest(**kwargs):
    count = len(kwargs["candles"])
    return {
        "trades": 35 if count >= 86 else 10,
        "expectancy_net_r_per_trade": 0.2 if count >= 86 else 0.3,
        "profit_factor": 1.2,
        "max_drawdown_r": 2.0,
    }


def test_validation_splits_chronologically_and_reports_oos():
    result = run_walk_forward_validation(
        _candles(), "XAUUSD", "15m", 0.1, backtest_fn=_fake_backtest
    )
    assert result["split_time"] == _candles()[140]["time"]
    assert result["comparison"]["in_sample_trades"] == 10
    assert result["comparison"]["out_of_sample_trades"] == 35
    assert result["robustness_verdict"] == "PROMISING, NOT PROVEN"


def test_validation_flags_small_oos_trade_count():
    result = run_walk_forward_validation(
        _candles(), "XAUUSD", "15m", 0.1,
        backtest_fn=lambda **kwargs: {
            "trades": 8, "expectancy_net_r_per_trade": 0.5,
            "profit_factor": 2.0, "max_drawdown_r": 1.0,
        },
    )
    assert result["robustness_verdict"] == "INSUFFICIENT OOS SAMPLE"


def test_validation_rejects_extreme_train_fraction():
    import pytest
    with pytest.raises(ValueError):
        run_walk_forward_validation(
            _candles(), "XAUUSD", "15m", 0.1, train_fraction=0.95
        )
