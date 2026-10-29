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



def test_compare_common_window_reports_shared_dates_and_filters_primary_candles(monkeypatch):
    seen = {}
    def fake_fetch(symbol, timeframe, limit=240):
        starts = {"5m": 1000, "15m": 1100, "45m": 1200, "1h": 1300, "4h": 1400}
        start = starts[timeframe]
        return {"candles": [{"time": t, "open": 1, "high": 2, "low": 1, "close": 2} for t in (start, 2000)], "spread": 0.1}
    def fake_run(candles, symbol, timeframe, spread, higher_candles=None, target_r=2, max_hold_bars=24):
        seen[timeframe] = [c["time"] for c in candles]
        return {"symbol": symbol, "timeframe": timeframe, "trades": 0, "win_rate_pct": None,
                "net_r_total": 0, "average_net_r": None, "profit_factor": None, "max_drawdown_r": 0}
    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch)
    monkeypatch.setattr(main, "fetch_market", fake_fetch)
    monkeypatch.setattr(main, "run_backtest", fake_run)
    result = main.compare_timeframes("XAUUSD", comparison_mode="common_window")
    assert result["common_window"]["start"] is not None
    assert result["common_window"]["end"] is not None
    assert result["comparison_mode"] == "common_window"
    assert seen["4h"] == [1400, 2000]
    assert all(times == [2000] for timeframe, times in seen.items() if timeframe != "4h")


def test_compare_common_window_handles_no_overlap(monkeypatch):
    def fake_fetch(symbol, timeframe, limit=240):
        start = {"5m": 1000, "15m": 3000, "45m": 5000, "1h": 7000, "4h": 9000}[timeframe]
        return {"candles": [{"time": start, "open": 1, "high": 2, "low": 1, "close": 2}], "spread": 0.1}
    def fake_run(candles, symbol, timeframe, spread, higher_candles=None, target_r=2, max_hold_bars=24):
        return {"symbol": symbol, "timeframe": timeframe, "trades": 0, "win_rate_pct": None,
                "net_r_total": 0, "average_net_r": None, "profit_factor": None, "max_drawdown_r": 0}
    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch)
    monkeypatch.setattr(main, "fetch_market", fake_fetch)
    monkeypatch.setattr(main, "run_backtest", fake_run)
    result = main.compare_timeframes("XAUUSD", comparison_mode="common_window")
    assert result["common_window"]["start"] is None
    assert result["winner_status"] == "NO_VALIDATED_WINNER"



def test_six_month_comparison_uses_paginated_history_and_common_window(monkeypatch):
    import os
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    seen = []
    def fake_fetch(symbol, timeframe, limit=240):
        return {"candles": [{"time": 10, "open": 1, "high": 2, "low": 1, "close": 2}], "spread": 0.1}
    def fake_history(symbol, timeframe, start_ts, end_ts, page_size=1000):
        seen.append((timeframe, start_ts, end_ts))
        return [{"time": start_ts, "open": 1, "high": 2, "low": 1, "close": 2},
                {"time": end_ts, "open": 1, "high": 2, "low": 1, "close": 2}]
    def fake_run(candles, symbol, timeframe, spread, higher_candles=None, target_r=2, max_hold_bars=24):
        return {"symbol": symbol, "timeframe": timeframe, "trades": 0, "win_rate_pct": None,
                "net_r_total": 0, "average_net_r": None, "profit_factor": None, "max_drawdown_r": 0}
    monkeypatch.setattr(main, "fetch_market", fake_fetch)
    monkeypatch.setattr(main, "exness_historical_candles", fake_history)
    monkeypatch.setattr(main, "run_backtest", fake_run)
    result = main.compare_timeframes("XAUUSD", comparison_mode="common_window", history_months=6)
    assert result["requested_history_months"] == 6
    assert result["comparison_mode"] == "common_window"
    assert result["common_window"]["span_days"] > 170
    assert len(seen) >= 5
