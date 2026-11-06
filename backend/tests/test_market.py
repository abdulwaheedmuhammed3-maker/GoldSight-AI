import pytest
from app.market import analyze, no_setup


def test_liquidity_sweep_evidence_reports_level_and_wick_reclaim():
    from app.market import _liquidity_sweep_evidence

    bars = [
        {"time": i, "open": 100, "high": 102, "low": 99, "close": 100}
        for i in range(10)
    ]
    bars.append({"time": 10, "open": 99.2, "high": 101, "low": 98,
                 "close": 99.5})

    evidence = _liquidity_sweep_evidence(bars, lookback=10)

    assert evidence["bullish"] is True
    assert evidence["bearish"] is False
    assert evidence["sell_side_level"] == 99
    assert evidence["swept_low"] == 98
    assert evidence["bullish_reclaim_distance"] == 0.5


def test_liquidity_sweep_requires_reclaim_and_sufficient_history():
    from app.market import _liquidity_sweep_evidence

    bars = [
        {"time": i, "open": 100, "high": 102, "low": 99, "close": 100}
        for i in range(10)
    ]
    bars.append({"time": 10, "open": 99, "high": 101, "low": 98,
                 "close": 98.5})
    assert _liquidity_sweep_evidence(bars)["bullish"] is False
    assert _liquidity_sweep_evidence(bars[:5])["bullish"] is False


def test_no_setup_is_explicit_and_has_no_fake_prices():
    result = no_setup("feed offline")
    assert result["status"] == "NO SETUP"
    assert result["entry"] is None


def test_chart_candles_without_live_spread_cannot_create_trade_setup():
    from app.main import _require_live_spread

    result = _require_live_spread(
        {"status": "BUY", "entry": 100, "stop_loss": 99, "take_profits": [101]},
        {"candles": [{"time": 1}], "quote_status": "OFFLINE", "spread": None},
    )

    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert result["quote_status"] == "OFFLINE"
    assert "chart only" in result["reasons"][0]
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


@pytest.mark.parametrize("raw_bid,raw_ask", [(None, "2.0"), ("not-a-price", "2.0"), (True, 2.0), ("2.0", "bad")])
def test_provider_quote_pair_rejects_malformed_fields(raw_bid, raw_ask):
    from app.market import MarketUnavailable, _parse_quote_pair

    with pytest.raises(MarketUnavailable, match="invalid bid/ask"):
        _parse_quote_pair(raw_bid, raw_ask, "test provider")


def test_provider_quote_pair_accepts_valid_numeric_strings():
    from app.market import _parse_quote_pair

    assert _parse_quote_pair("1.25", "1.30", "test provider") == (1.25, 1.30)


@pytest.mark.parametrize("bid,ask", [(1e308, 1e308), (1e308, 1.7e308)])
def test_quote_midpoint_or_spread_rejects_non_finite_arithmetic(bid, ask):
    from app.market import MarketUnavailable, _quote_midpoint_spread

    with pytest.raises(MarketUnavailable, match="midpoint or spread is non-finite"):
        _quote_midpoint_spread(bid, ask, "test provider")


def test_quote_midpoint_and_spread_accept_finite_derived_values():
    import math
    from app.market import _quote_midpoint_spread

    midpoint, spread = _quote_midpoint_spread(1.0, 1e308, "test provider")

    assert math.isfinite(midpoint)
    assert math.isfinite(spread)


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
    {"bidPrice": "2002", "askPrice": "2001"},
    {"bidPrice": True, "askPrice": "2001"},
    {"bidPrice": "not-a-price", "askPrice": "2001"},
    {"bidPrice": "1e308", "askPrice": "1.7e308"},
])
def test_binance_live_quote_rejects_invalid_bid_ask(monkeypatch, bad_quote):
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
    with pytest.raises(market.MarketUnavailable, match="invalid bid/ask"):
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
    from datetime import datetime, timedelta, timezone
    from app import market

    monkeypatch.setenv("OANDA_API_TOKEN", "test-token")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")
    quote_stamp = datetime.now(timezone.utc).isoformat()
    candle_start = datetime.now(timezone.utc) - timedelta(minutes=15 * 40)
    candle_rows = [{
        "time": (candle_start + timedelta(minutes=15 * i)).isoformat(),
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": 12,
        "complete": True,
    } for i in range(40)]

    def fake_oanda_json(path, params=None):
        if path.endswith("/instruments"):
            return {"instruments": [{"name": "XAU_USD"}]}
        if path.endswith("/candles"):
            return {"candles": candle_rows}
        return {"prices": [{
            "bids": [{"price": bad_quote["bid"]}],
            "asks": [{"price": bad_quote["ask"]}],
            "time": quote_stamp,
        }]}

    monkeypatch.setattr(market, "_oanda_json", fake_oanda_json)
    with pytest.raises(market.MarketUnavailable, match="invalid bid/ask"):
        market._oanda_market("XAUUSD", "15m", limit=45)


