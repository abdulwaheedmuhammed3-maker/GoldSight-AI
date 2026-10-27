from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_root_identifies_service() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["name"] == "GoldSight AI API"


def test_health_endpoint_reports_market_feed_not_connected() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["market_data"] == "not_connected"
    assert "timestamp" in payload


def test_demo_forecast_is_explicitly_not_a_real_prediction() -> None:
    response = client.get("/api/v1/forecast/demo")
    assert response.status_code == 200
    payload = response.json()
    assert payload["is_demo"] is True
    assert payload["direction"] == "NOT AVAILABLE"
    assert "no predictive model" in payload["note"]
