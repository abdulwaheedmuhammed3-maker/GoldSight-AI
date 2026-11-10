from datetime import datetime, timezone

import app.market as market


def test_siftingio_history_diagnostics_reports_provider_rows(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    aligned = (now // 3600) * 3600
    rows = [
        {"t": (aligned - 7200) * 1000, "o": 2300, "h": 2310, "l": 2290, "c": 2305, "v": 10},
        {"t": (aligned - 3600) * 1000, "o": 2305, "h": 2320, "l": 2300, "c": 2315, "v": 12},
    ]

    def fake_request(path, params):
        assert path == "/v1/hist/commodities/XAUUSD/bars"
        assert params["interval"] == "1h"
        return {"data": rows, "meta": {
            "symbol": "XAUUSD", "interval": "1h",
            "as_of": datetime.now(timezone.utc).isoformat(),
            "next_cursor": None,
        }}

    monkeypatch.setattr(market, "_siftingio_json", fake_request)
    result = market.siftingio_history_diagnostics("1h", 40)

    assert result["returned_rows"] == 2
    assert result["valid_unique_rows"] == 2
    assert result["invalid_rows"] == 0
    assert result["raw_order"] == "ascending"
    assert result["provider_meta"]["symbol"] == "XAUUSD"
    assert result["provider_meta"]["next_cursor_available"] is False
    assert "note" in result


def test_siftingio_history_diagnostics_counts_invalid_rows(monkeypatch):
    monkeypatch.setattr(
        market, "_siftingio_json",
        lambda path, params: {"data": [
            {"t": 1_800_000_000_000, "o": 10, "h": 9, "l": 11, "c": 12}
        ], "meta": {}},
    )
    result = market.siftingio_history_diagnostics("5m", 40)
    assert result["returned_rows"] == 1
    assert result["valid_unique_rows"] == 0
    assert result["invalid_rows"] == 1