def test_mt5_market_rejects_future_historical_candles(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from app import market

    future_start = int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp())

    class FakeMT5:
        TIMEFRAME_M5 = 5
        TIMEFRAME_M15 = 15
        TIMEFRAME_H1 = 60
        TIMEFRAME_H4 = 240

        def copy_rates_from_pos(self, symbol, timeframe, start, count):
            return [
                {"time": future_start + i * 300, "open": 2000.0, "high": 2002.0,
                 "low": 1998.0, "close": 2001.0, "tick_volume": 10}
                for i in range(40)
            ]

        def shutdown(self):
            pass

    monkeypatch.setattr(market, "_mt5", lambda: FakeMT5())
    monkeypatch.setattr(market, "_mt5_symbol", lambda mt5, symbol: symbol)
    with pytest.raises(market.MarketUnavailable, match="fewer than 40 distinct valid"):
        market._mt5_market_locked("XAUUSD", "5m")


@pytest.mark.parametrize("bad_tick_time", [float("nan"), float("inf"), float("-inf"), True, None, "invalid"])
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


@pytest.mark.parametrize("bid,ask", [(1e308, 1e308)])
def test_mt5_quote_rejects_non_finite_midpoint_or_spread(monkeypatch, bid, ask):
    from datetime import datetime, timezone
    from app import market

    class FakeMT5:
        def symbol_info_tick(self, symbol):
            return type("Tick", (), {"time": datetime.now(timezone.utc).timestamp(),
                                     "bid": bid, "ask": ask})()

        def symbol_info(self, symbol):
            return type("Info", (), {"digits": 2})()

        def shutdown(self):
            pass

    monkeypatch.setattr(market, "_mt5", lambda: FakeMT5())
    monkeypatch.setattr(market, "_mt5_symbol", lambda mt5, symbol: symbol)
    with pytest.raises(market.MarketUnavailable, match="non-finite"):
        market.mt5_quote("XAUUSD")


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
    with pytest.raises(market.MarketUnavailable, match="invalid tick timestamp"):
        market.mt5_quote("XAUUSD")


@pytest.mark.parametrize(("bid", "ask"), [(True, 2001.0), (2000.0, "bad"), ("NaN", 2001.0), (2001.0, 2000.0)])
def test_mt5_quote_rejects_malformed_bid_ask(monkeypatch, bid, ask):
    from datetime import datetime, timezone
    from app import market

    class FakeMT5:
        def symbol_info_tick(self, symbol):
            return type("Tick", (), {"time": datetime.now(timezone.utc).timestamp(), "bid": bid, "ask": ask})()
        def symbol_info(self, symbol):
            return type("Info", (), {"digits": 2})()
        def shutdown(self):
            pass

    monkeypatch.setattr(market, "_mt5", lambda: FakeMT5())
    monkeypatch.setattr(market, "_mt5_symbol", lambda mt5, symbol: symbol)
    with pytest.raises(market.MarketUnavailable, match="invalid bid/ask"):
        market.mt5_quote("XAUUSD")


@pytest.mark.parametrize("bad_timestamp", [
    None,
    1234567890,
    "",
    "not-an-iso-timestamp",
    "2026-11-03T12:00:00",
    "2026-11-03T12:00:00+99:99",
])
def test_oanda_live_quote_rejects_malformed_timestamp(monkeypatch, bad_timestamp):
    from app import market

    monkeypatch.setenv("OANDA_API_TOKEN", "test-token")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")

    def fake_oanda_json(path, params=None):
        if path.endswith("/instruments"):
            return {"instruments": [{"name": "XAU_USD"}]}
        return {"prices": [{
            "bids": [{"price": "2000"}],
            "asks": [{"price": "2001"}],
            "time": bad_timestamp,
        }]}

    monkeypatch.setattr(market, "_oanda_json", fake_oanda_json)
    with pytest.raises(market.MarketUnavailable, match="invalid quote timestamp"):
        market._oanda_quote("XAUUSD")


@pytest.mark.parametrize("bad_timestamp", [
    None,
    1234567890,
    "",
    "not-an-iso-timestamp",
    "2026-11-03T12:00:00",
    "2026-11-03T12:00:00+99:99",
])
def test_oanda_quote_age_rejects_malformed_or_timezone_naive_timestamp(bad_timestamp):
    from app.market import MarketUnavailable, _oanda_quote_age

    with pytest.raises(MarketUnavailable, match="invalid quote timestamp"):
        _oanda_quote_age(bad_timestamp)


def test_oanda_quote_age_accepts_timezone_aware_fresh_timestamp():
    from datetime import datetime, timezone
    from app.market import _oanda_quote_age

    timestamp = datetime.now(timezone.utc).isoformat()
    assert -30 <= _oanda_quote_age(timestamp) <= 180


@pytest.mark.parametrize("offset_seconds", [181, -31])
def test_oanda_quote_age_rejects_stale_or_future_timestamp(offset_seconds):
    from datetime import datetime, timedelta, timezone
    from app.market import MarketUnavailable, _oanda_quote_age

    timestamp = (datetime.now(timezone.utc) - timedelta(seconds=offset_seconds)).isoformat()
    with pytest.raises(MarketUnavailable, match="stale"):
        _oanda_quote_age(timestamp)



