from datetime import datetime, timezone

from app import main
from app import market_data_manager as manager


def test_instrument_health_reports_all_symbols_and_summary(monkeypatch):
    symbols = manager.SYMBOLS
    def quote_for(symbol):
        status = "LIVE" if symbol in {"XAUUSD", "BTCUSD"} else "OFFLINE"
        return {
            "symbol": symbol, "status": status, "provider": "test provider",
            "provider_symbol": symbol, "price": 100.0, "bid": 99.9, "ask": 100.1,
            "spread": 0.2, "digits": 2,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "quote_age_seconds": 2 if status == "LIVE" else 45,
            "detail": None if status == "LIVE" else "provider auth error",
        }
    monkeypatch.setattr(main, "get_tracked_quote", quote_for)

    result = main.instrument_health()

    assert result["status"] == "ok"
    assert result["instrument_count"] == len(symbols) == 9
    assert [item["symbol"] for item in result["instruments"]] == list(symbols)
    assert result["summary"] == {"LIVE": 2, "STALE": 0, "OFFLINE": 7}
    assert result["instruments"][0]["tradable_quote"] is True
    assert result["instruments"][2]["tradable_quote"] is False
    assert result["instruments"][2]["detail"] == "provider auth error"


def test_instrument_health_downgrades_old_live_tick_to_stale(monkeypatch):
    def stale_quote(symbol):
        return {
            "symbol": symbol, "status": "LIVE", "provider": "test provider",
            "provider_symbol": symbol, "price": 100.0, "bid": 99.9, "ask": 100.1,
            "spread": 0.2, "digits": 2,
            "updated_at": "2026-11-06T09:00:00+00:00",
            "quote_age_seconds": main.LIVE_QUOTE_MAX_AGE_SECONDS + 1,
            "detail": None,
        }
    monkeypatch.setattr(main, "get_tracked_quote", stale_quote)

    result = main.instrument_health()

    assert result["summary"] == {"LIVE": 0, "STALE": 9, "OFFLINE": 0}
    assert all(item["status"] == "STALE" for item in result["instruments"])
    assert all(item["tradable_quote"] is False for item in result["instruments"])
