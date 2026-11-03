from app.fundamentals import _classify, _clean_summary, _infer_african_country, _parse_date


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
    assert {"GH", "EG", "MA", "KE", "ZA", "ML", "BF", "NE", "BJ", "CM", "CI", "RW", "SN", "TD", "TG", "DZ", "TN", "BI", "CD", "TZ", "UG", "MW", "ZM", "MZ", "NA", "ZW", "GN", "LY", "MG", "LR", "SL", "CF", "KM", "DJ", "GA", "AO", "BW", "CV", "CG", "GQ", "ER", "SZ", "GM", "GW", "LS", "NG", "SC", "SO", "MR", "MU", "ST"}.issubset(africa_country_codes)


def test_ghana_and_other_african_countries_have_multiple_dedicated_news_sources():
    from app.fundamentals import FEEDS

    country_feed_counts = {}
    for _, _, kind, country in FEEDS:
        if kind == "africa" and country != "AF":
            country_feed_counts[country] = country_feed_counts.get(country, 0) + 1

    assert country_feed_counts["GH"] >= 3
    assert country_feed_counts["KE"] >= 2
    assert country_feed_counts["ZA"] >= 2
    assert country_feed_counts["ML"] >= 3
    assert country_feed_counts["BF"] >= 3
    assert country_feed_counts["NE"] >= 3
    assert country_feed_counts["ET"] >= 2
    assert country_feed_counts["SS"] >= 1
    assert country_feed_counts["SD"] >= 1
    assert country_feed_counts["CD"] >= 3
    assert country_feed_counts["SN"] >= 2
    assert country_feed_counts["TZ"] >= 2
    assert country_feed_counts["UG"] >= 1
    assert country_feed_counts["MW"] >= 1
    assert country_feed_counts["ZM"] >= 1
    assert country_feed_counts["MZ"] >= 1
    assert country_feed_counts["NA"] >= 1
    assert country_feed_counts["ZW"] >= 1
    assert country_feed_counts["GN"] >= 2
    assert country_feed_counts["LY"] >= 2
    assert country_feed_counts["MG"] >= 1
    assert country_feed_counts["LR"] >= 1
    assert country_feed_counts["SL"] >= 1
    assert country_feed_counts["CF"] >= 2
    assert country_feed_counts["KM"] >= 2
    assert country_feed_counts["DJ"] >= 2
    assert country_feed_counts["GA"] >= 2
    assert country_feed_counts["AO"] >= 1
    assert country_feed_counts["BW"] >= 1
    assert country_feed_counts["CV"] >= 1
    assert country_feed_counts["CG"] >= 1
    assert country_feed_counts["GQ"] >= 1
    assert country_feed_counts["ER"] >= 1
    assert country_feed_counts["SZ"] >= 1
    assert country_feed_counts["GM"] >= 1
    assert country_feed_counts["GW"] >= 1
    assert country_feed_counts["LS"] >= 1
    assert country_feed_counts["NG"] >= 1
    assert country_feed_counts["SC"] >= 1
    assert country_feed_counts["SO"] >= 1
    assert country_feed_counts["MR"] >= 2
    assert country_feed_counts["MU"] >= 2
    assert country_feed_counts["ST"] >= 1



def test_news_retention_keeps_only_last_24_hours():
    from datetime import datetime, timedelta, timezone
    from app.fundamentals import _is_within_news_retention

    now = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)
    assert _is_within_news_retention({"published_at": (now - timedelta(hours=23, minutes=59)).isoformat()}, now)
    assert not _is_within_news_retention({"published_at": (now - timedelta(hours=24)).isoformat()}, now)
    assert not _is_within_news_retention({"published_at": (now - timedelta(hours=25)).isoformat()}, now)
    assert not _is_within_news_retention({"published_at": None}, now)
    assert not _is_within_news_retention({"published_at": "not-a-date"}, now)


def test_pan_african_headline_gets_country_only_when_one_country_is_explicit():
    assert _infer_african_country("Kenya central bank holds rates", "") == "KE"
    assert _infer_african_country("Floods affect Kenya and Tanzania", "") == "AF"

def test_pan_african_classifier_handles_common_country_aliases():
    assert _infer_african_country("Ivory Coast election update", "") == "CI"
    assert _infer_african_country("DRC parliament meets", "") == "CD"
    assert _infer_african_country("Congo-Brazzaville announces reforms", "") == "CG"

def test_pan_african_classifier_avoids_ambiguous_or_unsupported_mentions():
    assert _infer_african_country("Congo announces new policy", "") == "AF"
    assert _infer_african_country("Niger River levels rise", "") == "AF"
    assert _infer_african_country("African leaders meet for summit", "") == "AF"


def test_africa_feed_coverage_reports_static_gaps():
    from app.fundamentals import get_africa_feed_coverage

    coverage = get_africa_feed_coverage()
    assert coverage["country_count"] == 54
    assert coverage["covered_country_count"] > 0
    assert set(coverage["dedicated_country_codes"]).isdisjoint(
        set(coverage["coverage_gap_country_codes"])
    )
    assert coverage["covered_country_count"] + len(coverage["coverage_gap_country_codes"]) == 54


def test_feed_health_marks_valid_empty_feed_as_empty(monkeypatch):
    import xml.etree.ElementTree as ET
    from app import fundamentals

    monkeypatch.setattr(fundamentals.urllib.request, "urlopen", lambda *args, **kwargs: _FakeResponse(b"<rss><channel></channel></rss>"))
    items, status = fundamentals._fetch_feed("Test feed", "https://example.com/rss", "africa", "GH")
    assert items == []
    assert status["status"] == "EMPTY"
    assert status["count"] == 0


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return self.payload