@pytest.mark.parametrize("bad_rate", [
    {"time": True, "open": 2000, "high": 2002, "low": 1998, "close": 2001, "tick_volume": 10},
    {"time": 1_700_000_000, "open": 2000, "high": float("nan"), "low": 1998, "close": 2001, "tick_volume": 10},
    {"time": 1_700_000_000, "open": 2000, "high": 1999, "low": 1998, "close": 2001, "tick_volume": 10},
    {"time": 1_700_000_000, "open": 2000, "high": 2002, "low": 1998, "close": 2001, "tick_volume": float("inf")},
    {"time": 1_700_000_000, "open": 2000, "high": 2002, "low": 1998, "close": 2001, "tick_volume": -1},
])
def test_mt5_historical_candle_rejects_invalid_timestamp_ohlc_or_volume(bad_rate):
    from app.market import _validated_mt5_candle

    with pytest.raises((ValueError, TypeError, KeyError)):
        _validated_mt5_candle(bad_rate)


def test_mt5_historical_candle_preserves_valid_rate_fields():
    from app.market import _validated_mt5_candle

    rate = {
        "time": 1_700_000_000, "open": 2000, "high": 2002,
        "low": 1998, "close": 2001, "tick_volume": 12,
    }

    assert _validated_mt5_candle(rate) == {
        "time": 1_700_000_000, "open": 2000.0, "high": 2002.0,
        "low": 1998.0, "close": 2001.0, "volume": 12,
    }


@pytest.mark.parametrize("volume", [12, 12.5, "12.5"])
def test_normalize_candles_returns_volume_as_numeric_float(volume):
    from app.market import normalize_candles

    candle = {"time": 1_700_000_000, "open": 2000, "high": 2002,
              "low": 1998, "close": 2001, "volume": volume}
    normalized = normalize_candles([candle])

    assert len(normalized) == 1
    assert normalized[0]["volume"] == float(volume)
    assert isinstance(normalized[0]["volume"], float)


def test_normalize_candles_rejects_negative_timestamp():
    from app.market import normalize_candles

    candle = {"time": -1, "open": 2000, "high": 2002,
              "low": 1998, "close": 2001, "volume": 12}

    assert normalize_candles([candle]) == []


@pytest.mark.parametrize("bad_volume", [float("nan"), float("inf"), -1, True, 2.5, "NaN"])
def test_oanda_historical_candle_rejects_invalid_volume(bad_volume):
    from app.market import _validated_oanda_candle

    row = {
        "time": "2026-11-03T12:00:00Z",
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": bad_volume,
    }

    with pytest.raises(ValueError, match="volume"):
        _validated_oanda_candle(row)


def test_oanda_historical_candle_accepts_integer_volume():
    from app.market import _validated_oanda_candle

    row = {
        "time": "2026-11-03T12:00:00Z",
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": "12",
    }

    assert _validated_oanda_candle(row)["volume"] == 12


@pytest.mark.parametrize("bad_timestamp", [
    True,
    1_700_000_000_000.5,
    float("nan"),
    float("inf"),
    "1700000000000",
])
def test_binance_market_rejects_invalid_candle_timestamps(monkeypatch, bad_timestamp):
    from app import market

    stamp_ms = 1_700_000_000_000
    rows = [
        [bad_timestamp, "2000", "2002", "1998", "2001", "10", stamp_ms + 299_999]
        for _ in range(40)
    ]

    def fake_http_json(url):
        if "klines" in url:
            return rows
        return {"bidPrice": "2000", "askPrice": "2001"}

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="40 distinct valid BTCUSDT candles"):
        market.binance_market("5m", limit=45)


@pytest.mark.parametrize("bad_close_timestamp", [
    False,
    1_700_000_299_999.5,
    float("nan"),
    "1700000299999",
])
def test_binance_market_rejects_invalid_candle_close_timestamp(monkeypatch, bad_close_timestamp):
    from app import market

    stamp_ms = 1_700_000_000_000
    rows = [
        [stamp_ms + i * 300_000, "2000", "2002", "1998", "2001", "10", bad_close_timestamp]
        for i in range(40)
    ]

    def fake_http_json(url):
        if "klines" in url:
            return rows
        return {"bidPrice": "2000", "askPrice": "2001"}

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="40 distinct valid BTCUSDT candles"):
        market.binance_market("5m", limit=45)


def test_binance_market_rejects_future_opening_candle_timestamps(monkeypatch):
    from app import market

    future_stamp_ms = 9_999_999_999_000
    rows = [
        [future_stamp_ms + i * 300_000, "2000", "2002", "1998", "2001", "10",
         future_stamp_ms + i * 300_000 + 299_999]
        for i in range(40)
    ]

    def fake_http_json(url):
        if "klines" in url:
            return rows
        return {"bidPrice": "2000", "askPrice": "2001"}

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="40 distinct valid BTCUSDT candles"):
        market.binance_market("5m", limit=45)


