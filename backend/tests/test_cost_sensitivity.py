from app.cost_sensitivity import run_cost_sensitivity


def test_cost_sensitivity_runs_four_scenarios():
    observed = []

    def stub(**kwargs):
        observed.append(kwargs)
        return {"trades": 5, "expectancy_net_r_per_trade": 0.2}

    result = run_cost_sensitivity(
        candles=[], symbol="XAUUSD", timeframe="15m", spread=1.0,
        commission_r=0.1, slippage_price=0.2, backtest_fn=stub,
    )
    assert len(result["scenarios"]) == 4
    assert [item["spread"] for item in observed] == [1.0, 1.5, 2.0, 3.0]
    assert result["cost_resilience_verdict"] == "POSITIVE THROUGH 3X COSTS"
