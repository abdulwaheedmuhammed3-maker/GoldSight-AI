from app import main


def test_cost_sensitivity_uses_requested_history_limit(monkeypatch):
    calls = []

    def fake_fetch_timeframe_market(symbol, timeframe, limit=240):
        calls.append(("base", symbol, timeframe, limit))
        return {"candles": [{"time": i} for i in range(limit)], "spread": 0.2}

    def fake_fetch_market(symbol, timeframe, limit=240):
        calls.append(("higher", symbol, timeframe, limit))
        return {"candles": [{"time": i} for i in range(limit)]}

    def fake_run_cost_sensitivity(**kwargs):
        return {"candles_received": len(kwargs["candles"]), "higher_received": len(kwargs["higher_candles"])}

    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch_timeframe_market)
    monkeypatch.setattr(main, "fetch_market", fake_fetch_market)
    monkeypatch.setattr(main, "run_cost_sensitivity", fake_run_cost_sensitivity)

    result = main.backtest_cost_sensitivity("XAUUSD", timeframe="15m", candles_limit=900)

    assert calls == [
        ("base", "XAUUSD", "15m", 900),
        ("higher", "XAUUSD", "1h", 900),
    ]
    assert result == {"candles_received": 900, "higher_received": 900}