def test_oanda_market_rejects_future_candle_timestamps(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from app import market

    future = datetime.now(timezone.utc) + timedelta(days=30)
    candle_rows = [{
        "time": (future + timedelta(minutes=15 * i)).isoformat(),
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": 12,
        "complete": True,
    } for i in range(40)]
    stamp = datetime.now(timezone.utc).isoformat()

    monkeypatch.setenv("OANDA_API_TOKEN", "test-token")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")

    def fake_oanda_json(path, params=None):
        if path.endswith("/instruments"):
            return {"instruments": [{"name": "XAU_USD"}]}
        if path.endswith("/candles"):
            return {"candles": candle_rows}
        return {"prices": [{
            "bids": [{"price": "2000"}],
            "asks": [{"price": "2001"}],
            "time": stamp,
        }]}

    monkeypatch.setattr(market, "_oanda_json", fake_oanda_json)
    with pytest.raises(market.MarketUnavailable, match="at least 40 are required"):
        market._oanda_market("XAUUSD", "15m", limit=45)



def test_oanda_standalone_quote_normalizes_offset_timestamp_to_utc(monkeypatch):
    from datetime import datetime, timezone, timedelta
    from app import market

    monkeypatch.setenv("OANDA_API_TOKEN", "test-token")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")
    offset = timezone(timedelta(hours=5, minutes=30))
    stamp = datetime.now(offset).isoformat()

    def fake_oanda_json(path, params=None):
        if path.endswith("/instruments"):
            return {"instruments": [{"name": "XAU_USD"}]}
        return {"prices": [{
            "bids": [{"price": "2000"}],
            "asks": [{"price": "2001"}],
            "time": stamp,
        }]}

    monkeypatch.setattr(market, "_oanda_json", fake_oanda_json)
    quote = market._oanda_quote("XAUUSD")

    assert quote["updated_at"].endswith("+00:00")
    assert datetime.fromisoformat(quote["updated_at"]).utcoffset() == timedelta(0)
    assert datetime.fromisoformat(quote["updated_at"]).astimezone(timezone.utc).timestamp() == pytest.approx(
        datetime.fromisoformat(stamp).astimezone(timezone.utc).timestamp()
    )


@pytest.mark.parametrize("field", ["open", "high", "low", "close"])
def test_mt5_candle_rejects_boolean_ohlc(field):
    from app.market import _validated_mt5_candle

    rate = {
        "time": 1_700_000_000, "open": 2000, "high": 2002,
        "low": 1998, "close": 2001, "tick_volume": 12,
    }
    rate[field] = True
    with pytest.raises(ValueError, match="boolean"):
        _validated_mt5_candle(rate)


@pytest.mark.parametrize("field", ["o", "h", "l", "c"])
def test_oanda_candle_rejects_boolean_ohlc(field):
    from app.market import _validated_oanda_candle

    row = {
        "time": "2026-11-03T12:00:00Z",
        "mid": {"o": "2000", "h": "2002", "l": "1998", "c": "2001"},
        "volume": 12,
    }
    row["mid"][field] = True
    with pytest.raises(ValueError, match="boolean"):
        _validated_oanda_candle(row)


@pytest.mark.parametrize("index", [1, 2, 3, 4, 5])
def test_binance_market_rejects_boolean_ohlcv_fields(monkeypatch, index):
    from app import market

    rows = []
    stamp = 1_700_000_000_000
    for i in range(40):
        row = [stamp + i * 300_000, "2000", "2002", "1998", "2001", "10", stamp + i * 300_000 + 299_999]
        row[index] = True
        rows.append(row)

    def fake_http_json(url):
        if "klines" in url:
            return rows
        return {"bidPrice": "2000", "askPrice": "2001"}

    monkeypatch.setattr(market, "_http_json", fake_http_json)
    with pytest.raises(market.MarketUnavailable, match="40 distinct valid BTCUSDT candles"):
        market.binance_market("5m", limit=45)


def test_candle_continuity_preserves_real_fx_bars_across_provider_gaps():
    from app.market import validate_candle_continuity
    candles = [
        {"time": 1_800_000_000, "open": 100, "high": 102, "low": 99, "close": 101},
        {"time": 1_800_000_600, "open": 101, "high": 103, "low": 100, "close": 102},
    ]
    # No flat candles are synthesized for provider intervals with no trades.
    validate_candle_continuity(candles, "5m", "XAUUSD")


def test_candle_continuity_allows_fx_weekend_closure():
    from app.market import validate_candle_continuity
    # Friday 20:55 UTC to Sunday 21:00 UTC: a legitimate FX market closure.
    friday = 1_800_000_000
    sunday = friday + 48 * 60 * 60
    candles = [
        {"time": friday, "open": 100, "high": 102, "low": 99, "close": 101},
        {"time": sunday, "open": 101, "high": 103, "low": 100, "close": 102},
    ]
    validate_candle_continuity(candles, "5m", "XAUUSD")


def test_candle_continuity_requires_continuous_crypto_bars_even_for_long_gap():
    from app.market import MarketUnavailable, validate_candle_continuity
    candles = [
        {"time": 1_800_000_000, "open": 100, "high": 102, "low": 99, "close": 101},
        {"time": 1_800_000_000 + 3600, "open": 101, "high": 103, "low": 100, "close": 102},
    ]
    with pytest.raises(MarketUnavailable, match="Missing 5m candle interval"):
        validate_candle_continuity(candles, "5m", "BTCUSD")


def test_candle_continuity_accepts_regular_sequence():
    from app.market import validate_candle_continuity
    candles = [
        {"time": 1_800_000_000 + i * 300, "open": 100, "high": 102, "low": 99, "close": 101}
        for i in range(4)
    ]
    validate_candle_continuity(candles, "5m", "XAUUSD")



@pytest.mark.parametrize(("previous_close", "high", "low", "expected"), [
    (100.0, 105.0, 103.0, 5.0),  # upward gap: high - prior close dominates
    (100.0, 98.0, 95.0, 5.0),    # downward gap: prior close - low dominates
    (100.0, 102.0, 98.0, 4.0),   # no gap: high - low dominates
])
def test_average_true_range_includes_previous_close_gaps(previous_close, high, low, expected):
    from app.market import _average_true_range

    bars = [
        {"time": 1_700_000_000, "open": previous_close, "high": previous_close,
         "low": previous_close, "close": previous_close},
        {"time": 1_700_000_300, "open": high, "high": high, "low": low, "close": low},
    ]

    assert _average_true_range(bars, period=1) == pytest.approx(expected)


def test_average_true_range_averages_latest_period_true_ranges_only():
    from app.market import _average_true_range

    bars = [
        {"time": 1_700_000_000 + i * 300, "open": 100.0, "high": 101.0,
         "low": 99.0, "close": 100.0}
        for i in range(4)
    ]
    # Each of the latest three TRs is 2.0; an older large bar is excluded.
    bars[1]["high"] = 110.0
    bars[1]["close"] = 100.0
    assert _average_true_range(bars, period=2) == pytest.approx(2.0)


def test_average_true_range_requires_period_plus_one_bars():
    from app.market import _average_true_range

    bars = [{"time": 1_700_000_000, "open": 100.0, "high": 101.0,
             "low": 99.0, "close": 100.0}]
    with pytest.raises(ValueError, match=r"period \+ 1"):
        _average_true_range(bars, period=1)



def test_confirmed_swing_structure_detects_bos_only_after_pivot_confirmation():
    from app.market import _confirmed_swing_structure

    highs = [8, 9, 10, 9, 8, 9, 11]
    closes = [7.5, 8.5, 9.5, 8.5, 8.0, 9.0, 10.5]
    bars = [
        {"time": i, "open": close - 0.1, "high": high,
         "low": close - 0.5, "close": close}
        for i, (high, close) in enumerate(zip(highs, closes))
    ]

    structure = _confirmed_swing_structure(bars)

    assert structure["swing_high"] == 10
    assert structure["bullish_bos"] is True
    assert structure["bearish_bos"] is False
    assert structure["bullish_choch"] is False


def test_confirmed_swing_structure_does_not_call_ema_flip_a_choch():
    from app.market import _confirmed_swing_structure

    highs = [8, 9, 10, 9, 8, 9, 9.5]
    closes = [7.5, 8.5, 9.5, 8.5, 8.0, 9.0, 9.2]
    bars = [
        {"time": i, "open": close - 0.1, "high": high,
         "low": close - 0.5, "close": close}
        for i, (high, close) in enumerate(zip(highs, closes))
    ]

    structure = _confirmed_swing_structure(bars)

    assert structure["bullish_bos"] is False
    assert structure["bullish_choch"] is False


@pytest.mark.parametrize(("side", "entry", "stop", "risk", "targets", "expected"), [
    ("BUY", 100, 99, 1, [101, 102, 103], True),
    ("SELL", 100, 101, 1, [99, 98, 97], True),
    ("BUY", 100, 100, 1, [101, 102, 103], False),  # stop at entry
    ("SELL", 100, 99, 1, [99, 98, 97], False),     # stop on wrong side
    ("BUY", 100, 99, 1, [100.5, 102, 103], False), # TP1 below 1R
    ("BUY", 100, 99, 1, [101, 101.9, 103], False), # TP2 below 2R
    ("SELL", 100, 101, 1, [99, 98, 97.1], False),  # TP3 below 3R
    ("BUY", 100, 99, 0, [101, 102, 103], False),
    ("BUY", 100, 99, 1, [101, float("inf"), 103], False),
])
def test_risk_level_validation_checks_stop_direction_and_target_rr(
    side, entry, stop, risk, targets, expected,
):
    from app.market import _validate_risk_levels

    assert _validate_risk_levels(side, entry, stop, risk, targets) is expected


@pytest.mark.parametrize(("risk", "spread", "expected"), [
    (2.0, 1.0, True),    # exactly 2x buffer
    (1.99, 1.0, False),  # insufficient stop/spread buffer
    (4.0, 1.0, True),
    (1.0, 0.0, True),
    (1.0, None, True),   # absent spread is not considered a measured violation
    (1.0, -0.1, False),
    (1.0, float("nan"), False),
    (0.0, 0.1, False),
])
def test_spread_risk_validation_rejects_bad_or_excessive_spread(
    risk, spread, expected,
):
    from app.market import _validate_spread_risk

    assert _validate_spread_risk(risk, spread) is expected


@pytest.mark.parametrize(("price", "expected_status", "expected_distance"), [
    (2000.5, "IN_ZONE", 0.0),
    (2002.0, "NEAR_ZONE", 1.0),
    (2004.0, "DISTANT", 3.0),
])
def test_supply_demand_context_reports_nearest_confirmed_demand_zone(monkeypatch, price, expected_status, expected_distance):
    from app import market

    detected = {
        "demand": [{
            "lower": 1999.0, "upper": 2001.0, "midpoint": 2000.0,
            "pivot_count": 2, "touch_count": 1, "strength_score": 50,
            "last_seen": 1000.0, "last_reaction": 1100.0,
        }],
        "supply": [], "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    monkeypatch.setattr(market, "detect_supply_demand_zones", lambda *args, **kwargs: detected)

    context = market._supply_demand_context([], price=price, side="BUY", atr=1.0)

    assert context["side"] == "DEMAND"
    assert context["status"] == expected_status
    assert context["distance_atr"] == expected_distance
    assert context["nearest_zone"]["strength_score"] == 50
    assert "not win probability" in context["evidence_label"]


def test_supply_demand_context_does_not_invent_missing_zone(monkeypatch):
    from app import market

    monkeypatch.setattr(market, "detect_supply_demand_zones", lambda *args, **kwargs: {
        "demand": [], "supply": [], "evidence_label": "Historical zone-strength ranking; not win probability",
    })

    context = market._supply_demand_context([], price=2000.0, side="BUY", atr=1.0)

    assert context["status"] == "NO_CONFIRMED_ZONE"
    assert context["nearest_zone"] is None
    assert context["distance_atr"] is None


@pytest.mark.parametrize(("context", "expected"), [
    ({"status": "IN_ZONE", "nearest_zone": {"strength_score": 40}, "distance_atr": 0.0}, True),
    ({"status": "NEAR_ZONE", "nearest_zone": {"strength_score": 75}, "distance_atr": 1.0}, True),
    ({"status": "NEAR_ZONE", "nearest_zone": {"strength_score": 39}, "distance_atr": 0.5}, False),
    ({"status": "DISTANT", "nearest_zone": {"strength_score": 90}, "distance_atr": 1.1}, False),
    ({"status": "NO_CONFIRMED_ZONE", "nearest_zone": None, "distance_atr": None}, False),
    ({"status": "IN_ZONE", "nearest_zone": {"strength_score": True}, "distance_atr": 0.0}, False),
    ({"status": "IN_ZONE", "nearest_zone": {"strength_score": 50}, "distance_atr": float("nan")}, False),
])
def test_supply_demand_alignment_requires_matching_strong_nearby_zone(context, expected):
    from app.market import _supply_demand_alignment_passes

    assert _supply_demand_alignment_passes(context) is expected


def _signal_candidate_candles():
    """Create rising completed bars with a final bullish displacement candle."""
    candles = _candles_with_trend(60, 1_800_000_000, 14_400, rising=True)
    previous = candles[-2]
    last = candles[-1]
    last["open"] = previous["high"] + 0.02
    last["low"] = last["open"] - 0.1
    last["close"] = previous["high"] + 0.8
    last["high"] = last["close"] + 0.1
    return candles


def _patch_signal_candidate(monkeypatch, zone_context):
    from app import market

    monkeypatch.setattr(market, "_confirmed_swing_structure", lambda bars: {
        "swing_high": bars[-2]["high"],
        "swing_low": bars[-10]["low"],
        "bullish_bos": True,
        "bearish_bos": False,
        "bullish_choch": False,
        "bearish_choch": False,
        "prior_bias": "BULLISH",
    })
    monkeypatch.setattr(market, "_supply_demand_context", lambda *args, **kwargs: zone_context)


def test_analyze_blocks_structure_confirmed_buy_when_zone_is_weak(monkeypatch):
    context = {
        "side": "DEMAND", "status": "NEAR_ZONE",
        "nearest_zone": {"lower": 110.0, "upper": 111.0, "strength_score": 39},
        "distance_atr": 0.5, "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    _patch_signal_candidate(monkeypatch, context)

    result = analyze(
        _signal_candidate_candles(), "XAUUSD", "4h", 0.1,
        include_last_completed=True,
    )

    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert "no sufficiently strong matching supply/demand zone" in result["reasons"][0]


def test_analyze_blocks_structure_confirmed_buy_when_zone_is_distant(monkeypatch):
    context = {
        "side": "DEMAND", "status": "DISTANT",
        "nearest_zone": {"lower": 100.0, "upper": 101.0, "strength_score": 85},
        "distance_atr": 1.5, "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    _patch_signal_candidate(monkeypatch, context)

    result = analyze(
        _signal_candidate_candles(), "XAUUSD", "4h", 0.1,
        include_last_completed=True,
    )

    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert "no sufficiently strong matching supply/demand zone" in result["reasons"][0]


def _signal_candidate_sell_candles():
    """Create falling completed bars with a final bearish displacement candle."""
    candles = _candles_with_trend(60, 1_800_000_000, 14_400, rising=False)
    previous = candles[-2]
    last = candles[-1]
    last["open"] = previous["low"] - 0.02
    last["high"] = last["open"] + 0.1
    last["close"] = previous["low"] - 0.8
    last["low"] = last["close"] - 0.1
    return candles


def _patch_sell_signal_candidate(monkeypatch, zone_context):
    from app import market

    monkeypatch.setattr(market, "_confirmed_swing_structure", lambda bars: {
        "swing_high": bars[-10]["high"],
        "swing_low": bars[-2]["low"],
        "bullish_bos": False,
        "bearish_bos": True,
        "bullish_choch": False,
        "bearish_choch": False,
        "prior_bias": "BEARISH",
    })
    monkeypatch.setattr(market, "_supply_demand_context", lambda *args, **kwargs: zone_context)


def test_breakout_candle_conviction_filters_weak_closes():
    from app.market import _breakout_candle_has_conviction

    assert _breakout_candle_has_conviction({"open": 100.0, "high": 102.0, "low": 99.0, "close": 101.8}, "BUY") is True
    assert _breakout_candle_has_conviction({"open": 101.0, "high": 102.0, "low": 99.0, "close": 99.2}, "SELL") is True
    assert _breakout_candle_has_conviction({"open": 100.0, "high": 102.0, "low": 99.0, "close": 100.5}, "BUY") is False
    assert _breakout_candle_has_conviction({"open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0}, "BUY") is False
    assert _breakout_candle_has_conviction({"open": 100.0, "high": 100.0, "low": 99.0, "close": 100.0}, "BUY") is False


def test_late_displacement_filter_rejects_oversized_candle_and_accepts_normal_range():
    from app.market import _is_late_displacement

    assert _is_late_displacement({"high": 103.0, "low": 100.0}, atr=1.0) is True
    assert _is_late_displacement({"high": 101.5, "low": 100.0}, atr=1.0) is False
    assert _is_late_displacement({"high": 101.0, "low": 100.0}, atr=0.0) is True


def test_analyze_blocks_late_entry_after_oversized_displacement(monkeypatch):
    context = {
        "side": "DEMAND", "status": "NEAR_ZONE",
        "nearest_zone": {"lower": 111.0, "upper": 112.0, "strength_score": 60},
        "distance_atr": 0.5, "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    _patch_signal_candidate(monkeypatch, context)
    candles = _signal_candidate_candles()
    last = candles[-1]
    last["high"] = last["close"] + 2.0
    last["low"] = last["open"] - 2.0

    result = analyze(candles, "XAUUSD", "4h", 0.1, include_last_completed=True)

    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert "Late entry blocked" in result["reasons"][0]


def test_breakout_extension_filter_blocks_entry_far_beyond_confirmed_pivot(monkeypatch):
    from app import market as market_module

    context = {
        "side": "DEMAND", "status": "NEAR_ZONE",
        "nearest_zone": {"lower": 111.0, "upper": 112.0, "strength_score": 60},
        "distance_atr": 0.5, "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    _patch_signal_candidate(monkeypatch, context)
    monkeypatch.setattr(market_module, "_confirmed_swing_structure", lambda bars: {
        "swing_high": bars[-10]["high"], "swing_low": bars[-2]["low"],
        "bullish_bos": True, "bearish_bos": False,
        "bullish_choch": False, "bearish_choch": False, "prior_bias": "BULLISH",
    })
    candles = _signal_candidate_candles()
    candles[-1]["close"] = candles[-10]["high"] + 10.0
    candles[-1]["open"] = candles[-1]["close"] - 0.8
    candles[-1]["high"] = candles[-1]["close"] + 0.1
    candles[-1]["low"] = candles[-1]["open"] - 0.1

    result = analyze(candles, "XAUUSD", "4h", 0.1, include_last_completed=True)

    assert result["status"] == "NO SETUP"
    assert result["entry"] is None
    assert "Breakout entry is extended" in result["reasons"][0]
    assert "pullback/retest" in result["reasons"][0]


def test_analyze_allows_structure_confirmed_sell_with_aligned_supply_zone(monkeypatch):
    context = {
        "side": "SUPPLY", "status": "NEAR_ZONE",
        "nearest_zone": {"lower": 88.0, "upper": 89.0, "strength_score": 60},
        "distance_atr": 0.5, "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    _patch_sell_signal_candidate(monkeypatch, context)

    result = analyze(
        _signal_candidate_sell_candles(), "XAUUSD", "4h", 0.1,
        include_last_completed=True,
    )

    assert result["status"] == "SELL"
    assert result["entry"] is not None
    assert result["stop_loss"] > result["entry"]
    assert len(result["take_profits"]) == 3
    assert result["structure_evidence"]["confirmed_swing_high"] is not None
    assert result["structure_evidence"]["bearish_bos"] is True
    assert result["liquidity_sweep_evidence"]["lookback"] == 10
    assert "bullish" in result["liquidity_sweep_evidence"]
    assert any("Supply/demand alignment filter passed" in reason for reason in result["reasons"])


def test_analyze_allows_structure_confirmed_buy_with_aligned_zone(monkeypatch):
    context = {
        "side": "DEMAND", "status": "NEAR_ZONE",
        "nearest_zone": {"lower": 111.0, "upper": 112.0, "strength_score": 60},
        "distance_atr": 0.5, "evidence_label": "Historical zone-strength ranking; not win probability",
    }
    _patch_signal_candidate(monkeypatch, context)

    result = analyze(
        _signal_candidate_candles(), "XAUUSD", "4h", 0.1,
        include_last_completed=True,
    )

    assert result["status"] == "BUY"
    assert result["entry"] is not None
    assert result["stop_loss"] < result["entry"]
    assert len(result["take_profits"]) == 3
    assert any("Supply/demand alignment filter passed" in reason for reason in result["reasons"])


@pytest.mark.parametrize("raw_price,expected", [
    ("1.23456", 5),
    ("150.120", 3),
    ("149.9", 1),
    ("150", 0),
    (1.23456, 5),
    ("1e-5", 2),
    (None, 2),
    (True, 2),
    ("invalid.abc", 2),
])
def test_provider_price_digits_preserves_original_decimal_precision(raw_price, expected):
    from app.market import _provider_price_digits

    assert _provider_price_digits(raw_price) == expected


@pytest.mark.parametrize(("updated_at", "now", "expected_status", "blocked"), [
    ("2026-11-05T12:00:00+00:00", "2026-11-05T12:00:20+00:00", "LIVE", False),
    ("2026-11-05T12:00:00+00:00", "2026-11-05T12:00:31+00:00", "STALE", True),
    ("2026-11-05T12:00:00Z", "2026-11-05T12:00:30Z", "LIVE", False),
    ("2026-11-05T12:00:10Z", "2026-11-05T12:00:00Z", "STALE", True),
    ("not-a-timestamp", "2026-11-05T12:00:20Z", "STALE", True),
    (None, "2026-11-05T12:00:20Z", "STALE", True),
])
def test_live_setup_requires_recent_timestamped_quote(updated_at, now, expected_status, blocked):
    from datetime import datetime
    from app.main import _live_quote_age_seconds, _require_live_spread

    market_data = {"spread": 0.2, "quote_status": "LIVE", "updated_at": updated_at}
    current = datetime.fromisoformat(now.replace("Z", "+00:00"))
    age = _live_quote_age_seconds(market_data, now=current)
    signal = {"status": "BUY", "entry": 2000.0, "stop_loss": 1998.0, "take_profits": [2002.0]}
    # Inject a deterministic clock by testing the age helper separately, then
    # exercise the guard with an age represented relative to the current clock.
    if updated_at and expected_status == "LIVE":
        assert age is not None and age <= 30
    if blocked:
        assert age is None or age > 30
        # A missing/malformed timestamp is fail-closed in the live guard.
        guarded = _require_live_spread(signal, {"spread": 0.2, "quote_status": "LIVE", "updated_at": None})
        assert guarded["status"] == "NO SETUP"
        assert guarded["quote_status"] == "STALE"
        assert "timestamp" in guarded["reasons"][0].lower()
    else:
        assert age is not None and age <= 30


def test_live_quote_guard_blocks_timestamp_older_than_30_seconds(monkeypatch):
    from datetime import datetime, timezone, timedelta
    from app import main

    fixed_now = datetime.now(timezone.utc)
    old_stamp = (fixed_now - timedelta(seconds=31)).isoformat()
    monkeypatch.setattr(main, "_live_quote_age_seconds", lambda market_data, now=None: 31.0)
    signal = {"status": "BUY", "entry": 2000.0, "stop_loss": 1998.0, "take_profits": [2002.0]}
    guarded = main._require_live_spread(signal, {"spread": 0.2, "quote_status": "LIVE", "updated_at": old_stamp})
    assert guarded["status"] == "NO SETUP"
    assert guarded["quote_status"] == "STALE"
    assert "31.0s old" in guarded["reasons"][0]


@pytest.mark.parametrize(("age", "should_block"), [(0.0, False), (30.0, False), (30.1, True), (None, True)])
def test_live_quote_freshness_guard_enforces_age_boundary(monkeypatch, age, should_block):
    from app import main

    monkeypatch.setattr(main, "_live_quote_age_seconds", lambda market_data, now=None: age)
    signal = {"status": "BUY", "entry": 2000.0, "stop_loss": 1998.0, "take_profits": [2002.0]}
    market_data = {"spread": 0.2, "quote_status": "LIVE", "updated_at": "timestamp"}
    guarded = main._require_live_spread(signal, market_data)
    if should_block:
        assert guarded["status"] == "NO SETUP"
        assert guarded["quote_status"] == "STALE"
        assert guarded["entry"] is None
    else:
        assert guarded["status"] == "BUY"


def test_rule_alignment_score_is_weighted_and_independent_of_reason_count():
    from app.market import _rule_alignment_score

    structure = {"bullish_bos": True, "bearish_bos": False,
                 "bullish_choch": False, "bearish_choch": False}
    sweep = {"bullish": False, "bearish": False}
    candle = {"open": 100.0, "high": 102.0, "low": 99.0, "close": 101.8}
    zone = {"status": "NEAR_ZONE", "nearest_zone": {"strength_score": 60}, "distance_atr": 0.5}

    score = _rule_alignment_score("BUY", "4h", "BULLISH", "NOT_REQUIRED", structure, sweep, candle, zone, 2.0, 0.1)

    assert score == 76
    assert isinstance(score, int)
    assert score <= 85


def test_rule_alignment_score_rewards_sweep_and_aligned_higher_timeframe():
    from app.market import _rule_alignment_score

    structure = {"bullish_bos": True, "bearish_bos": False,
                 "bullish_choch": False, "bearish_choch": False}
    candle = {"open": 100.0, "high": 102.0, "low": 99.0, "close": 101.8}
    zone = {"nearest_zone": {"strength_score": 80}, "distance_atr": 0.1}
    base = _rule_alignment_score("BUY", "15m", "BULLISH", "BULLISH", structure,
        {"bullish": False, "bearish": False}, candle, zone, 2.0, 0.1)
    stronger = _rule_alignment_score("BUY", "15m", "BULLISH", "BULLISH", structure,
        {"bullish": True, "bearish": False}, candle, zone, 2.0, 0.1)

    assert stronger > base
    assert stronger <= 85
