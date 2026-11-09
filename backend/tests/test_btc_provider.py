from app import market


def test_binance_is_primary_for_btc_candles(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_PROVIDER_BTCUSD", raising=False)
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    candles = [
        {"time": 1_800_000_000, "open": 2000, "high": 2001, "low": 1999, "close": 2000},
        {"time": 1_800_000_900, "open": 2000, "high": 2002, "low": 1999, "close": 2001},
    ]
    monkeypatch.setattr(market, "binance_market", lambda timeframe, limit=240: {
        "symbol": "BTCUSD", "provider": "Binance public spot API",
        "status": "LIVE", "candles": candles,
    })

    btc = market._fetch_market_unchecked("BTCUSD", "15m", limit=120)

    assert btc["provider"] == "Binance public spot API"


def test_live_quote_uses_binance_for_btc_primary(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_PROVIDER_BTCUSD", raising=False)
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setattr(market, "binance_quote", lambda symbol: {
        "symbol": symbol, "provider": "Binance public spot API · book ticker",
        "status": "LIVE", "price": 74500.0, "bid": 74499.0, "ask": 74501.0,
        "spread": 2.0, "updated_at": "2026-11-09T12:00:00+00:00",
    })

    quote = market.fetch_live_quote("BTCUSD")

    assert quote["provider"] == "Binance public spot API · book ticker"
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


def test_btc_binance_primary_does_not_use_exness_or_oanda(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_PROVIDER_BTCUSD", raising=False)
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setattr(market, "binance_quote", lambda symbol: {
        "symbol": "BTCUSD", "provider": "Binance public spot API · book ticker",
        "status": "LIVE", "price": 74500.0, "bid": 74499.0, "ask": 74501.0,
        "spread": 2.0, "updated_at": "2026-11-09T12:00:00+00:00",
    })

    quote = market.fetch_live_quote("BTCUSD")

    assert quote["provider"] == "Binance public spot API · book ticker"
    assert quote["status"] == "LIVE"
    assert "provider_role" not in quote


def test_binance_quote_rejects_non_btc_symbol():
    try:
        market.binance_quote("XAUUSD")
    except market.MarketUnavailable as exc:
        assert "supports BTCUSD only" in str(exc)
    else:
        raise AssertionError("Binance quote adapter must reject non-BTC symbols")



def test_xaus_quote_returns_indicative_reference_quote(monkeypatch):
    monkeypatch.setattr(market, "_http_json", lambda url: {
        "spot_usd_oz": 4321.25,
        "price_as_of": "2026-11-09T12:00:00+00:00",
        "data_state": {"status": "fresh", "age_seconds": 45},
        "updated_at": "2026-11-09T12:00:00+00:00",
    })

    quote = market.xaus_quote("XAUUSD")

    assert quote["provider"] == "XAUS indicative spot API"
    assert quote["quote_type"] == "INDICATIVE_REFERENCE"
    assert quote["provider_role"] == "FALLBACK"
    assert quote["price"] == 4321.25
    assert quote["bid"] == quote["ask"] == 4321.25
    assert quote["spread"] == 0.0


def test_xaus_quote_rejects_stale_reference_data(monkeypatch):
    monkeypatch.setattr(market, "_http_json", lambda url: {
        "spot_usd_oz": 4321.25,
        "price_as_of": "2026-11-09T10:00:00+00:00",
        "data_state": {"status": "stale", "age_seconds": 7200},
        "updated_at": "2026-11-09T10:00:00+00:00",
    })

    with pytest.raises(market.MarketUnavailable, match="stale"):
        market.xaus_quote("XAUUSD")


def test_xaus_is_quote_fallback_only_not_candle_fallback(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "exness")
    monkeypatch.setenv("MARKET_DATA_FALLBACK_PROVIDER", "oanda")

    assert market._fallback_quote_provider("XAUUSD") == "xaus"
    assert market._fallback_provider("XAUUSD") == "oanda"

    with pytest.raises(market.MarketUnavailable, match="OANDA is not configured"):
        market._fetch_market_unchecked("XAUUSD", "15m", limit=120)
