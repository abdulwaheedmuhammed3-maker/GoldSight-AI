from app.stock_intelligence import UNIVERSE, WFE_MARKET_CAP, _coverage_status


def test_coverage_status_requires_full_fresh_watchlist_and_usable_benchmark():
    complete = [{"fresh": True}, {"fresh": True}]
    assert _coverage_status(2, complete, {"status": "LIVE"}) == "LIVE"
    assert _coverage_status(2, complete, {"status": "DELAYED"}) == "LIVE"
    assert _coverage_status(2, complete, {"status": "STALE"}) == "PARTIAL"
    assert _coverage_status(2, complete, None) == "PARTIAL"


def test_coverage_status_marks_partial_watchlist_or_stale_constituents():
    assert _coverage_status(3, [{"fresh": True}, {"fresh": True}], {"status": "LIVE"}) == "PARTIAL"
    assert _coverage_status(2, [{"fresh": True}, {"fresh": False}], {"status": "LIVE"}) == "PARTIAL"


def test_coverage_status_is_offline_when_both_watchlist_and_benchmark_fail():
    assert _coverage_status(2, [], None) == "OFFLINE"
    assert _coverage_status(2, [], {"status": "STALE"}) == "OFFLINE"


def test_market_cap_snapshots_expose_currency_date_source_for_all_supported_markets():
    assert set(WFE_MARKET_CAP) == set(UNIVERSE) - {"NG"}
    for snapshot in WFE_MARKET_CAP.values():
        assert snapshot.get("currency") in {"USD", "GBP"}
        assert snapshot.get("as_of")
        assert snapshot.get("source")
        assert snapshot.get("exchanges")
        assert (snapshot.get("value_millions") or snapshot.get("value_usd_millions")) > 0


def test_uk_market_cap_metadata_keeps_its_distinct_currency_and_date():
    snapshot = WFE_MARKET_CAP["GB"]
    assert snapshot["currency"] == "GBP"
    assert snapshot["as_of"] == "30 September 2026"
    assert snapshot["source"] == "FTSE Russell / London Stock Exchange"
