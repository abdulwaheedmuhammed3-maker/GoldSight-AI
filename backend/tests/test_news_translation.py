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
