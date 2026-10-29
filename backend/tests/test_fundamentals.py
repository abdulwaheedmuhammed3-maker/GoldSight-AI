from app.fundamentals import _classify, _clean_summary, _parse_date


def test_macro_headline_is_relevant_to_gold():
    assets, impact = _classify("Federal Reserve announces interest rate decision", "", "macro")
    assert "XAUUSD" in assets
    assert impact == "HIGH"


def test_crypto_feed_marks_bitcoin_relevance():
    assets, _ = _classify("Bitcoin ETF market update", "", "crypto")
    assert "BTCUSD" in assets


def test_headline_triage_does_not_claim_direction():
    _, _, = _classify("Federal Reserve announcement", "", "macro")
    # The aggregator returns relevance and impact only; it does not infer bullish/bearish direction.


def test_clean_summary_removes_markup_and_limits_length():
    assert _clean_summary("<p>Macro <b>news</b></p>") == "Macro news"
    assert len(_clean_summary("x" * 400)) == 321


def test_parse_rss_date_to_utc():
    assert _parse_date("Wed, 29 Oct 2026 12:00:00 GMT") == "2026-10-29T12:00:00+00:00"


def test_bad_date_is_ignored():
    assert _parse_date("not a date") is None


def test_news_trade_requires_matching_high_impact_headline(monkeypatch):
    from app import fundamentals

    monkeypatch.setattr(fundamentals, "get_fundamental_news", lambda **kwargs: {
        "status": "LIVE",
        "items": [{
            "id": "test-1", "title": "Federal Reserve rate decision", "url": "https://example.com/fed",
            "source": "Test source", "published_at": "2026-10-29T12:00:00+00:00",
            "assets": ["XAUUSD"], "impact": "HIGH",
        }],
    })
    result = fundamentals.classify_trade_context("XAUUSD", {"status": "SELL", "signal_time": "2026-10-29T12:15:00+00:00"})
    assert result["trade_type"] == "NEWS TRADE"
    assert result["news_context"]["title"] == "Federal Reserve rate decision"
    assert result["news_context"]["causality_confirmed"] is False


def test_technical_trade_when_headline_is_too_old(monkeypatch):
    from app import fundamentals

    monkeypatch.setattr(fundamentals, "get_fundamental_news", lambda **kwargs: {
        "status": "LIVE",
        "items": [{
            "id": "test-1", "title": "Federal Reserve rate decision", "url": "https://example.com/fed",
            "source": "Test source", "published_at": "2026-10-29T11:00:00+00:00",
            "assets": ["XAUUSD"], "impact": "HIGH",
        }],
    })
    result = fundamentals.classify_trade_context("XAUUSD", {"status": "SELL", "signal_time": "2026-10-29T12:00:00+00:00"})
    assert result["trade_type"] == "TECHNICAL TRADE"
    assert result["news_context"] is None


def test_news_trade_requires_asset_relevance(monkeypatch):
    from app import fundamentals

    monkeypatch.setattr(fundamentals, "get_fundamental_news", lambda **kwargs: {
        "status": "LIVE",
        "items": [{
            "id": "test-1", "title": "Bitcoin event", "url": "https://example.com/btc",
            "source": "Test source", "published_at": "2026-10-29T12:00:00+00:00",
            "assets": ["BTCUSD"], "impact": "HIGH",
        }],
    })
    result = fundamentals.classify_trade_context("XAUUSD", {"status": "SELL", "signal_time": "2026-10-29T12:15:00+00:00"})
    assert result["trade_type"] == "TECHNICAL TRADE"
