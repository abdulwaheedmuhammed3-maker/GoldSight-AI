from app.regime_analysis import classify_market_regimes, run_regime_analysis


def _bars(count=160, mode="trend"):
    bars=[]
    for i in range(count):
        close=100 + i * 0.5 if mode == "trend" else 100 + (1 if i % 2 else -1) * 0.5
        bars.append({"time": 1_800_000_000 + i * 900, "open": close - 0.1,
                     "high": close + 0.6, "low": close - 0.6, "close": close, "volume": 10})
    return bars


def test_regime_classifier_uses_trailing_data_and_labels_valid_window():
    result = classify_market_regimes(_bars())
    assert result[:19][0]["regime"] is None
    assert result[-1]["regime"] in {"TRENDING", "RANGING", "HIGH_VOLATILITY"}
    assert all("regime" in candle for candle in result)


def test_regime_analysis_returns_all_categories_and_skips_short_runs():
    def stub(**kwargs):
        return {"trades": 4, "net_r_total": 1.2,
                "expectancy_net_r_per_trade": 0.3, "profit_factor": 1.4,
                "max_drawdown_r": 0.8}
    report = run_regime_analysis(_bars(), "XAUUSD", "15m", 0.1, backtest_fn=stub)
    assert set(report["regimes"]) == {"TRENDING", "RANGING", "HIGH_VOLATILITY"}
    assert report["classified_candles"] > 0
    assert report["minimum_segment_candles"] == 45
    assert all("trades" in item for item in report["regimes"].values())
