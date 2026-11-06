from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_setup_performance_endpoint_returns_summary(monkeypatch):
    monkeypatch.setattr("app.main.database_configured", lambda: True)
    monkeypatch.setattr(
        "app.main.list_setups",
        lambda limit: [
            {"symbol": "XAUUSD", "timeframe": "15m", "status": "TP1_HIT"},
            {"symbol": "XAUUSD", "timeframe": "15m", "status": "SL_HIT"},
            {"symbol": "BTCUSD", "timeframe": "1h", "status": "ACTIVE"},
        ],
    )

    response = client.get("/api/v1/setups/performance?limit=10")

    assert response.status_code == 200
    payload = response.json()
    assert payload["records_scanned"] == 3
    assert payload["overall"]["wins"] == 1
    assert payload["overall"]["losses"] == 1
    assert payload["overall"]["resolved"] == 2
    assert payload["overall"]["win_rate_pct"] == 50.0
    assert len(payload["by_market"]) == 1
    assert payload["by_market"][0]["symbol"] == "XAUUSD"
    assert payload["by_market"][0]["resolved"] == 2
    assert "bounded by limit" in payload["scope"]


def test_setup_performance_endpoint_requires_persistent_database(monkeypatch):
    monkeypatch.setattr("app.main.database_configured", lambda: False)

    response = client.get("/api/v1/setups/performance")

    assert response.status_code == 503
    assert "DATABASE_URL" in response.json()["detail"]


def test_setup_performance_endpoint_handles_database_error(monkeypatch):
    monkeypatch.setattr("app.main.database_configured", lambda: True)

    def fail_list(limit):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("app.main.list_setups", fail_list)

    response = client.get("/api/v1/setups/performance")

    assert response.status_code == 503
    assert response.json()["detail"] == "Setup performance database is unavailable."
