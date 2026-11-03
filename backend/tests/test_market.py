import pytest
from app.market import analyze, no_setup


def test_no_setup_is_explicit_and_has_no_fake_prices():
    result = no_setup("feed offline")
    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert result["stop_loss"] is None
    assert result["take_profits"] == []


def test_insufficient_candles_never_generates_signal():
    candles = [{"time": i, "open": 100, "high": 101, "low": 99, "close": 100} for i in range(10)]
    result = analyze(candles, "XAUUSD", "15m", 0.1)
    assert result["status"] == "NO SETUP"
    assert result["entry"] is None


def test_signal_engine_never_claims_confidence_is_probability():
    candles = [{"time": i*900, "open": 100, "high": 101, "low": 99, "close": 100} for i in range(50)]
    result = analyze(candles, "XAUUSD", "15m", 0.01)
    assert result["status"] == "NO SETUP"


def _candles_with_trend(count, start_time, seconds, rising):
    candles = []
    for i in range(count):
        base = 100 + i * (0.2 if rising else -0.2)
        candles.append({
            "time": start_time + i * seconds,
            "open": base - 0.05,
            "high": base + 0.3,
            "low": base - 0.2,
            "close": base + 0.1,
            "volume": 100,
        })
    return candles


def test_lower_timeframe_requires_higher_timeframe_confirmation():
    entry_candles = _candles_with_trend(60, 1_800_000_000, 900, rising=True)
    result = analyze(entry_candles, "XAUUSD", "15m", 0.1)
    assert result["status"] == "NO SETUP"
    assert "Higher-timeframe confirmation is unavailable" in result["reasons"][0]


def test_higher_timeframe_trend_disagreement_blocks_setup():
    entry_candles = _candles_with_trend(60, 1_800_000_000, 900, rising=True)
    higher_candles = _candles_with_trend(60, 1_800_000_000, 3600, rising=False)
    result = analyze(entry_candles, "XAUUSD", "15m", 0.1, higher_candles)
    assert result["status"] == "NO SETUP"
    assert result["higher_timeframe_trend"] == "BEARISH"
    assert "Timeframes disagree" in result["reasons"][0]


def test_four_hour_analysis_does_not_require_unavailable_higher_timeframe():
    candles = _candles_with_trend(60, 1_800_000_000, 14400, rising=True)
    result = analyze(candles, "XAUUSD", "4h", 0.1)
    assert "Higher-timeframe confirmation is unavailable" not in result["reasons"][0]



def test_normalize_candles_sorts_and_deduplicates_latest_timestamp():
    from app.market import normalize_candles

    def candle(time, close):
        return {"time": time, "open": close - 0.2, "high": close + 0.5,
                "low": close - 0.5, "close": close}

    candles = [candle(1800, 3), candle(900, 1), candle(1800, 4), candle(0, 2)]
    normalized = normalize_candles(candles)
    assert [row["time"] for row in normalized] == [0, 900, 1800]
    assert normalized[-1]["close"] == 4


def test_completed_candles_excludes_forming_and_future_bars():
    from app.market import completed_candles

    candles = [
        {"time": 2700, "open": 3.5, "high": 4.5, "low": 3, "close": 4},
        {"time": 900, "open": 1.5, "high": 2.5, "low": 1, "close": 2},
        {"time": 1800, "open": 2.5, "high": 3.5, "low": 2, "close": 3},
        {"time": 3600, "open": 4.5, "high": 5.5, "low": 4, "close": 5},
    ]
    # At 00:52:30, bars beginning at 00:15 and 00:30 are complete;
    # the 00:45 bar is still forming and the 01:00 bar is in the future.
    result = completed_candles(candles, "15m", now_ts=3150)
    assert [row["time"] for row in result] == [900, 1800]


def test_completed_candles_respects_explicit_unclosed_flag():
    from app.market import completed_candles

    candles = [
        {"time": 0, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "closed": True},
        {"time": 900, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "closed": False},
    ]
    result = completed_candles(candles, "15m", now_ts=2000)
    assert [row["time"] for row in result] == [0]


