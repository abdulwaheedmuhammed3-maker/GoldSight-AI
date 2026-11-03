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



def test_extract_rss_media_thumbnail():
    import xml.etree.ElementTree as ET
    from app.fundamentals import _extract_image

    item = ET.fromstring(
        '<item xmlns:media="http://search.yahoo.com/mrss/">'
        '<title>Central bank update</title>'
        '<media:thumbnail url="https://cdn.example.com/story.webp" />'
        '</item>'
    )
    assert _extract_image(item, "https://publisher.example/story") == "https://cdn.example.com/story.webp"


def test_extract_rss_image_enclosure():
    import xml.etree.ElementTree as ET
    from app.fundamentals import _extract_image

    item = ET.fromstring(
        '<item><enclosure url="https://cdn.example.com/story.jpg" type="image/jpeg" /></item>'
    )
    assert _extract_image(item, "https://publisher.example/story") == "https://cdn.example.com/story.jpg"


def test_extract_rss_image_from_description_html():
    import xml.etree.ElementTree as ET
    from app.fundamentals import _extract_image

    item = ET.fromstring(
        '<item><description><![CDATA[<p>News</p><img src="https://cdn.example.com/story.png" />]]></description></item>'
    )
    assert _extract_image(item, "https://publisher.example/story") == "https://cdn.example.com/story.png"


def test_extract_rss_image_returns_none_when_feed_has_no_image():
    import xml.etree.ElementTree as ET
    from app.fundamentals import _extract_image

    item = ET.fromstring('<item><title>Text only update</title></item>')
    assert _extract_image(item, "https://publisher.example/story") is None


def test_source_image_fallback_uses_article_publisher():
    from app.fundamentals import _source_image

    assert _source_image("https://publisher.example/news/story") == "https://www.google.com/s2/favicons?domain=publisher.example&sz=256"


def test_africa_news_sources_include_multiple_country_feeds():
    from app.fundamentals import FEEDS

    africa_country_codes = {country for _, _, kind, country in FEEDS if kind == "africa"}
    assert {"GH", "EG", "MA", "KE", "ZA"}.issubset(africa_country_codes)



def test_news_retention_keeps_only_last_24_hours():
    from datetime import datetime, timedelta, timezone
    from app.fundamentals import _is_within_news_retention

    now = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)
    assert _is_within_news_retention({"published_at": (now - timedelta(hours=23, minutes=59)).isoformat()}, now)
    assert not _is_within_news_retention({"published_at": (now - timedelta(hours=24)).isoformat()}, now)
    assert not _is_within_news_retention({"published_at": (now - timedelta(hours=25)).isoformat()}, now)
    assert not _is_within_news_retention({"published_at": None}, now)
    assert not _is_within_news_retention({"published_at": "not-a-date"}, now)
