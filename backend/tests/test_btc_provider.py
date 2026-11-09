from app import market


def test_exness_remains_primary_for_btc_even_when_legacy_binance_override_exists(monkeypatch):
    calls = []

    def fake_exness(symbol, timeframe, limit=240):
        calls.append((symbol, timeframe, limit))
        candles = [
            {"time": 1_800_000_000, "open": 2000, "high": 2001, "low": 1999, "close": 2000},
            {"time": 1_800_000_900, "open": 2000, "high": 2002, "low": 1999, "close": 2001},
        ]
        return {"symbol": symbol, "provider": "Exness Trader API", "status": "LIVE", "candles": candles}

    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setenv("BTC_MARKET_DATA_PROVIDER", "binance")
    monkeypatch.setenv("MARKET_DATA_FALLBACK_PROVIDER", "oanda")
    monkeypatch.setattr("app.exness.exness_market", fake_exness)

    btc = market._fetch_market_unchecked("BTCUSD", "15m", limit=120)

    assert btc["provider"] == "Exness Trader API"
    assert calls == [("BTCUSD", "15m", 120)]


def test_live_quote_uses_exness_for_btc_primary(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setenv("BTC_MARKET_DATA_PROVIDER", "binance")
    monkeypatch.setattr("app.exness.exness_quote", lambda symbol: {
        "symbol": symbol, "provider": "Exness Trader API", "status": "LIVE",
        "price": 2000.5, "bid": 2000, "ask": 2001, "spread": 1,
        "updated_at": "2026-11-09T05:00:00+00:00",
    })

    quote = market.fetch_live_quote("BTCUSD")

    assert quote["provider"] == "Exness Trader API"
    assert quote["status"] == "LIVE"


def test_oanda_fallback_is_used_only_after_exness_fails(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setenv("MARKET_DATA_FALLBACK_PROVIDER", "oanda")

    def fail_exness(symbol):
        raise market.MarketUnavailable("Exness authentication failed")

    def fake_oanda(symbol):
        return {"symbol": symbol, "provider": "OANDA v20 API", "status": "LIVE",
                "price": 2000.5, "bid": 2000, "ask": 2001, "spread": 1,
                "updated_at": "2026-11-09T05:00:00+00:00"}

    monkeypatch.setattr("app.exness.exness_quote", fail_exness)
    monkeypatch.setattr(market, "_oanda_quote", fake_oanda)

    quote = market.fetch_live_quote("XAUUSD")

    assert quote["provider"] == "OANDA v20 API"
    assert quote["provider_role"] == "FALLBACK"
    assert quote["primary_provider"] == "exness"
    assert "authentication failed" in quote["primary_provider_error"]
