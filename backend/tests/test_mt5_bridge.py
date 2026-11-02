import math

import pytest

from app.mt5_bridge import _safe_snapshot


def base_payload():
    return {
        "broker": "Example Broker",
        "server": "Example-Server",
        "account_login": "123456",
        "account_currency": "USD",
        "leverage": 500,
        "terminal": "MetaTrader 5",
        "terminal_build": "5000",
        "connected": True,
        "open_positions": 1,
    }


def test_snapshot_accepts_and_preserves_position_and_closing_deal_records():
    payload = base_payload()
    payload["position_items"] = [{
        "ticket": "1001", "symbol": "XAUUSD", "type": "BUY",
        "volume": 0.1, "price_open": 2300.0, "price_current": 2305.0,
        "stop_loss": 2290.0, "take_profit": 2320.0,
        "profit": 50.0, "swap": -1.0, "time": 1760000000,
    }]
    payload["recent_closed_trades"] = [{
        "ticket": "2001", "symbol": "EURUSD", "type": "SELL",
        "volume": 0.2, "price": 1.08, "profit": 12.0,
        "swap": -0.5, "commission": -1.0, "time": 1760000100,
    }]

    snapshot = _safe_snapshot(payload)

    assert snapshot["position_items"][0]["ticket"] == "1001"
    assert snapshot["position_items"][0]["profit"] == 50.0
    assert snapshot["recent_closed_trades"][0]["commission"] == -1.0
    assert "balance" not in snapshot


@pytest.mark.parametrize("field,value", [
    ("open_positions", True),
    ("open_positions", -1),
    ("open_positions", 100001),
    ("connected", "true"),
])
def test_snapshot_rejects_invalid_top_level_fields(field, value):
    payload = base_payload()
    payload[field] = value
    with pytest.raises(ValueError):
        _safe_snapshot(payload)


@pytest.mark.parametrize("field,value", [
    ("position_items", {}),
    ("position_items", "not-a-list"),
    ("recent_closed_trades", [None]),
    ("position_items", [{"volume": True}]),
    ("position_items", [{"price_open": "2300"}]),
    ("recent_closed_trades", [{"profit": float("nan")}]),
    ("recent_closed_trades", [{"commission": float("inf")}]),
    ("position_items", [{"time": 1e16}]),
])
def test_snapshot_rejects_malformed_trade_records(field, value):
    payload = base_payload()
    payload[field] = value
    with pytest.raises(ValueError):
        _safe_snapshot(payload)


@pytest.mark.parametrize("field", ["position_items", "recent_closed_trades"])
def test_snapshot_caps_each_record_collection_at_50(field):
    payload = base_payload()
    payload[field] = [{} for _ in range(51)]
    with pytest.raises(ValueError, match="at most 50"):
        _safe_snapshot(payload)


def test_snapshot_defaults_missing_record_collections_to_empty_lists():
    snapshot = _safe_snapshot(base_payload())
    assert snapshot["position_items"] == []
    assert snapshot["recent_closed_trades"] == []


def test_snapshot_preserves_explicit_disconnected_terminal_state():
    payload = base_payload()
    payload["connected"] = False

    snapshot = _safe_snapshot(payload)

    assert snapshot["connected"] is False


def test_snapshot_rejects_boolean_and_non_finite_account_totals():
    for value in (True, math.nan, math.inf, -math.inf):
        payload = base_payload()
        payload["balance"] = value
        with pytest.raises(ValueError):
            _safe_snapshot(payload)


def test_pair_device_rejects_non_text_device_name_before_database_access(monkeypatch):
    from app.mt5_bridge import pair_device

    admin_key = "a" * 32
    monkeypatch.setenv("MT5_BRIDGE_ADMIN_KEY", admin_key)
    with pytest.raises(ValueError, match="Device name must be text"):
        _safe_snapshot(base_payload())