def _utc_iso_for_test(stamp):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat()


def test_live_analysis_uses_latest_verified_completed_bar():
    from app.market import analyze

    candles = _candles_with_trend(60, 1_800_000_000, 900, rising=True)
    # Explicit live mode consumes the full list supplied by the timestamp gate,
    # rather than dropping its newest already-completed candle a second time.
    result = analyze(candles, "XAUUSD", "4h", 0.1, include_last_completed=True)
    assert result["signal_time"] == _utc_iso_for_test(candles[-1]["time"])



def test_major_fx_symbols_reach_provider_instead_of_being_rejected(monkeypatch):
    from app import main
    from app.market import MarketUnavailable

    def unavailable(symbol, timeframe):
        raise MarketUnavailable("test provider offline")

    monkeypatch.setattr(main, "fetch_timeframe_market", unavailable)
    for symbol in ("EURUSD", "GBPUSD"):
        response = main.market(symbol, "15m")
        assert response.status_code == 503
        assert symbol.encode() in response.body
        assert b"test provider offline" in response.body



def test_mt5_symbol_resolves_common_fx_broker_suffixes(monkeypatch):
    from app.market import _mt5_symbol

    class FakeMT5:
        def __init__(self, available):
            self.available = set(available)
            self.selected = []

        def symbol_info(self, name):
            return type("Info", (), {"visible": name in self.selected})() if name in self.available else None

        def symbol_select(self, name, visible):
            self.selected.append(name)
            return True

    for available, expected in [
        ({"EURUSDm"}, "EURUSDm"),
        ({"GBPUSD.a"}, "GBPUSD.a"),
    ]:
        mt5 = FakeMT5(available)
        assert _mt5_symbol(mt5, expected[:6]) == expected


def test_normalize_candles_drops_invalid_ohlc_geometry_and_non_finite_prices():
    from app.market import normalize_candles

    candles = [
        {"time": 1, "open": 10, "high": 12, "low": 9, "close": 11},
        {"time": 2, "open": 10, "high": 9, "low": 8, "close": 11},
        {"time": 3, "open": 10, "high": float("nan"), "low": 9, "close": 11},
        {"time": 4, "open": 10, "high": 12, "low": 9, "close": -1},
        {"time": 5, "open": 10, "high": 12, "low": 9, "close": 11},
    ]

    normalized = normalize_candles(candles)

    assert [row["time"] for row in normalized] == [1, 5]


def test_normalize_candles_rejects_boolean_timestamp_and_prices():
    from app.market import normalize_candles

    valid = {"time": 100, "open": 10, "high": 12, "low": 9, "close": 11}
    boolean_timestamp = {"time": True, "open": 10, "high": 12, "low": 9, "close": 11}
    boolean_open = {"time": 200, "open": True, "high": 12, "low": 9, "close": 11}
    boolean_close = {"time": 300, "open": 10, "high": 12, "low": 9, "close": False}

    normalized = normalize_candles([valid, boolean_timestamp, boolean_open, boolean_close])

    assert [row["time"] for row in normalized] == [100]


def test_calculate_trend_returns_unknown_when_candle_prices_are_invalid():
    from app.market import calculate_trend

    candles = [{"time": 1_700_000_000 + i * 300, "open": "bad",
                "high": 12, "low": 9, "close": 11} for i in range(50)]

    assert calculate_trend(candles, "5m") == "UNKNOWN"


@pytest.mark.parametrize("bad_quote", [
    {"bidPrice": "NaN", "askPrice": "2001"},
    {"bidPrice": "2000", "askPrice": "Infinity"},
])
def test_binance_market_rejects_non_finite_bid_ask(monkeypatch, bad_quote):
    import pytest
    from app import market

    rows = [[i * 300_000, "2000", "2002", "1998", "2001", "10", (i + 1) * 300_000] for i in range(40)]

    def fake_http_json(url):
        if "klines" in url:
            return rows
        return bad_quote

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="All Binance BTC data hosts failed"):
        market.binance_market("5m", limit=45)


