"""On-demand RSS headline translation through MyMemory's public free API."""
from __future__ import annotations

import hashlib
import json
import os
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

_CACHE: dict[str, tuple[float, dict[str, str]]] = {}
_CACHE_TTL = 86400
_CACHE_MAX_ENTRIES = 1000
_MAX_TEXT = 1400
_MAX_CHUNK_BYTES = 450


def _prune_cache(now: float) -> None:
    """Remove expired entries and enforce a bounded, oldest-first cache."""
    expired = [key for key, (created_at, _) in _CACHE.items() if now - created_at >= _CACHE_TTL]
    for key in expired:
        _CACHE.pop(key, None)
    while len(_CACHE) > _CACHE_MAX_ENTRIES:
        _CACHE.pop(next(iter(_CACHE)))


def _chunks(text: str, limit: int = _MAX_CHUNK_BYTES) -> list[str]:
    """Split into UTF-8-safe chunks under MyMemory's q byte limit."""
    chunks: list[str] = []
    current = ""
    for sentence in text.splitlines() or [text]:
        parts = sentence.split(" ")
        for part in parts:
            candidate = (current + " " + part).strip()
            if len(candidate.encode("utf-8")) <= limit:
                current = candidate
                continue
            if current:
                chunks.append(current)
                current = ""
            encoded = part.encode("utf-8")
            while len(encoded) > limit:
                cut = encoded[:limit]
                while cut:
                    try:
                        piece = cut.decode("utf-8")
                        break
                    except UnicodeDecodeError:
                        cut = cut[:-1]
                chunks.append(piece)
                encoded = encoded[len(cut):]
            current = encoded.decode("utf-8")
    if current:
        chunks.append(current)
    return chunks


def _translate_chunk(text: str, source: str) -> str:
    params = {"q": text, "langpair": f"{source}|en"}
    contact = os.getenv("TRANSLATION_CONTACT_EMAIL", "").strip()
    if contact:
        params["de"] = contact
    request = Request(
        "https://api.mymemory.translated.net/get?" + urlencode(params),
        headers={"User-Agent": "TradeSight-News/1.0"},
    )
    # The free translation endpoint occasionally times out or returns transient
    # gateway/rate-limit errors. Retry only transient transport/provider failures;
    # permanent HTTP errors and provider quota responses should surface immediately.
    import logging
    logger = logging.getLogger(__name__)
    payload = None
    last_error = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=12) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except HTTPError as exc:
            last_error = exc
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                logger.warning("News translation provider HTTP failure status=%s attempt=%s", exc.code, attempt + 1)
                raise RuntimeError(
                    f"Translation provider returned HTTP {exc.code}; please try again later."
                ) from exc
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt == 2:
                logger.warning("News translation provider request failed after retries: %s", type(exc).__name__)
                raise RuntimeError(
                    "Translation provider is temporarily unavailable after retries. Please try again later."
                ) from exc
        if attempt < 2:
            time.sleep(0.5 * (attempt + 1))
    if payload is None:
        logger.warning("News translation provider returned no payload after retries: %s", type(last_error).__name__ if last_error else "unknown")
        raise RuntimeError("Translation provider returned no response. Please try again later.")
    if payload.get("responseStatus") != 200:
        detail = str(payload.get("responseDetails") or "Free translation quota may be exhausted.")
        raise RuntimeError(detail[:220])
    translated = payload.get("responseData", {}).get("translatedText")
    if not isinstance(translated, str) or not translated.strip():
        raise RuntimeError("Translation provider returned an empty translation.")
    return translated


def translate_news(title: str, summary: str, source_language: str = "autodetect") -> dict[str, str]:
    title = title.strip()
    summary = summary.strip()
    if not title or len(title) + len(summary) > _MAX_TEXT:
        raise ValueError(f"Headline and summary must total between 1 and {_MAX_TEXT} characters.")
    source = source_language.strip().lower()
    if source != "autodetect" and (len(source) not in (2, 5) or not source.replace("-", "").isalpha()):
        raise ValueError("Use a valid language code or autodetect.")
    cache_key = hashlib.sha256(f"{source}|{title}|{summary}".encode("utf-8")).hexdigest()
    now = time.time()
    _prune_cache(now)
    cached = _CACHE.get(cache_key)
    if cached and now - cached[0] < _CACHE_TTL:
        # Refresh insertion order so frequently reused translations are retained.
        _CACHE.pop(cache_key)
        _CACHE[cache_key] = cached
        return dict(cached[1])
    translated_title = " ".join(_translate_chunk(chunk, source) for chunk in _chunks(title))
    translated_summary = " ".join(_translate_chunk(chunk, source) for chunk in _chunks(summary)) if summary else ""
    result = {"title": translated_title, "summary": translated_summary, "source_language": source}
    _CACHE[cache_key] = (now, result)
    _prune_cache(now)
    return result
