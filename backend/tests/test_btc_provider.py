import pytest
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


def test_siftingio_is_primary_for_xau_quotes(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_PROVIDER_XAUUSD", raising=False)
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "oanda")
    monkeypatch.setattr(market, "_siftingio_json", lambda path, params=None: {
        "s": "XAUUSD", "b": "4321.20", "a": "4321.40", "t": 1794225600000,
    })
    quote = market.fetch_live_quote("XAUUSD")
    assert quote["provider"] == "SiftingIO aggregated commodities reference feed"
    assert quote["status"] == "LIVE"
    assert quote["quote_type"] == "aggregated_reference_quote"
    assert quote["bid"] == 4321.20
    assert quote["ask"] == 4321.40


def test_siftingio_quote_rejects_stale_data(monkeypatch):
    monkeypatch.setattr(market, "_siftingio_json", lambda path, params=None: {
        "s": "XAUUSD", "b": "4321.20", "a": "4321.40", "t": 1000,
    })
    with pytest.raises(market.MarketUnavailable, match="stale"):
        market._siftingio_quote()


def test_siftingio_market_normalizes_historical_bars(monkeypatch):
    now_ms = int(market.datetime.now(market.timezone.utc).timestamp() * 1000)
    base = (now_ms // 900000) * 900000 - 60 * 900000
    rows = []
    for index in range(45):
        price = 4300 + index
        rows.append({"t": base + index * 900000, "o": price, "h": price + 2,
                     "l": price - 2, "c": price + 1, "v": 12})
    def fake(path, params=None):
        if "/hist/" in path:
            assert params["interval"] == "15m"
            return {"data": rows, "meta": {}}
        return {"s": "XAUUSD", "b": "4344.0", "a": "4344.2", "t": now_ms}
    monkeypatch.setattr(market, "_siftingio_json", fake)
    result = market._siftingio_market("15m", limit=120)
    assert len(result["candles"]) == 45
    assert result["candles"][-1]["close"] == 4345
    assert result["provider"].startswith("SiftingIO")


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


def test_xauusd_defaults_to_siftingio_and_has_no_xaus_fallback(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_PROVIDER_XAUUSD", raising=False)
    monkeypatch.delenv("MARKET_DATA_PROVIDER", raising=False)
    monkeypatch.setenv("MARKET_DATA_FALLBACK_PROVIDER", "oanda")
    assert market._primary_provider("XAUUSD") == "siftingio"
    assert market._fallback_quote_provider("XAUUSD") == "oanda"