@pytest.mark.parametrize("bad_quote", [
    {"bidPrice": "NaN", "askPrice": "2001"},
    {"bidPrice": "2000", "askPrice": "Infinity"},
])
def test_binance_live_quote_rejects_non_finite_bid_ask(monkeypatch, bad_quote):
    import pytest
    from app import market

    monkeypatch.setenv("BTC_MARKET_DATA_PROVIDER", "binance")
    monkeypatch.setattr(market, "_http_json", lambda url: bad_quote)
    with pytest.raises(market.MarketUnavailable, match="BTC quote feed unavailable"):
        market.fetch_live_quote("BTCUSD")


@pytest.mark.parametrize("bad_price", ["NaN", "Infinity"])
def test_oanda_quote_rejects_non_finite_bid_ask(monkeypatch, bad_price):
    from app import market

    monkeypatch.setenv("OANDA_API_TOKEN", "test-token")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")

    def fake_oanda_json(path, params=None):
        if path.endswith("/instruments"):
            return {"instruments": [{"name": "XAU_USD"}]}
        return {"prices": [{
            "bids": [{"price": bad_price}],
            "asks": [{"price": "2001"}],
            "time": "2026-11-03T12:00:00Z",
        }]}

    monkeypatch.setattr(market, "_oanda_json", fake_oanda_json)
    with pytest.raises(market.MarketUnavailable, match="invalid quote data"):
        market._oanda_quote("XAUUSD")


@pytest.mark.parametrize("bad_component", [
    {"o": "NaN", "h": "2002", "l": "1998", "c": "2001"},
    {"o": "2000", "h": "1999", "l": "1998", "c": "2001"},
    {"o": "2000", "h": "2002", "l": "-1", "c": "2001"},
])
def test_oanda_historical_candle_rejects_invalid_ohlc(bad_component):
    from app.market import _validated_oanda_candle

    row = {"time": "2026-11-03T12:00:00Z", "mid": bad_component, "volume": 12}
    with pytest.raises(ValueError):
        _validated_oanda_candle(row)


def test_oanda_historical_candle_rejects_timezone_naive_timestamp():
    from app.market import _validated_oanda_candle

    row = {
        "time": "2026-11-03T12:00:00",
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": 12,
    }
    with pytest.raises(ValueError, match="timezone"):
        _validated_oanda_candle(row)


def test_binance_market_requires_distinct_valid_historical_candles(monkeypatch):
    from app import market

    stamp_ms = 1_700_000_000_000
    duplicate_rows = [
        [stamp_ms, "2000", "2002", "1998", "2001", "10", stamp_ms + 299_999]
        for _ in range(40)
    ]

    def fake_http_json(url):
        if "klines" in url:
            return duplicate_rows
        return {"bidPrice": "2000", "askPrice": "2001"}

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="40 distinct valid BTCUSDT candles"):
        market.binance_market("5m", limit=45)


@pytest.mark.parametrize("bad_row", [
    [1_700_000_000_000, "NaN", "2002", "1998", "2001", "10", 1_700_000_299_999],
    [1_700_000_000_000, "2000", "1999", "1998", "2001", "10", 1_700_000_299_999],
    [1_700_000_000_000, "2000", "2002", "1998", "2001", "-1", 1_700_000_299_999],
])
def test_binance_market_rejects_invalid_historical_candle_values(monkeypatch, bad_row):
    from app import market

    rows = [bad_row] * 40

    def fake_http_json(url):
        if "klines" in url:
            return rows
        return {"bidPrice": "2000", "askPrice": "2001"}

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="40 distinct valid BTCUSDT candles"):
        market.binance_market("5m", limit=45)


