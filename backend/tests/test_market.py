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

    candles = [
        {"time": 1800, "close": 3},
        {"time": 900, "close": 1},
        {"time": 1800, "close": 4},
        {"time": 0, "close": 0},
    ]
    normalized = normalize_candles(candles)
    assert [row["time"] for row in normalized] == [0, 900, 1800]
    assert normalized[-1]["close"] == 4


def test_completed_candles_excludes_forming_and_future_bars():
    from app.market import completed_candles

    candles = [
        {"time": 2700, "close": 4},
        {"time": 900, "close": 2},
        {"time": 1800, "close": 3},
        {"time": 3600, "close": 5},
    ]
    # At 00:52:30, bars beginning at 00:15 and 00:30 are complete;
    # the 00:45 bar is still forming and the 01:00 bar is in the future.
    result = completed_candles(candles, "15m", now_ts=3150)
    assert [row["time"] for row in result] == [900, 1800]


def test_completed_candles_respects_explicit_unclosed_flag():
    from app.market import completed_candles

    candles = [
        {"time": 0, "closed": True},
        {"time": 900, "closed": False},
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
