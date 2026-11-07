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



def test_buy_same_candle_target_and_stop_records_tp():
    from app.setup_history import _same_candle_outcome

    status, price, touched = _same_candle_outcome(
        "BUY", low=3988.0, high=4025.0, stop=3990.0,
        targets=[4010.0, 4020.0, 4030.0],
    )
    assert status == "TP2_HIT"
    assert price == 4020.0
    assert touched == [0, 1]


def test_sell_same_candle_target_and_stop_records_tp():
    from app.setup_history import _same_candle_outcome

    status, price, touched = _same_candle_outcome(
        "SELL", low=3975.0, high=4012.0, stop=4010.0,
        targets=[3990.0, 3980.0, 3970.0],
    )
    assert status == "TP2_HIT"
    assert price == 3980.0
    assert touched == [0, 1]


def test_stop_without_target_still_records_sl():
    from app.setup_history import _same_candle_outcome

    status, price, touched = _same_candle_outcome(
        "BUY", low=3988.0, high=4005.0, stop=3990.0,
        targets=[4010.0, 4020.0, 4030.0],
    )
    assert status == "SL_HIT"
    assert price == 3990.0
    assert touched == []



def test_buy_partial_target_and_stop_collision_records_highest_touched_tp():
    from app.setup_history import _same_candle_outcome

    status, price, touched = _same_candle_outcome(
        "BUY", low=3988.0, high=4015.0, stop=3990.0,
        targets=[4010.0, 4020.0, 4030.0],
    )
    assert status == "TP1_HIT"
    assert price == 4010.0
    assert touched == [0]


def test_sell_partial_target_and_stop_collision_records_highest_touched_tp():
    from app.setup_history import _same_candle_outcome

    status, price, touched = _same_candle_outcome(
        "SELL", low=3985.0, high=4012.0, stop=4010.0,
        targets=[3990.0, 3980.0, 3970.0],
    )
    assert status == "TP1_HIT"
    assert price == 3990.0
    assert touched == [0]


def test_all_targets_touched_records_final_target_and_complete_progression():
    from app.setup_history import _same_candle_outcome

    status, price, touched = _same_candle_outcome(
        "BUY", low=3995.0, high=4035.0, stop=3990.0,
        targets=[4010.0, 4020.0, 4030.0],
    )
    assert status == "TP3_HIT"
    assert price == 4030.0
    assert touched == [0, 1, 2]



def test_prior_tp1_then_later_sl_keeps_tp1_outcome():
    from app.setup_history import _preserve_tp_outcome_after_stop

    stop_stamp = datetime(2026, 11, 5, 10, 0, tzinfo=timezone.utc)
    tp_stamp = datetime(2026, 11, 5, 9, 0, tzinfo=timezone.utc)
    assert _preserve_tp_outcome_after_stop(
        "SL_HIT", 3990.0, stop_stamp, {0}, [4010.0, 4020.0, 4030.0], tp_stamp
    ) == ("TP1_HIT", 4010.0, tp_stamp)


def test_prior_tp2_then_later_sl_keeps_tp2_outcome():
    from app.setup_history import _preserve_tp_outcome_after_stop

    stop_stamp = datetime(2026, 11, 5, 10, 0, tzinfo=timezone.utc)
    tp_stamp = datetime(2026, 11, 5, 9, 30, tzinfo=timezone.utc)
    assert _preserve_tp_outcome_after_stop(
        "SL_HIT", 3990.0, stop_stamp, {0, 1}, [4010.0, 4020.0, 4030.0], tp_stamp
    ) == ("TP2_HIT", 4020.0, tp_stamp)


def test_sl_without_any_tp_keeps_sl_outcome():
    from app.setup_history import _preserve_tp_outcome_after_stop

    stop_stamp = datetime(2026, 11, 5, 10, 0, tzinfo=timezone.utc)
    assert _preserve_tp_outcome_after_stop(
        "SL_HIT", 3990.0, stop_stamp, set(), [4010.0, 4020.0, 4030.0], None
    ) == ("SL_HIT", 3990.0, stop_stamp)
