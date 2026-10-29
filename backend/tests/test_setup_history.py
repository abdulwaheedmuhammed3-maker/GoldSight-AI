from datetime import datetime, timezone

from app.setup_history import record_setup


def _valid_market():
    return {
        "status": "LIVE",
        "provider": "Test provider",
        "signal": {
            "status": "BUY",
            "signal_fresh": True,
            "signal_time": datetime.now(timezone.utc).isoformat(),
            "entry": 4000.0,
            "stop_loss": 3990.0,
            "take_profits": [4010.0, 4020.0, 4030.0],
            "rr": [1.0, 2.0, 3.0],
            "confidence": 76,
            "trend": "BULLISH",
            "reasons": ["Confirmed candle and trend alignment."],
            "invalidation": "Close below structure.",
        },
    }


def test_no_setup_is_not_recorded(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid")
    market = _valid_market()
    market["signal"]["status"] = "NO SETUP"
    assert record_setup("XAUUSD", "15m", market) is False


def test_stale_setup_is_not_recorded(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid")
    market = _valid_market()
    market["signal"]["signal_fresh"] = False
    assert record_setup("XAUUSD", "15m", market) is False


def test_offline_market_is_not_recorded(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid")
    market = _valid_market()
    market["status"] = "OFFLINE"
    assert record_setup("XAUUSD", "15m", market) is False
