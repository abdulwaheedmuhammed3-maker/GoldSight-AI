"""Small, transparent RSS-based fundamental news aggregator.

Only whitelisted public feeds are fetched. Headlines remain linked to publishers;
keyword matching is relevance triage, not a market-direction prediction.
"""
from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

FEEDS = (
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", "macro", "US"),
    ("US Bureau of Labor Statistics", "https://www.bls.gov/feed/bls_latest.rss", "macro", "US"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "crypto", "GLOBAL"),
    ("Nairametrics", "https://nairametrics.com/feed/", "nigeria", "NG"),
    ("BusinessDay Nigeria", "https://businessday.ng/feed/", "nigeria", "NG"),
)
CACHE_SECONDS = 300
_cache: dict[str, object] = {"fetched_at": 0.0, "items": [], "feed_status": []}


def _text(node: ET.Element, names: tuple[str, ...]) -> str:
    for child in node.iter():
        if child.tag.rsplit("}", 1)[-1].lower() in names and child.text:
            return child.text.strip()
    return ""


def _parse_date(raw: str) -> str | None:
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError):
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError, OverflowError):
            return None


def _classify(title: str, summary: str, feed_kind: str) -> tuple[list[str], str]:
    text = f"{title} {summary}".lower()
    assets: list[str] = []
    if feed_kind == "crypto" or any(k in text for k in ("bitcoin", "crypto", "digital asset", "cryptocurrency", "etf")):
        assets.append("BTCUSD")
    if feed_kind == "macro" or any(k in text for k in ("gold", "bullion", "treasury yield", "federal reserve", "inflation", "payroll", "interest rate", "dollar")):
        assets.append("XAUUSD")
    if any(k in text for k in ("rate decision", "fomc", "consumer price", "cpi", "employment situation", "nonfarm", "inflation", "emergency", "sanction", "war")):
        impact = "HIGH"
    elif any(k in text for k in ("interest rate", "federal reserve", "treasury", "jobs", "bitcoin", "etf", "gold", "gdp")):
        impact = "MEDIUM"
    else:
        impact = "LOW"
    return list(dict.fromkeys(assets)), impact


def _clean_summary(value: str, max_length: int = 320) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:max_length] + ("…" if len(value) > max_length else "")


