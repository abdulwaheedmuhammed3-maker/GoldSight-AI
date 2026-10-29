from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_spot_endpoint_is_explicitly_non_tradable(monkeypatch):
    from app import spot_data

    monkeypatch.setattr(spot_data, "fetch_xaus_spot", lambda: {
        "symbol": "XAUUSD",
        "provider": "XAUS indicative gold spot API",
        "status": "LIVE",
        "price": 4000.5,
        "bid": None,
        "ask": None,
        "spread": None,
        "tradable_quote": False,
        "candles_available": False,
    })
    response = client.get("/api/v1/spot/XAUUSD")
    assert response.status_code == 200
    payload = response.json()
    assert payload["price"] == 4000.5
    assert payload["tradable_quote"] is False
    assert payload["candles_available"] is False


def test_spot_endpoint_reports_offline_without_fake_price(monkeypatch):
    from app import spot_data
    from app.market import MarketUnavailable

    def offline():
        raise MarketUnavailable("provider unavailable")

    monkeypatch.setattr(spot_data, "fetch_xaus_spot", offline)
    response = client.get("/api/v1/spot/XAUUSD")
    assert response.status_code == 503
    payload = response.json()
    assert payload["status"] == "OFFLINE"
    assert payload["price"] is None
