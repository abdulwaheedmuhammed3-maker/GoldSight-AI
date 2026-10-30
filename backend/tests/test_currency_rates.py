import pytest
from app import currency_rates


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "result": "success",
            "time_last_update_utc": "Fri, 30 Oct 2026 00:00:01 +0000",
            "time_next_update_utc": "Sat, 31 Oct 2026 00:00:01 +0000",
            "rates": {"USD": 1.0, "NGN": 1500.0, "EUR": 0.86},
        }


def test_currency_rates_returns_supported_currencies(monkeypatch):
    monkeypatch.setattr(currency_rates.httpx, "get", lambda *args, **kwargs: FakeResponse())
    currency_rates._cache.clear()
    result = currency_rates.get_currency_rates("usd")
    assert result["status"] == "LIVE"
    assert result["base"] == "USD"
    assert result["rates"]["NGN"] == 1500.0
    assert result["currency_count"] == 3


def test_currency_rates_rejects_invalid_currency_code():
    with pytest.raises(ValueError):
        currency_rates.get_currency_rates("US D")


def test_currency_rates_uses_cached_result(monkeypatch):
    calls = []
    def fake_get(*args, **kwargs):
        calls.append(1)
        return FakeResponse()
    monkeypatch.setattr(currency_rates.httpx, "get", fake_get)
    currency_rates._cache.clear()
    currency_rates.get_currency_rates("EUR")
    cached = currency_rates.get_currency_rates("EUR")
    assert len(calls) == 1
    assert cached["cache_status"] == "CACHED"
