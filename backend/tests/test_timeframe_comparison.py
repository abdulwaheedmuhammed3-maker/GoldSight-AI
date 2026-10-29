from app import main


def test_compare_timeframes_does_not_crown_tiny_sample(monkeypatch):
    def fake_fetch(symbol, timeframe, limit=240):
        return {"candles": [{"time": 1, "open": 1, "high": 2, "low": 1, "close": 2}] * 50, "spread": 0.1}
    def fake_run(candles, symbol, timeframe, spread, higher_candles=None, target_r=2, max_hold_bars=24):
        return {
            "symbol": symbol, "timeframe": timeframe, "trades": 6,
            "win_rate_pct": 83.33, "net_r_total": 0.5, "average_net_r": 0.08,
            "profit_factor": 1.2, "max_drawdown_r": 0.5,
        }
    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch)
    monkeypatch.setattr(main, "fetch_market", fake_fetch)
    monkeypatch.setattr(main, "run_backtest", fake_run)
    result = main.compare_timeframes("XAUUSD")
    assert result["winner_status"] == "NO_VALIDATED_WINNER"
    assert result["provisional_best_timeframe"] is None
    assert len(result["results"]) == 5


def test_compare_timeframes_ranks_only_minimum_sample_and_positive_results(monkeypatch):
    def fake_fetch(symbol, timeframe, limit=240):
        return {"candles": [{"time": 1, "open": 1, "high": 2, "low": 1, "close": 2}] * 50, "spread": 0.1}
    def fake_run(candles, symbol, timeframe, spread, higher_candles=None, target_r=2, max_hold_bars=24):
        if timeframe == "45m":
            return {"symbol": symbol, "timeframe": timeframe, "trades": 25, "win_rate_pct": 52, "net_r_total": 3, "average_net_r": 0.12, "profit_factor": 1.3, "max_drawdown_r": 2}
        return {"symbol": symbol, "timeframe": timeframe, "trades": 10, "win_rate_pct": 90, "net_r_total": 1, "average_net_r": 0.1, "profit_factor": 1.5, "max_drawdown_r": 1}
    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch)
    monkeypatch.setattr(main, "fetch_market", fake_fetch)
    monkeypatch.setattr(main, "run_backtest", fake_run)
    result = main.compare_timeframes("XAUUSD")
    assert result["provisional_best_timeframe"] == "45m"
    assert result["winner_status"] == "PROVISIONAL_ONLY"
