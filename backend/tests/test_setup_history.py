from datetime import datetime, timezone

from app.setup_history import record_setup, _target_reached_before_entry


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


def test_buy_target_before_entry_voids_missed_setup():
    assert _target_reached_before_entry("BUY", 4010.0, 4035.0, 4000.0, [4020.0, 4030.0])


def test_sell_target_before_entry_voids_missed_setup():
    assert _target_reached_before_entry("SELL", 3965.0, 3990.0, 4000.0, [3980.0, 3970.0])


def test_target_touch_in_candle_that_also_touches_entry_is_not_pre_entry():
    assert not _target_reached_before_entry("BUY", 3995.0, 4025.0, 4000.0, [4020.0])
    assert not _target_reached_before_entry("SELL", 3975.0, 4005.0, 4000.0, [3980.0])


def test_no_target_touch_before_entry():
    assert not _target_reached_before_entry("BUY", 4005.0, 4015.0, 4000.0, [4020.0])
    assert not _target_reached_before_entry("SELL", 3985.0, 3995.0, 4000.0, [3980.0])
