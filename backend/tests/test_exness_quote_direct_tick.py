from datetime import datetime, timezone

import app.exness as exness


def test_xauusd_quote_uses_tick_stream_without_rest_instrument_preflight(monkeypatch):
    monkeypatch.setenv("EXN_ACCOUNT_ID", "12345")
    monkeypatch.setenv("EXN_INSTRUMENT_XAUUSD", "XAUUSD")

    def fail_metadata(*_args, **_kwargs):
        raise AssertionError("REST metadata preflight should not run for a live quote")

    monkeypatch.setattr(exness, "_available_instruments", fail_metadata)
    stamp = datetime.now(timezone.utc).isoformat()
    monkeypatch.setattr(exness, "_tick", lambda symbol, timeout: {
        "instrument": "XAUUSD",
        "bid": 2000.0,
        "ask": 2000.5,
        "timestamp": stamp,
    })

    quote = exness.exness_quote("XAUUSD")

    assert quote["status"] == "LIVE"
    assert quote["provider"] == "Exness Trader API · tick feed"
    assert quote["provider_symbol"] == "XAUUSD"
    assert quote["price"] == 2000.25
    assert quote["spread"] == 0.5