@pytest.mark.parametrize("bad_volume", [float("nan"), float("inf"), -1, True, "NaN"])
def test_normalize_candles_rejects_invalid_volume(bad_volume):
    from app.market import normalize_candles

    candle = {
        "time": 1_700_000_000,
        "open": 2000,
        "high": 2002,
        "low": 1998,
        "close": 2001,
        "volume": bad_volume,
    }

    assert normalize_candles([candle]) == []


def test_normalize_candles_preserves_finite_nonnegative_volume():
    from app.market import normalize_candles

    candle = {
        "time": 1_700_000_000,
        "open": 2000,
        "high": 2002,
        "low": 1998,
        "close": 2001,
        "volume": 12.5,
    }

    normalized = normalize_candles([candle])

    assert len(normalized) == 1
    assert normalized[0]["volume"] == 12.5


@pytest.mark.parametrize("bad_quote", [
    {"bid": "NaN", "ask": "2001"},
    {"bid": "2000", "ask": "Infinity"},
])
def test_oanda_market_rejects_non_finite_bid_ask(monkeypatch, bad_quote):
    from datetime import datetime, timezone
    from app import market

    monkeypatch.setenv("OANDA_API_TOKEN", "test-token")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")
    stamp = datetime.now(timezone.utc).isoformat()
    candle_rows = [{
        "time": stamp,
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": 12,
        "complete": True,
    } for _ in range(40)]

    def fake_oanda_json(path, params=None):
        if path.endswith("/instruments"):
            return {"instruments": [{"name": "XAU_USD"}]}
        if path.endswith("/candles"):
            return {"candles": candle_rows}
        return {"prices": [{
            "bids": [{"price": bad_quote["bid"]}],
            "asks": [{"price": bad_quote["ask"]}],
            "time": stamp,
        }]}

    monkeypatch.setattr(market, "_oanda_json", fake_oanda_json)
    with pytest.raises(market.MarketUnavailable, match="invalid bid/ask"):
        market._oanda_market("XAUUSD", "15m", limit=45)


@pytest.mark.parametrize("bad_tick_time", [float("nan"), float("inf"), float("-inf")])
def test_mt5_market_rejects_non_finite_tick_timestamp(monkeypatch, bad_tick_time):
    from app import market

    class FakeMT5:
        TIMEFRAME_M5 = 5
        TIMEFRAME_M15 = 15
        TIMEFRAME_H1 = 60
        TIMEFRAME_H4 = 240

        def copy_rates_from_pos(self, symbol, timeframe, start, count):
            return [
                {"time": 1_700_000_000 + i * 300, "open": 2000.0, "high": 2002.0,
                 "low": 1998.0, "close": 2001.0, "tick_volume": 10}
                for i in range(40)
            ]

        def symbol_info_tick(self, symbol):
            return type("Tick", (), {"time": bad_tick_time, "bid": 2000.0, "ask": 2001.0})()

        def symbol_info(self, symbol):
            return type("Info", (), {"digits": 2})()

        def shutdown(self):
            pass

    monkeypatch.setattr(market, "_mt5", lambda: FakeMT5())
    monkeypatch.setattr(market, "_mt5_symbol", lambda mt5, symbol: symbol)
    with pytest.raises(market.MarketUnavailable, match="invalid tick timestamp"):
        market._mt5_market_locked("XAUUSD", "5m")


@pytest.mark.parametrize("bad_tick_time", [float("nan"), float("inf"), float("-inf")])
def test_mt5_quote_rejects_non_finite_tick_timestamp(monkeypatch, bad_tick_time):
    from app import market

    class FakeMT5:
        def symbol_info_tick(self, symbol):
            return type("Tick", (), {"time": bad_tick_time, "bid": 2000.0, "ask": 2001.0})()

        def symbol_info(self, symbol):
            return type("Info", (), {"digits": 2})()

        def shutdown(self):
            pass

    monkeypatch.setattr(market, "_mt5", lambda: FakeMT5())
    monkeypatch.setattr(market, "_mt5_symbol", lambda mt5, symbol: symbol)
    with pytest.raises(market.MarketUnavailable, match="stale or invalid"):
        market.mt5_quote("XAUUSD")
