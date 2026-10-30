from app import market


def test_btc_can_use_explicit_binance_provider_without_changing_gold(monkeypatch):
    calls = []

    def fake_binance(timeframe, limit=240):
        calls.append(("binance", timeframe, limit))
        return {"symbol": "BTCUSD", "provider": "Binance public spot API", "status": "LIVE", "candles": []}

    def fake_exness(symbol, timeframe, limit=240):
        calls.append(("exness", symbol, timeframe, limit))
        return {"symbol": symbol, "provider": "Exness Trader API", "status": "LIVE", "candles": []}

    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setenv("BTC_MARKET_DATA_PROVIDER", "binance")
    monkeypatch.setattr(market, "binance_market", fake_binance)
    monkeypatch.setattr("app.exness.exness_market", fake_exness)

    btc = market.fetch_market("BTCUSD", "15m", limit=120)
    gold = market.fetch_market("XAUUSD", "15m", limit=120)

    assert btc["provider"] == "Binance public spot API"
    assert gold["provider"] == "Exness Trader API"
    assert calls == [
        ("binance", "15m", 120),
        ("exness", "XAUUSD", "15m", 120),
    ]


def test_btc_provider_rejects_unknown_explicit_provider(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setenv("BTC_MARKET_DATA_PROVIDER", "unknown-feed")

    try:
        market.fetch_market("BTCUSD", "15m")
    except market.MarketUnavailable as exc:
        assert "BTC_MARKET_DATA_PROVIDER" in str(exc)
    else:
        raise AssertionError("Unknown BTC provider should fail explicitly")
