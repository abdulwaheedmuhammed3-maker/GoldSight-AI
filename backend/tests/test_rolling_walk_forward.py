from app.walk_forward import run_rolling_walk_forward_folds


def candles(count=600, step=900):
    return [{"time": 1_800_000_000 + i * step, "open": 100, "high": 101,
             "low": 99, "close": 100, "volume": 1} for i in range(count)]


def fake_backtest(**kwargs):
    size = len(kwargs["candles"])
    is_training = size > 100
    return {
        "trades": 10 if is_training else 12,
        "expectancy_net_r_per_trade": 0.4 if is_training else 0.2,
        "profit_factor": 1.4 if is_training else 1.2,
        "net_r_total": 4.0 if is_training else 2.4,
        "max_drawdown_r": 1.0,
    }


def test_rolling_walk_forward_runs_expanding_train_and_sequential_oos_folds():
    data = candles()
    result = run_rolling_walk_forward_folds(
        data, "XAUUSD", "15m", 0.1, train_fraction=0.60,
        folds=3, min_oos_candles=60, backtest_fn=fake_backtest,
    )
    assert len(result["folds"]) == 3
    assert [fold["training_candles"] for fold in result["folds"]] == [360, 440, 520]
    assert [fold["oos_candles"] for fold in result["folds"]] == [80, 80, 80]
    assert result["aggregate"]["out_of_sample_trades"] == 36
    assert result["aggregate"]["pooled_out_of_sample_expectancy_net_r_per_trade"] == 0.2
    assert result["robustness_verdict"] == "CONSISTENT OOS, NOT PROVEN"


def test_rolling_walk_forward_rejects_insufficient_history():
    import pytest
    with pytest.raises(ValueError, match="Insufficient candles"):
        run_rolling_walk_forward_folds(
            candles(250), "XAUUSD", "15m", 0.1, folds=3,
            min_oos_candles=86, backtest_fn=fake_backtest,
        )


def test_rolling_walk_forward_rejects_fold_count_outside_range():
    import pytest
    with pytest.raises(ValueError, match="folds must be between"):
        run_rolling_walk_forward_folds(
            candles(), "XAUUSD", "15m", 0.1, folds=6, backtest_fn=fake_backtest,
        )
