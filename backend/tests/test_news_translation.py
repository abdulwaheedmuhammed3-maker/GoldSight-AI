from app import news_translation


def test_translate_news_translates_title_and_summary_and_caches(monkeypatch):
    calls = []
    monkeypatch.setattr(news_translation, "_CACHE", {})
    monkeypatch.setattr(news_translation, "_translate_chunk", lambda text, source: calls.append((text, source)) or f"EN:{text}")
    result = news_translation.translate_news("Bonjour", "Le marché monte", "fr")
    assert result == {"title": "EN:Bonjour", "summary": "EN:Le marché monte", "source_language": "fr"}
    assert len(calls) == 2
    news_translation.translate_news("Bonjour", "Le marché monte", "fr")
    assert len(calls) == 2


def test_translate_news_rejects_empty_or_overlong_input():
    import pytest
    with pytest.raises(ValueError):
        news_translation.translate_news(" ", "")
    with pytest.raises(ValueError):
        news_translation.translate_news("a" * 700, "b" * 701)


def test_chunks_respect_utf8_byte_limit():
    chunks = news_translation._chunks("€" * 500)
    assert all(len(chunk.encode("utf-8")) <= 450 for chunk in chunks)
    assert "".join(chunks) == "€" * 500


def test_translation_cache_removes_expired_entries(monkeypatch):
    monkeypatch.setattr(news_translation, "_CACHE", {
        "old": (0, {"title": "old", "summary": "", "source_language": "fr"}),
        "fresh": (95, {"title": "fresh", "summary": "", "source_language": "fr"}),
    })
    monkeypatch.setattr(news_translation, "_CACHE_TTL", 10)
    news_translation._prune_cache(100)
    assert list(news_translation._CACHE) == ["fresh"]


def test_translation_cache_enforces_entry_limit(monkeypatch):
    calls = []
    monkeypatch.setattr(news_translation, "_CACHE", {})
    monkeypatch.setattr(news_translation, "_CACHE_MAX_ENTRIES", 2)
    monkeypatch.setattr(news_translation, "_translate_chunk", lambda text, source: calls.append(text) or f"EN:{text}")
    news_translation.translate_news("first", "", "fr")
    news_translation.translate_news("second", "", "fr")
    news_translation.translate_news("third", "", "fr")
    assert len(news_translation._CACHE) == 2
    news_translation.translate_news("first", "", "fr")
    assert calls == ["first", "second", "third", "first"]

def test_translate_chunk_retries_transient_network_failures(monkeypatch):
    import json
    from urllib.error import URLError

    attempts = []
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self):
            return json.dumps({
                "responseStatus": 200,
                "responseData": {"translatedText": "Hello"},
            }).encode("utf-8")

    def fake_urlopen(request, timeout):
        attempts.append(timeout)
        if len(attempts) < 3:
            raise URLError("temporary network failure")
        return Response()

    monkeypatch.setattr(news_translation, "urlopen", fake_urlopen)
    monkeypatch.setattr(news_translation.time, "sleep", lambda _: None)
    assert news_translation._translate_chunk("Bonjour", "fr") == "Hello"
    assert attempts == [12, 12, 12]


def test_translate_chunk_reports_provider_http_error_without_retry(monkeypatch):
    import pytest
    from urllib.error import HTTPError
    monkeypatch.setattr(
        news_translation,
        "urlopen",
        lambda request, timeout: (_ for _ in ()).throw(
            HTTPError("https://api.mymemory.translated.net/get", 400, "Bad Request", {}, None)
        ),
    )
    monkeypatch.setattr(news_translation.time, "sleep", lambda _: None)
    with pytest.raises(RuntimeError, match="HTTP 400"):
        news_translation._translate_chunk("Bonjour", "fr")
