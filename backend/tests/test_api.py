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