def _fetch_feed(name: str, url: str, kind: str, country: str) -> tuple[list[dict], dict]:
    request = urllib.request.Request(url, headers={"User-Agent": "GoldSightAI/1.0 (+fundamental-news-feed)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = response.read(1_500_000)
        root = ET.fromstring(payload)
        items = []
        for node in root.iter():
            tag = node.tag.rsplit("}", 1)[-1].lower()
            if tag not in ("item", "entry"):
                continue
            title = _text(node, ("title",))
            link = _text(node, ("link",))
            if not link:
                for child in node:
                    if child.tag.rsplit("}", 1)[-1].lower() == "link":
                        link = child.attrib.get("href", "")
                        if link:
                            break
            if not title or not link.startswith("https://"):
                continue
            summary = _clean_summary(_text(node, ("description", "summary", "encoded", "content")))
            published = _parse_date(_text(node, ("pubdate", "published", "updated", "date")))
            assets, impact = _classify(title, summary, kind)
            items.append({
                "id": f"{name}:{link}", "title": _clean_summary(title, 240),
                "summary": summary, "url": link, "source": name,
                "published_at": published, "assets": assets,
                "impact": impact, "country": country,
                "interpretation": "Context only. Verify the full source and compare with price action; headline keywords do not establish market direction.",
            })
        return items, {"source": name, "status": "LIVE", "count": len(items), "error": None}
    except (OSError, TimeoutError, ET.ParseError, urllib.error.URLError, ValueError) as exc:
        return [], {"source": name, "status": "OFFLINE", "count": 0, "error": str(exc)[:180]}


def get_fundamental_news(limit: int = 30, force_refresh: bool = False) -> dict:
    now = time.time()
    if not force_refresh and now - float(_cache["fetched_at"]) < CACHE_SECONDS:
        items = list(_cache["items"])
        statuses = list(_cache["feed_status"])
    else:
        items: list[dict] = []
        statuses: list[dict] = []
        for name, url, kind, country in FEEDS:
            feed_items, status = _fetch_feed(name, url, kind, country)
            items.extend(feed_items)
            statuses.append(status)
        # Deduplicate by canonical URL, then newest publication time first.
        deduped = {item["url"].split("#", 1)[0].rstrip("/"): item for item in items}
        items = list(deduped.values())
        items.sort(key=lambda item: item.get("published_at") or "", reverse=True)
        _cache.update({"fetched_at": now, "items": items, "feed_status": statuses})
    return {
        "status": "LIVE" if items else "OFFLINE",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "cache_seconds": CACHE_SECONDS,
        "count": min(len(items), limit),
        "items": items[:limit],
        "feeds": statuses,
        "note": "Curated public RSS headlines, not a complete economic calendar. Official releases can be delayed or unavailable. No headline-only directional trading signals are generated.",
    }


def classify_trade_context(symbol: str, signal: dict, window_minutes: int = 30) -> dict:
    """Associate a confirmed setup with a recent, asset-relevant high-impact headline.

    The time match is evidence of association only, not proof of causation. The
    RSS collection is not a complete economic calendar.
    """
    from datetime import datetime, timezone

    if signal.get("status") not in {"BUY", "SELL"}:
        return {"trade_type": "NO TRADE", "news_context": None, "news_context_status": "NO_ACTIVE_SETUP"}

    try:
        signal_time = datetime.fromisoformat(str(signal.get("signal_time") or "").replace("Z", "+00:00"))
        if signal_time.tzinfo is None:
            signal_time = signal_time.replace(tzinfo=timezone.utc)
        signal_time = signal_time.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return {
            "trade_type": "TECHNICAL TRADE", "news_context": None,
            "news_context_status": "SIGNAL_TIME_UNAVAILABLE",
            "news_context_note": "No usable signal timestamp; news association could not be checked.",
        }

    feed = get_fundamental_news(limit=100)
    if feed.get("status") != "LIVE" or not feed.get("items"):
        return {
            "trade_type": "TECHNICAL TRADE", "news_context": None,
            "news_context_status": "UNAVAILABLE",
            "news_context_note": "News feed unavailable; this does not confirm that no relevant event occurred.",
        }

    matches = []
    for item in feed.get("items", []):
        if symbol not in item.get("assets", []) or item.get("impact") != "HIGH":
            continue
        try:
            published = datetime.fromisoformat(str(item.get("published_at") or "").replace("Z", "+00:00"))
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
            published = published.astimezone(timezone.utc)
        except (TypeError, ValueError):
            continue
        age_seconds = (signal_time - published).total_seconds()
        if 0 <= age_seconds <= window_minutes * 60:
            matches.append((age_seconds, item))

    if not matches:
        return {
            "trade_type": "TECHNICAL TRADE", "news_context": None,
            "news_context_status": "NO_MATCHING_HEADLINE",
            "news_context_note": "No matching high-impact headline was found in the available RSS feed; this does not prove no event occurred.",
        }

    age_seconds, item = min(matches, key=lambda match: match[0])
    return {
        "trade_type": "NEWS TRADE",
        "news_context": {
            "id": item.get("id"), "title": item.get("title"), "url": item.get("url"),
            "source": item.get("source"), "published_at": item.get("published_at"),
            "impact": item.get("impact"), "asset": symbol,
            "minutes_before_signal": round(age_seconds / 60, 1),
            "causality_confirmed": False,
        },
        "news_context_status": "MATCHED_HIGH_IMPACT_HEADLINE",
        "news_context_note": f"A relevant high-impact headline was published within {window_minutes} minutes before this signal. Timing indicates association, not causation.",
    }
