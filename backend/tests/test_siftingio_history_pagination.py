import app.market as market


def test_siftingio_history_pages_follows_cursor_and_combines_rows(monkeypatch):
    calls = []

    def fake_json(path, params):
        calls.append(dict(params))
        if len(calls) == 1:
            return {"data": [{"t": 1000}], "meta": {"next_cursor": "page-2"}}
        return {"data": [{"t": 2000}], "meta": {"next_cursor": None}}

    monkeypatch.setattr(market, "_siftingio_json", fake_json)
    rows, meta, pages = market._siftingio_history_pages({"interval": "1h", "limit": "200"})

    assert pages == 2
    assert len(rows) == 2
    assert "cursor" not in calls[0]
    assert calls[1]["cursor"] == "page-2"
    assert meta["next_cursor"] is None


def test_siftingio_history_pages_stops_repeated_cursor(monkeypatch):
    calls = []

    def fake_json(path, params):
        calls.append(dict(params))
        return {"data": [{"t": len(calls) * 1000}], "meta": {"next_cursor": "same"}}

    monkeypatch.setattr(market, "_siftingio_json", fake_json)
    rows, meta, pages = market._siftingio_history_pages({"interval": "5m"})

    assert pages == 2
    assert len(rows) == 2
    assert calls[1]["cursor"] == "same"
