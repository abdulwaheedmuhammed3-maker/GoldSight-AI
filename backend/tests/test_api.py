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

    closed = xauusd_market_status(datetime(2026, 11, 1, 22, 30, tzinfo=timezone.utc))
    assert closed["market_status"] == "MARKET_CLOSED"
    assert closed["market_phase"] == "WEEKEND"
    assert closed["next_open_at"] == "2026-11-01T23:05:00Z"

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
