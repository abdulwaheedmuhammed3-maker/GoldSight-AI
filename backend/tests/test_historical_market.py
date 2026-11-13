from datetime import datetime, timezone

import pytest

from app import historical_market as history
from app.market import MarketUnavailable


def _bars():
    return [
        {"time": 1_800_000_000, "open": 100.0, "high": 102.0, "low": 99.0,
         "close": 101.0, "volume": 10}
    ]


def test_range_validation_rejects_bad_ranges():
    with pytest.raises(MarketUnavailable):
        history._range_check("XAUUSD", "15m", 200, 100)
    with pytest.raises(MarketUnavailable):
        history._range_check("UNKNOWN", "15m", 100, 200)


def test_exness_history_keeps_provider_and_filters_window(monkeypatch):
    monkeypatch.setattr(history, "_provider_for", lambda symbol: "exness")
    monkeypatch.setattr(history, "_exness", lambda *args: _bars())
    result = history.fetch_historical_candles(
        "XAUUSD", "15m", 1_799_999_900, 1_800_001_000,
    )
    assert result["provider"] == "exness"
    assert result["provider_symbol"] == "XAUUSD"
    assert result["count"] == 1
    assert result["candles"][0]["time"] == 1_800_000_000


def test_biquote_date_range_is_explicitly_unsupported(monkeypatch):
    monkeypatch.setattr(history, "_provider_for", lambda symbol: "biquote")
    with pytest.raises(MarketUnavailable, match="date-range history is not supported"):
        history.fetch_historical_candles(
            "USDNGN", "1h", 1_799_999_900, 1_800_001_000,
        )


def test_no_cross_provider_fallback_when_primary_history_fails(monkeypatch):
    monkeypatch.setattr(history, "_provider_for", lambda symbol: "exness")

    def fail(*args, **kwargs):
        raise MarketUnavailable("primary unavailable")

    monkeypatch.setattr(history, "_exness", fail)
    with pytest.raises(MarketUnavailable, match="primary unavailable"):
        history.fetch_historical_candles(
            "BTCUSD", "15m", 1_799_999_900, 1_800_001_000,
        )


def test_mt5_range_uses_utc_datetime(monkeypatch):
    class FakeMT5:
        TIMEFRAME_M15 = 15

        def copy_rates_range(self, symbol, timeframe, start, end):
            assert start.tzinfo == timezone.utc
            assert end.tzinfo == timezone.utc
            assert symbol == "EURUSD.a"
            assert timeframe == 15
            return []

        def shutdown(self):
            pass

        def last_error(self):
            return (0, "ok")

    fake = FakeMT5()
    monkeypatch.setattr(history, "_provider_for", lambda symbol: "mt5")
    monkeypatch.setattr(history, "_mt5", lambda: fake)
    monkeypatch.setattr(history, "_mt5_symbol", lambda mt5, symbol: "EURUSD.a")
    result = history.fetch_historical_candles(
        "EURUSD", "15m", 1_799_999_900, 1_800_001_000,
    )
    assert result["provider"] == "mt5"
    assert result["provider_symbol"] == "EURUSD.a"
    assert result["count"] == 0
