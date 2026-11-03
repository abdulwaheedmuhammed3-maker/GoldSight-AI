from app import market


def test_btc_can_use_explicit_binance_provider_without_changing_gold(monkeypatch):
    calls = []

    def fake_binance(timeframe, limit=240):
        calls.append(("binance", timeframe, limit))
        candles = [
            {"time": 1_800_000_000, "open": 100, "high": 101, "low": 99, "close": 100},
            {"time": 1_800_000_000 + 900, "open": 100, "high": 102, "low": 99, "close": 101},
        ]
        return {"symbol": "BTCUSD", "provider": "Binance public spot API", "status": "LIVE", "candles": candles}

    def fake_exness(symbol, timeframe, limit=240):
        calls.append(("exness", symbol, timeframe, limit))
        candles = [
            {"time": 1_800_000_000, "open": 2000, "high": 2001, "low": 1999, "close": 2000},
            {"time": 1_800_000_000 + 900, "open": 2000, "high": 2002, "low": 1999, "close": 2001},
        ]
        return {"symbol": symbol, "provider": "Exness Trader API", "status": "LIVE", "candles": candles}

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
