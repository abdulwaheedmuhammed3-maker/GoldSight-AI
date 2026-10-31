from app.push_notifications import is_news_notification_eligible


def test_high_impact_global_news_is_eligible():
    assert is_news_notification_eligible({"impact": "HIGH", "country": "US"}) is True


def test_all_nigeria_news_is_eligible_even_when_not_high_impact():
    assert is_news_notification_eligible({"impact": "LOW", "country": "NG"}) is True
    assert is_news_notification_eligible({"impact": "MEDIUM", "country": "NG"}) is True


def test_low_impact_international_news_is_eligible_for_region_opt_in():
    # Region-specific preferences now let users opt into ordinary US/UK/Africa news.
    assert is_news_notification_eligible({"impact": "LOW", "country": "US"}) is True


def test_unclassified_low_impact_item_without_region_or_topic_is_not_eligible():
    assert is_news_notification_eligible({"impact": "LOW"}) is False


def test_nigeria_country_matching_is_case_insensitive():
    assert is_news_notification_eligible({"impact": "LOW", "country": "ng"}) is True
