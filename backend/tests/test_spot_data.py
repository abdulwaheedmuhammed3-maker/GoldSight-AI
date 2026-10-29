from datetime import datetime, timezone
import json
from app import spot_data


def test_xaus_spot_returns_indicative_quote(monkeypatch):
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "spot_usd_oz": 4000.5,
        "price_as_of": now,
        "updated_at": now,
        "data_state": {"status": "fresh"},
    }

    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return json.dumps(payload).encode()

    monkeypatch.setattr(spot_data.urllib.request, "urlopen", lambda *args, **kwargs: Response())
    result = spot_data.fetch_xaus_spot()
    assert result["price"] == 4000.5
    assert result["tradable_quote"] is False
    assert result["candles_available"] is False
    assert result["bid"] is None
    assert result["spread"] is None


def test_xaus_spot_rejects_stale_quote(monkeypatch):
    from datetime import timedelta
    old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    payload = {"spot_usd_oz": 4000.5, "price_as_of": old, "data_state": {"status": "fresh"}}

    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return json.dumps(payload).encode()

    monkeypatch.setattr(spot_data.urllib.request, "urlopen", lambda *args, **kwargs: Response())
    try:
        spot_data.fetch_xaus_spot()
    except spot_data.MarketUnavailable:
        return
    assert False, "Stale spot quote should be rejected"
