import time

from fastapi.testclient import TestClient

from app import fundamentals, opportunity_news
from app.main import app


client = TestClient(app)


def test_fundamental_news_uses_one_minute_cache_and_supports_forced_refresh(monkeypatch):
    calls = []
    monkeypatch.setattr(fundamentals, "FEEDS", (("Test", "https://example.com/rss", "macro", "US"),))
    monkeypatch.setattr(
        fundamentals,
        "_fetch_feed",
        lambda *feed: (calls.append(feed) or [], {"source": "Test", "status": "LIVE", "count": 0, "error": None}),
    )
    monkeypatch.setattr(
        fundamentals,
        "_cache",
        {"fetched_at": 0.0, "items": [], "feed_status": []},
    )

    first = fundamentals.get_fundamental_news()
    second = fundamentals.get_fundamental_news()
    forced = fundamentals.get_fundamental_news(force_refresh=True)

    assert first["cache_seconds"] == 60
    assert second["updated_at"] == first["updated_at"]
    assert forced["updated_at"] >= first["updated_at"]
    assert len(calls) == 2


def test_opportunity_news_uses_one_minute_cache_and_supports_forced_refresh(monkeypatch):
    calls = []
    monkeypatch.setattr(opportunity_news, "FEEDS", (("Test", "https://example.com/rss", "TECH"),))
    monkeypatch.setattr(
        opportunity_news,
        "_fetch",
        lambda *feed: (calls.append(feed) or [], {"source": "Test", "status": "LIVE", "count": 0, "error": None}),
    )
    monkeypatch.setattr(
        opportunity_news,
        "_cache",
        {"fetched_at": 0.0, "items": [], "feeds": []},
    )

    first = opportunity_news.get_opportunity_news()
    second = opportunity_news.get_opportunity_news()
    forced = opportunity_news.get_opportunity_news(force_refresh=True)

    assert first["cache_seconds"] == 60
    assert second["updated_at"] == first["updated_at"]
    assert forced["updated_at"] >= first["updated_at"]
    assert len(calls) == 2


def test_news_endpoints_forward_manual_refresh_to_cache(monkeypatch):
    from app import main

    seen = {}
    monkeypatch.setattr(
        main,
        "get_fundamental_news",
        lambda **kwargs: seen.update(fundamentals=kwargs) or {"status": "LIVE", "items": []},
    )
    monkeypatch.setattr(
        main,
        "get_opportunity_news",
        lambda **kwargs: seen.update(opportunities=kwargs) or {"status": "LIVE", "items": []},
    )

    assert client.get("/api/v1/fundamentals/news?refresh=true").status_code == 200
    assert client.get("/api/v1/opportunities/news?refresh=true").status_code == 200
    assert seen["fundamentals"]["force_refresh"] is True
    assert seen["opportunities"]["force_refresh"] is True



def test_fundamental_news_refreshes_after_cache_expiry(monkeypatch):
    calls = []
    monkeypatch.setattr(fundamentals, "FEEDS", (("Test", "https://example.com/rss", "macro", "US"),))
    monkeypatch.setattr(
        fundamentals,
        "_fetch_feed",
        lambda *feed: (calls.append(feed) or [], {"source": "Test", "status": "LIVE", "count": 0, "error": None}),
    )
    monkeypatch.setattr(
        fundamentals,
        "_cache",
        {"fetched_at": time.time() - 61, "items": [], "feed_status": []},
    )

    fundamentals.get_fundamental_news()

    assert len(calls) == 1


def test_opportunity_news_refreshes_after_cache_expiry(monkeypatch):
    calls = []
    monkeypatch.setattr(opportunity_news, "FEEDS", (("Test", "https://example.com/rss", "TECH"),))
    monkeypatch.setattr(
        opportunity_news,
        "_fetch",
        lambda *feed: (calls.append(feed) or [], {"source": "Test", "status": "LIVE", "count": 0, "error": None}),
    )
    monkeypatch.setattr(
        opportunity_news,
        "_cache",
        {"fetched_at": time.time() - 61, "items": [], "feeds": []},
    )

    opportunity_news.get_opportunity_news()

    assert len(calls) == 1


def test_opportunity_news_background_monitor_uses_one_minute_cadence():
    assert opportunity_news.MONITOR_INTERVAL_SECONDS == 60


def test_fundamental_news_notifications_are_checked_each_recorder_cycle():
    from app import setup_recorder

    assert setup_recorder.POLL_SECONDS == 60
    assert "news_every" not in setup_recorder._run.__code__.co_names


def test_opportunity_news_has_multiple_independent_sources_per_category():
    sources = {}
    for name, url, category in opportunity_news.FEEDS:
        sources.setdefault(category, set()).add(name)

    assert len(sources["TECH"]) >= 4
    assert len(sources["WEB"]) >= 3
    assert len(sources["AI"]) >= 4
    assert "OpenAI News" in sources["AI"]
    assert "Google DeepMind" in sources["AI"]
    assert "Hugging Face Blog" in sources["AI"]
    assert len(sources["JOBS"]) >= 7
    assert "Remotive" in sources["JOBS"]
    assert "Jobicy" in sources["JOBS"]
    assert "Himalayas" in sources["JOBS"]
    assert "RemoteFirstJobs · Python" in sources["JOBS"]
    assert "We Work Remotely · All Jobs" in sources["JOBS"]
