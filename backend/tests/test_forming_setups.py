from app import forming_setups


def _bars(start, count, step=300):
    return [
        {
            "time": start + index * step,
            "open": 100.0 + index * 0.1,
            "high": 101.0 + index * 0.1,
            "low": 99.0 + index * 0.1,
            "close": 100.5 + index * 0.1,
        }
        for index in range(count)
    ]


def test_forming_candidate_uses_current_bar_but_removes_trade_levels(monkeypatch):
    now = 1_800_000_000
    candle_time = (now // 300) * 300
    candles = _bars(candle_time - 40 * 300, 40)
    candles.append({
        "time": candle_time,
        "open": 104.0,
        "high": 106.0,
        "low": 103.5,
        "close": 105.8,
    })
    seen = {}

    def fake_analyze(bars, symbol, timeframe, spread, higher, **kwargs):
        seen["last_time"] = bars[-1]["time"]
        seen["include_last_completed"] = kwargs.get("include_last_completed")
        return {
            "status": "BUY",
            "side": "BUY",
            "candidate_side": "BUY",
            "entry": 105.8,
            "stop_loss": 103.0,
            "take_profits": [108.6, 111.4, 114.2],
            "rr": [1, 2, 3],
            "confidence": 86,
            "reasons": ["test signal"],
        }

    monkeypatch.setattr(forming_setups, "analyze", fake_analyze)
    result = forming_setups.evaluate_forming_candidate(
        candles, "EURUSD", "5m", 0.0001, now_ts=now
    )

    assert seen["last_time"] == candle_time
    assert seen["include_last_completed"] is True
    assert result["candle_time"] == candle_time
    candidate = result["signal"]
    assert candidate["setup_state"] == "FORMING"
    assert candidate["status"] == "NO SETUP"
    assert candidate["candidate_side"] == "BUY"
    assert candidate["entry"] is None
    assert candidate["stop_loss"] is None
    assert candidate["take_profits"] == []
    assert candidate["rr"] is None
    assert candidate["confidence"] is None


def test_forming_candidate_is_not_created_without_a_current_bar(monkeypatch):
    now = 1_800_000_000
    candle_time = (now // 300) * 300 - 600
    candles = _bars(candle_time - 40 * 300, 41)
    monkeypatch.setattr(
        forming_setups,
        "analyze",
        lambda *args, **kwargs: {"status": "BUY"},
    )

    result = forming_setups.evaluate_forming_candidate(
        candles, "EURUSD", "5m", 0.0001, now_ts=now
    )

    assert result == {"candle_time": None, "signal": None}


def test_forming_lifecycle_marks_closed_unconfirmed_candidate_invalidated():
    forming_setups.reset_forming_lifecycle()
    candle_time = 1_800_000_000
    candidate = {
        "signal_time": "2027-01-15T08:00:00+00:00",
        "candidate_side": "SELL",
        "setup_state": "FORMING",
    }
    # Use the exact epoch corresponding to the timestamp above.
    from datetime import datetime
    stamp = int(datetime.fromisoformat(candidate["signal_time"]).timestamp())
    assert stamp == candle_time

    state = forming_setups.update_forming_lifecycle(
        "XAUUSD", "5m", stamp, None, candidate, None, now_ts=stamp + 30
    )
    assert state["status"] == "FORMING"

    state = forming_setups.update_forming_lifecycle(
        "XAUUSD", "5m", stamp + 300, stamp, None, None, now_ts=stamp + 301
    )
    assert state["status"] == "INVALIDATED"
    assert state["candidate_currently_valid"] is False


def test_forming_lifecycle_marks_candidate_confirmed_on_same_closed_candle():
    forming_setups.reset_forming_lifecycle()
    candle_time = 1_800_000_000
    candidate = {
        "signal_time": "2027-01-15T08:00:00+00:00",
        "candidate_side": "BUY",
        "setup_state": "FORMING",
    }
    confirmed = {"status": "BUY", "signal_time": candidate["signal_time"]}
    state = forming_setups.update_forming_lifecycle(
        "BTCUSD", "15m", candle_time, None, candidate, None, now_ts=candle_time + 30
    )
    assert state["status"] == "FORMING"

    state = forming_setups.update_forming_lifecycle(
        "BTCUSD", "15m", None, candle_time, None, confirmed, now_ts=candle_time + 901
    )
    assert state["status"] == "CONFIRMED"
