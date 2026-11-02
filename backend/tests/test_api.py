import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_root_identifies_service() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["name"] == "GoldSight AI API"


def test_health_endpoint_reports_provider_expectations() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert "XAUUSD" in payload["providers"]
    assert "BTCUSD" in payload["providers"]


def test_only_supported_symbols_are_exposed() -> None:
    response = client.get("/api/v1/market/ETHUSD?timeframe=15m")
    assert response.status_code == 404


def test_invalid_timeframe_is_rejected() -> None:
    response = client.get("/api/v1/market/XAUUSD?timeframe=1m")
    assert response.status_code == 422


def test_offline_gold_never_returns_fabricated_price(monkeypatch) -> None:
    from app import main
    from app.market import MarketUnavailable

    def offline(*args, **kwargs):
        raise MarketUnavailable("provider disconnected")

    monkeypatch.setattr(main, "fetch_market", offline)
    monkeypatch.setattr(main, "xauusd_market_status", lambda: {"market_status": "OPEN", "market_phase": "TRADING", "next_open_at": None, "schedule_timezone": "UTC"})
    response = client.get("/api/v1/market/XAUUSD?timeframe=15m")
    assert response.status_code == 503
    payload = response.json()
    assert payload["status"] == "OFFLINE"
    assert payload["price"] is None
    assert payload["candles"] == []
    assert payload["signal"]["status"] == "NO SETUP"


def test_risk_profile_matches_demo_account_and_all_supported_symbols() -> None:
    response = client.get("/api/v1/risk/profile")
    assert response.status_code == 200
    payload = response.json()
    assert payload["account_currency"] == "NGN"
    assert payload["account_balance"] == 300000
    assert payload["default_risk_pct"] == 1
    assert set(payload["symbols"]) == {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"}
    for symbol in ("EURUSD", "GBPUSD"):
        assert payload["symbols"][symbol]["contract_size"] == 100000
        assert payload["symbols"][symbol]["minimum_volume"] == 0.01
        assert payload["symbols"][symbol]["volume_step"] == 0.01


def test_exness_xauusd_market_hours_use_winter_schedule() -> None:
    from datetime import datetime, timezone
    from app.market_hours import xauusd_market_status

    closed = xauusd_market_status(datetime(2026, 11, 1, 17, 0, tzinfo=timezone.utc))
    assert closed["market_status"] == "MARKET_CLOSED"
    assert closed["market_phase"] == "WEEKEND"
    assert closed["next_open_at"] == "2026-11-01T22:05:00Z"

    daily_break = xauusd_market_status(datetime(2026, 11, 2, 22, 30, tzinfo=timezone.utc))
    assert daily_break["market_status"] == "MARKET_CLOSED"
    assert daily_break["market_phase"] == "DAILY_BREAK"
    assert daily_break["next_open_at"] == "2026-11-02T23:02:00Z"


def test_exness_xauusd_market_hours_use_summer_schedule() -> None:
    from datetime import datetime, timezone
    from app.market_hours import xauusd_market_status

    open_session = xauusd_market_status(datetime(2026, 7, 6, 19, 0, tzinfo=timezone.utc))
    assert open_session["market_status"] == "OPEN"
    assert open_session["next_open_at"] is None

    daily_break = xauusd_market_status(datetime(2026, 7, 6, 21, 30, tzinfo=timezone.utc))
    assert daily_break["market_status"] == "MARKET_CLOSED"
    assert daily_break["next_open_at"] == "2026-07-06T22:02:00Z"



@pytest.mark.parametrize("field,value", [
    ("balance", True),
    ("risk_pct", False),
    ("entry", True),
    ("stop_loss", False),
    ("leverage", True),
    ("contract_size", False),
    ("quote_to_account_rate", True),
    ("volume_step", False),
    ("min_volume", True),
    ("max_volume", False),
    ("margin_per_lot_quote", True),
])
def test_position_size_api_rejects_boolean_numeric_inputs(field, value) -> None:
    payload = {
        "symbol": "XAUUSD", "side": "BUY", "balance": 1000, "risk_pct": 1,
        "entry": 4200, "stop_loss": 4190, "leverage": 200, "contract_size": 100,
        "quote_to_account_rate": 1, "volume_step": 0.01, "min_volume": 0.01,
        "max_volume": 1000, "margin_per_lot_quote": 400,
    }
    payload[field] = value
    response = client.post("/api/v1/risk/position-size", json=payload)
    assert response.status_code == 422
