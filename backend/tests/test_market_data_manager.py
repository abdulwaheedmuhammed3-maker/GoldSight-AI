from datetime import datetime, timedelta, timezone

from app import market_data_manager as manager


def _live_quote(updated_at):
    return {
        "symbol": "XAUUSD", "status": "LIVE", "price": 2300.0,
        "bid": 2299.9, "ask": 2300.1, "spread": 0.2,
        "updated_at": updated_at, "provider": "test provider",
    }


def test_fresh_live_quote_is_returned_with_age(monkeypatch):
    stamp = datetime.now(timezone.utc).isoformat()
    monkeypatch.setitem(manager._quotes, "XAUUSD", _live_quote(stamp))

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "LIVE"
    assert 0 <= result["quote_age_seconds"] <= 2


def test_missing_timestamp_never_reports_live(monkeypatch):
    monkeypatch.setitem(manager._quotes, "XAUUSD", _live_quote(None))

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "no provider timestamp" in result["detail"]


def test_stale_quote_never_reports_live(monkeypatch):
    stamp = (datetime.now(timezone.utc) - timedelta(seconds=manager.STALE_AFTER_SECONDS + 1)).isoformat()
    monkeypatch.setitem(manager._quotes, "XAUUSD", _live_quote(stamp))

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "stale" in result["detail"]


def test_future_dated_quote_never_reports_live(monkeypatch):
    stamp = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()
    monkeypatch.setitem(manager._quotes, "XAUUSD", _live_quote(stamp))

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "future-dated" in result["detail"]


def test_invalid_bid_ask_never_reports_live(monkeypatch):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote["ask"] = quote["bid"] - 1
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "ask below bid" in result["detail"]


def test_boolean_spread_never_reports_live(monkeypatch):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote["spread"] = True
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "invalid spread" in result["detail"]


def test_negative_spread_never_reports_live(monkeypatch):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote["spread"] = -0.1
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "invalid spread" in result["detail"]


def test_spread_must_match_bid_ask_difference(monkeypatch):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote["spread"] = 0.5
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "does not match ask minus bid" in result["detail"]


def test_small_float_rounding_difference_in_spread_is_accepted(monkeypatch):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote["spread"] = 0.200000001
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "LIVE"


import pytest


@pytest.mark.parametrize("field", ["price", "bid", "ask"])
def test_numeric_string_price_field_never_reports_live(monkeypatch, field):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote[field] = str(quote[field])
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert f"invalid {field}" in result["detail"]


def test_numeric_string_spread_never_reports_live(monkeypatch):
    quote = _live_quote(datetime.now(timezone.utc).isoformat())
    quote["spread"] = "0.2"
    monkeypatch.setitem(manager._quotes, "XAUUSD", quote)

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "invalid spread" in result["detail"]


def test_quote_with_small_but_excessive_future_skew_never_reports_live(monkeypatch):
    stamp = (datetime.now(timezone.utc) + timedelta(seconds=8)).isoformat()
    monkeypatch.setitem(manager._quotes, "XAUUSD", _live_quote(stamp))

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert "future-dated" in result["detail"]


def test_offline_tracker_retains_last_quote_for_cached_display(monkeypatch):
    stamp = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat()
    last_quote = _live_quote(stamp)
    monkeypatch.setitem(manager._quotes, "XAUUSD", manager._offline("XAUUSD", "Provider timeout", last_quote))

    result = manager.get_tracked_quote("XAUUSD")

    assert result["status"] == "OFFLINE"
    assert result["price"] == last_quote["price"]
    assert result["bid"] == last_quote["bid"]
    assert result["updated_at"] == stamp
    assert result["quote_age_seconds"] >= 45
