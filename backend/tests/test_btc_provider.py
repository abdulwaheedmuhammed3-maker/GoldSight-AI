import pytest
from concurrent.futures import ThreadPoolExecutor
from app import market


@pytest.fixture(autouse=True)
def clear_siftingio_quote_cache():
    market._SIFTINGIO_QUOTE_CACHE.clear()
    yield
    market._SIFTINGIO_QUOTE_CACHE.clear()


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
        "s": "XAUUSD", "b": "4321.20", "a": "4321.40", "t": int(market.datetime.now(market.timezone.utc).timestamp() * 1000),
    })
    quote = market.fetch_live_quote("XAUUSD")
    assert quote["provider"] == "SiftingIO aggregated commodities reference feed"
    assert quote["status"] == "LIVE"
    assert quote["quote_type"] == "aggregated_reference_quote"
    assert quote["bid"] == 4321.20
    assert quote["ask"] == 4321.40


def test_siftingio_quote_cache_deduplicates_and_expires(monkeypatch):
    market.SIFTINGIO_QUOTE_CACHE.clear()
    clock = iter([100.0, 100.0, 104.0, 106.0, 106.0])
    calls = []

    def fake_monotonic():
        return next(clock)

    def fake_json(path, params=None):
        calls.append(path)
        return {
            "s": "XAUUSD", "b": "4321.20", "a": "4321.40",
            "t": int(market.datetime.now(market.timezone.utc).timestamp() * 1000),
        }

    monkeypatch.setattr(market, "_siftingio_cache_clock", fake_monotonic)
    monkeypatch.setattr(market, "_siftingio_json", fake_json)

    first = market._siftingio_quote()
    second = market._siftingio_quote()
    assert first == second
    assert len(calls) == 1

    third = market._siftingio_quote()
    assert third["status"] == "LIVE"
    assert len(calls) == 2
    market.SIFTINGIO_QUOTE_CACHE.clear()


def test_siftingio_quote_rejects_stale_data(monkeypatch):
    monkeypatch.setattr(market, "_siftingio_json", lambda path, params=None: {
        "s": "XAUUSD", "b": "4321.20", "a": "4321.40", "t": 1000,
    })
    with pytest.raises(market.MarketUnavailable, match="stale"):
        market._siftingio_quote()



def test_siftingio_history_diagnostics_report_freshness_and_cursor(monkeypatch):
    now = market.datetime.now(market.timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    base = (now_ms // 900000) * 900000 - 60 * 900000
    rows = []
    for index in range(45):
        price = 4300 + index
        rows.append({"t": base + index * 900000, "o": price, "h": price + 2,
                     "l": price - 2, "c": price + 1, "v": 12})

    def fake(path, params=None):
        if "/hist/" in path:
            return {"data": list(reversed(rows)), "meta": {
                "as_of": "provider-as-of", "next_cursor": "next-page-token",
            }}
        return {"s": "XAUUSD", "b": "4344.0", "a": "4344.2", "t": now_ms}

    monkeypatch.setattr(market, "_siftingio_json", fake)
    result = market._siftingio_market("15m", limit=120)
    diagnostics = result["history_diagnostics"]

    assert diagnostics["provider_as_of"] == "provider-as-of"
    assert diagnostics["provider_next_cursor"] == "next-page-token"
    assert diagnostics["newest_candle_at"] == diagnostics["final_newest_candle_at"]
    assert diagnostics["newest_candle_age_seconds"] >= 0
    assert diagnostics["requested_end_to_newest_candle_seconds"] >= 0
    assert diagnostics["requested_end"] == now.isoformat().replace("+00:00", "Z")


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
            assert params.get("start")
            assert params.get("end")
            assert params.get("order") == "desc"
            return {"data": list(reversed(rows)), "meta": {"as_of": "provider-test-as-of"}}
        return {"s": "XAUUSD", "b": "4344.0", "a": "4344.2", "t": now_ms}
    monkeypatch.setattr(market, "_siftingio_json", fake)
    result = market._siftingio_market("15m", limit=120)
    assert len(result["candles"]) == 45
    assert result["candles"][-1]["close"] == 4345
    assert result["provider"].startswith("SiftingIO")
    diagnostics = result["history_diagnostics"]
    assert diagnostics["requested_interval"] == "15m"
    assert diagnostics["returned_rows"] == 45
    assert diagnostics["valid_unique_candles"] == 45
    assert diagnostics["provider_as_of"] == "provider-test-as-of"
    assert diagnostics["newest_candle_at"] == market._utc_iso(rows[-1]["t"] // 1000)
    assert diagnostics["final_newest_candle_at"] == diagnostics["newest_candle_at"]


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
    assert market._fallback_quote_provider("XAUUSD") == ""
    assert market._fallback_provider("XAUUSD") == ""


def test_parallel_siftingio_timeframes_share_one_quote_request(monkeypatch):
    now_ms = int(market.datetime.now(market.timezone.utc).timestamp() * 1000)
    base = (now_ms // 900000) * 900000 - 60 * 900000
    rows = [
        {"t": base + index * 900000, "o": 4300 + index, "h": 4302 + index,
         "l": 4298 + index, "c": 4301 + index, "v": 12}
        for index in range(45)
    ]
    quote_requests = []
    def fake(path, params=None):
        if "/hist/" in path:
            return {"data": list(reversed(rows)), "meta": {"as_of": "provider-test-as-of"}}
        quote_requests.append(path)
        return {"s": "XAUUSD", "b": "4344.0", "a": "4344.2", "t": now_ms}

    monkeypatch.setattr(market, "_siftingio_json", fake)
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda tf: market._siftingio_market(tf, limit=120),
                                    ("5m", "15m", "1h", "5m")))

    assert len(quote_requests) == 1
    assert all(result["status"] == "LIVE" for result in results)
    assert all(result["spread"] == pytest.approx(0.2) for result in results)


def test_siftingio_market_supports_native_30m_candles(monkeypatch):
    now_ms = int(market.datetime.now(market.timezone.utc).timestamp() * 1000)
    base = (now_ms // 1800000) * 1800000 - 60 * 1800000
    rows = []
    for index in range(45):
        price = 4300 + index
        rows.append({"t": base + index * 1800000, "o": price, "h": price + 2,
                     "l": price - 2, "c": price + 1, "v": 12})

    def fake(path, params=None):
        if "/hist/" in path:
            assert params["interval"] == "30m"
            assert params.get("start")
            assert params.get("end")
            assert params.get("order") == "desc"
            return {"data": list(reversed(rows)), "meta": {"as_of": "provider-test-as-of"}}
        return {"s": "XAUUSD", "b": "4344.0", "a": "4344.2", "t": now_ms}

    monkeypatch.setattr(market, "_siftingio_json", fake)
    result = market._siftingio_market("30m", limit=120)
    assert len(result["candles"]) == 45
    assert result["candles"][-1]["close"] == 4345
    assert result["history_diagnostics"]["requested_interval"] == "30m"
    assert result["history_diagnostics"]["final_newest_candle_at"] == market._utc_iso(rows[-1]["t"] // 1000)
