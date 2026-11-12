"""Small, transparent RSS-based fundamental news aggregator.

Only whitelisted public feeds are fetched. Headlines remain linked to publishers;
keyword matching is relevance triage, not a market-direction prediction.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import re
import time
from threading import Lock
import urllib.error
import urllib.request
from urllib.parse import quote, urlparse
import xml.etree.ElementTree as ET

FEEDS = (
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", "macro", "US"),
    ("BBC Business Economy", "https://feeds.bbci.co.uk/news/business/economy/rss.xml", "macro", "GLOBAL"),
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml", "world", "GLOBAL"),
    ("BBC Africa", "https://feeds.bbci.co.uk/news/world/africa/rss.xml", "africa", "AF"),
    ("Africanews", "https://www.africanews.com/feed/rss", "africa", "AF"),
    ("The East African", "https://www.theeastafrican.co.ke/service/rss/tea/1289142/feed.rss", "africa", "KE"),
    ("Daily Maverick", "https://www.dailymaverick.co.za/dmrss/", "africa", "ZA"),
    ("Citi Newsroom Ghana", "https://citinewsroom.com/feed/", "africa", "GH"),
    ("MyJoyOnline Ghana", "https://www.myjoyonline.com/feed/", "africa", "GH"),
    ("Graphic Online Ghana", "https://www.graphic.com.gh/news/?service=rss", "africa", "GH"),
    ("Ahram Online Egypt", "https://english.ahram.org.eg/RSS/News.aspx", "africa", "EG"),
    ("Hespress English Morocco", "https://en.hespress.com/feed", "africa", "MA"),
    ("Nation Africa Kenya", "https://nation.africa/kenya/rss", "africa", "KE"),
    ("The Standard Kenya", "https://www.standardmedia.co.ke/rss/kenya.php", "africa", "KE"),
    ("News24 South Africa", "https://feeds.news24.com/articles/news24/TopStories/rss", "africa", "ZA"),
    # Core Alliance of Sahel States (AES): Mali, Burkina Faso and Niger.
    ("Maliweb Mali", "https://www.maliweb.net/feed/", "africa", "ML"),
    ("Bamada Mali", "https://bamada.net/feed", "africa", "ML"),
    ("RFI Mali", "https://www.rfi.fr/fr/tag/mali/rss", "africa", "ML"),
    ("Burkina24", "https://burkina24.com/feed/", "africa", "BF"),
    ("Sidwaya Burkina Faso", "https://www.sidwaya.info/feed/", "africa", "BF"),
    ("RFI Burkina Faso", "https://www.rfi.fr/fr/tag/burkina-faso/rss", "africa", "BF"),
    ("Journal du Niger", "https://www.journalduniger.com/feed/", "africa", "NE"),
    ("ActuNiger", "https://www.actuniger.com/feed", "africa", "NE"),
    ("RFI Niger", "https://www.rfi.fr/fr/tag/niger/rss", "africa", "NE"),
    # VOA Afrique publishes dedicated country feeds (French-language).
    ("VOA Afrique Benin (French)", "https://www.voaafrique.com/api/zuy_qql-vomx-tpegrtqi", "africa", "BJ"),
    ("VOA Afrique Cameroon (French)", "https://www.voaafrique.com/api/zgy_qil-vomx-tpe-rtqm", "africa", "CM"),
    ("VOA Afrique Côte d'Ivoire (French)", "https://www.voaafrique.com/api/zqv_qtl-vomx-tpeiqtqr", "africa", "CI"),
    ("VOA Afrique Rwanda (French)", "https://www.voaafrique.com/api/z-v_qil-vomx-tperotqm", "africa", "RW"),
    ("VOA Afrique Senegal (French)", "https://www.voaafrique.com/api/zbv_qpl-vomx-tpeqotq_", "africa", "SN"),
    ("VOA Afrique Chad (French)", "https://www.voaafrique.com/api/zqt_q_l-vomx-tpeiotqv", "africa", "TD"),
    ("VOA Afrique Togo (French)", "https://www.voaafrique.com/api/zot_qyl-vomx-tpepotqt", "africa", "TG"),
    ("VOA Afrique Algeria (French)", "https://www.voaafrique.com/api/z-t_qql-vomx-tperitqo", "africa", "DZ"),
    ("VOA Afrique Tunisia (French)", "https://www.voaafrique.com/api/zit_qvl-vomx-tpemotqr", "africa", "TN"),
    ("VOA Afrique Burundi (French)", "https://www.voaafrique.com/api/zky_qol-vomx-tpejrtqp", "africa", "BI"),
    ("VOA Afrique DR Congo (French)", "https://www.voaafrique.com/api/z_jk_l-vomx-tpev_-m", "africa", "CD"),
    # Additional independent desks for the Horn of Africa and Great Lakes region.
    ("The Reporter Ethiopia", "https://www.thereporterethiopia.com/feed/", "africa", "ET"),
    ("Ethiopia Insight", "https://www.ethiopia-insight.com/feed/", "africa", "ET"),
    ("Radio Tamazuj South Sudan", "https://www.radiotamazuj.org/en/feed", "africa", "SS"),
    ("Dabanga Sudan", "https://www.dabangasudan.org/en/feed", "africa", "SD"),
    ("Actualite.cd DR Congo (French)", "https://actualite.cd/feed", "africa", "CD"),
    ("Radio Okapi DR Congo (French)", "https://www.radiookapi.net/rss.xml", "africa", "CD"),
    ("Le Quotidien Senegal (French)", "https://lequotidien.sn/feed/", "africa", "SN"),
    # Dedicated country feeds for Central Africa and the western Indian Ocean.
    ("VOA Afrique Central African Republic (French)", "https://www.voaafrique.com/api/z-y_qml-vomx-tperqtqy", "africa", "CF"),
    ("RFI Central African Republic (French)", "https://www.rfi.fr/fr/tag/centrafrique/rss", "africa", "CF"),
    ("VOA Afrique Comoros (French)", "https://www.voaafrique.com/api/zby_q_l-vomx-tpeqqtqv", "africa", "KM"),
    ("RFI Comoros (French)", "https://www.rfi.fr/fr/tag/comores/rss", "africa", "KM"),
    ("VOA Afrique Djibouti (French)", "https://www.voaafrique.com/api/zov_qrl-vomx-tpepqtqo", "africa", "DJ"),
    ("RFI Djibouti (French)", "https://www.rfi.fr/fr/tag/djibouti/rss", "africa", "DJ"),
    ("VOA Afrique Gabon (French)", "https://www.voaafrique.com/api/zpv_qol-vomx-tpe_qtqp", "africa", "GA"),
    ("RFI Gabon (French)", "https://www.rfi.fr/fr/tag/gabon/rss", "africa", "GA"),
    # RSF country feeds for additional underrepresented African countries.
    ("RSF Angola", "https://rsf.org/fr/rss/afrique/angola/feed.xml", "africa", "AO"),
    ("RSF Botswana", "https://rsf.org/fr/rss/afrique/botswana/feed.xml", "africa", "BW"),
    ("RSF Cabo Verde", "https://rsf.org/fr/rss/afrique/cap-vert/feed.xml", "africa", "CV"),
    ("RSF Republic of the Congo", "https://rsf.org/fr/rss/afrique/congo-brazzaville/feed.xml", "africa", "CG"),
    ("RSF Equatorial Guinea", "https://rsf.org/fr/rss/afrique/guin%C3%A9e-%C3%A9quatoriale/feed.xml", "africa", "GQ"),
    ("RSF Eritrea", "https://rsf.org/fr/rss/afrique/%C3%A9rythr%C3%A9e/feed.xml", "africa", "ER"),
    ("RSF Eswatini", "https://rsf.org/fr/rss/afrique/eswatini/feed.xml", "africa", "SZ"),
    ("RSF Gambia", "https://rsf.org/fr/rss/afrique/gambie/feed.xml", "africa", "GM"),
    ("RSF Guinea-Bissau", "https://rsf.org/fr/rss/afrique/guin%C3%A9e-bissau/feed.xml", "africa", "GW"),
    ("RSF Lesotho", "https://rsf.org/fr/rss/afrique/lesotho/feed.xml", "africa", "LS"),
    ("RSF Nigeria", "https://rsf.org/fr/rss/afrique/nigeria/feed.xml", "africa", "NG"),
    ("RSF Seychelles", "https://rsf.org/fr/rss/afrique/seychelles/feed.xml", "africa", "SC"),
    ("RSF Somalia", "https://rsf.org/fr/rss/afrique/somalie/feed.xml", "africa", "SO"),
    # West Africa and Indian Ocean country desks.
    ("Guineematin Guinea (French)", "https://guineematin.com/feed", "africa", "GN"),
    ("Guineenews Guinea (French)", "https://guineenews.org/feed/", "africa", "GN"),
    ("RFI Libya (French)", "https://www.rfi.fr/fr/tag/libye/rss", "africa", "LY"),
    ("Libya Herald Economy (English)", "https://libyaherald.com/rss/economy-policy", "africa", "LY"),
    ("L Express de Madagascar (French)", "https://www.lexpress.mg/feeds/posts/default?alt=rss", "africa", "MG"),
    ("RFI Liberia (French)", "https://www.rfi.fr/fr/tag/liberia/rss", "africa", "LR"),
    ("RFI Sierra Leone (French)", "https://www.rfi.fr/fr/tag/sierra-leone/rss", "africa", "SL"),
    # Additional publisher desks in East and Southern Africa.
    ("The Citizen Tanzania", "https://www.thecitizen.co.tz/tanzania/rss", "africa", "TZ"),
    ("TanzaniaInvest", "https://tanzaniainvest.com/feed", "africa", "TZ"),
    ("Daily Monitor Uganda", "https://www.monitor.co.ug/uganda/rss", "africa", "UG"),
    ("Malawi24", "https://malawi24.com/feed/", "africa", "MW"),
    ("Lusaka Times Zambia", "https://www.lusakatimes.com/feed/", "africa", "ZM"),
    ("Club of Mozambique", "https://clubofmozambique.com/feed/", "africa", "MZ"),
    ("The Namibian", "https://www.namibian.com.na/rss/", "africa", "NA"),
    ("The Herald Zimbabwe", "https://www.herald.co.zw/feed/", "africa", "ZW"),
    # Dedicated feeds for the remaining African country coverage gaps.
    ("Kassataya Mauritania (French)", "https://kassataya.com/feed", "africa", "MR"),
    ("Sahara Media Mauritania", "https://saharamedias.net/feed", "africa", "MR"),
    ("Inside News Mauritius", "https://inside.news/feed/", "africa", "MU"),
    ("ION News Mauritius", "https://ionnews.mu/feed/", "africa", "MU"),
    ("Téla Nón São Tomé and Príncipe (Portuguese)", "https://www.telanon.info/feed/", "africa", "ST"),
    ("BBC Football", "https://feeds.bbci.co.uk/sport/football/rss.xml", "football", "GLOBAL"),
    ("US Bureau of Labor Statistics", "https://www.bls.gov/feed/bls_latest.rss", "macro", "US"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "crypto", "GLOBAL"),
    ("Nairametrics", "https://nairametrics.com/feed/", "nigeria", "NG"),
    # NTA has no verified public RSS endpoint; use Google News RSS scoped to NTA's official news domain.
    ("NTA Nigeria", "https://news.google.com/rss/search?q=site%3Awww.nta.ng%2Fnews&hl=en-NG&gl=NG&ceid=NG%3Aen", "nigeria", "NG"),
    ("BusinessDay Nigeria", "https://businessday.ng/feed/", "nigeria", "NG"),
    ("Central Bank of Nigeria", "https://www.cbn.gov.ng/News/rss", "macro", "NG"),
    ("Bank of England", "https://www.bankofengland.co.uk/rss/news", "macro", "GB"),
    ("European Central Bank", "https://www.ecb.europa.eu/rss/press.html", "macro", "EU"),
)
CACHE_SECONDS = 60
_cache: dict[str, object] = {"fetched_at": 0.0, "items": [], "feed_status": []}
_cache_lock = Lock()


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


def _headline_language(source: str, url: str, title: str, summary: str) -> str:
    """Identify non-English RSS items so English headlines need no translation UI."""
    source_url = f"{source} {url}".casefold()
    if (
        "(french)" in source_url or "rfi.fr/fr/" in source_url
        or "rsf.org/fr/" in source_url
        or any(name in source_url for name in (
            "actualite.cd", "radio okapi", "le quotidien", "guineematin",
            "guineenews", "kassataya", "maliweb.net", "burkina24.com",
            "sidwaya.info", "lexpress.mg",
        ))
    ):
        return "fr"
    if "(portuguese)" in source_url or "telanon.info" in source_url:
        return "pt"

    text = f"{title} {summary}"
    if re.search(r"[\u0600-\u06ff]", text):
        return "ar"
    if re.search(r"[\u0400-\u04ff]", text):
        return "ru"
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    if re.search(r"[\u0900-\u097f]", text):
        return "hi"
    if re.search(r"[\u1200-\u137f]", text):
        return "am"
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", text):
        return "ko"

    words = re.findall(r"[^\W\d_]+", text.casefold(), flags=re.UNICODE)
    language_markers = {
        "fr": {"les", "des", "une", "pour", "avec", "dans", "est", "et", "sur", "qui", "pas", "après", "selon", "mais"},
        "pt": {"uma", "para", "com", "dos", "das", "não", "por", "mais", "está", "sobre", "que"},
        "es": {"los", "las", "una", "para", "con", "del", "por", "más", "está", "según", "pero", "que"},
        "sw": {"katika", "hii", "hizi", "kwa", "kutoka", "baada", "kuwa", "zaidi", "vya", "ambayo"},
        "so": {"ayaa", "waxaa", "waxa", "iyo", "ka", "ku", "loo", "wuxuu", "waxay", "inay"},
    }
    scores = {language: sum(word in markers for word in words) for language, markers in language_markers.items()}
    language, score = max(scores.items(), key=lambda item: item[1])
    return language if score >= 2 else "en"


def _extract_image(node: ET.Element, article_url: str) -> str | None:
    """Read a real article image from common RSS/Atom media fields."""
    for child in node.iter():
        tag = child.tag.rsplit("}", 1)[-1].lower()
        candidate = child.attrib.get("url") or child.attrib.get("href")
        media_type = child.attrib.get("type", "").lower()
        if not candidate or not candidate.startswith("https://"):
            continue
        if tag in {"thumbnail", "content", "image"} and (tag != "content" or media_type.startswith("image/") or re.search(r"\.(?:jpe?g|png|webp|gif)(?:[?#]|$)", candidate, re.I)):
            return candidate
        if tag == "enclosure" and (media_type.startswith("image/") or re.search(r"\.(?:jpe?g|png|webp|gif)(?:[?#]|$)", candidate, re.I)):
            return candidate
    html_blob = _text(node, ("description", "summary", "encoded", "content"))
    match = re.search(r"""<img[^>]+(?:src|data-src)=["']([^"']+)""", html_blob, re.I)
    if match and match.group(1).startswith("https://"):
        return match.group(1)
    return None


def _source_image(url: str) -> str:
    domain = urlparse(url).hostname or "news"
    return f"https://www.google.com/s2/favicons?domain={quote(domain)}&sz=256"



# Broad Africa feeds stay regional unless exactly one country is explicitly named.
_AFRICAN_COUNTRY_ALIASES = {
    "DZ": ("Algeria",), "AO": ("Angola",), "BJ": ("Benin",), "BW": ("Botswana",),
    "BF": ("Burkina Faso",), "BI": ("Burundi",), "CV": ("Cabo Verde", "Cape Verde"),
    "CM": ("Cameroon",), "CF": ("Central African Republic",), "TD": ("Chad",),
    "KM": ("Comoros",), "CG": ("Republic of the Congo", "Congo-Brazzaville", "Congo Brazzaville"),
    "CD": ("Democratic Republic of the Congo", "DR Congo", "DRC", "Congo-Kinshasa", "Congo Kinshasa"),
    "CI": ("Côte d'Ivoire", "Côte d’Ivoire", "Ivory Coast"), "DJ": ("Djibouti",),
    "EG": ("Egypt",), "GQ": ("Equatorial Guinea",), "ER": ("Eritrea",),
    "SZ": ("Eswatini", "Swaziland"), "ET": ("Ethiopia",), "GA": ("Gabon",),
    "GM": ("The Gambia", "Gambia"), "GH": ("Ghana",), "GN": ("Guinea",),
    "GW": ("Guinea-Bissau", "Guinea Bissau"), "KE": ("Kenya",), "LS": ("Lesotho",),
    "LR": ("Liberia",), "LY": ("Libya",), "MG": ("Madagascar",), "MW": ("Malawi",),
    "ML": ("Mali",), "MR": ("Mauritania",), "MU": ("Mauritius",), "MA": ("Morocco",),
    "MZ": ("Mozambique",), "NA": ("Namibia",), "NE": ("Niger",), "NG": ("Nigeria",),
    "RW": ("Rwanda",), "ST": ("São Tomé and Príncipe", "Sao Tome and Principe"),
    "SN": ("Senegal",), "SC": ("Seychelles",), "SL": ("Sierra Leone",),
    "SO": ("Somalia",), "ZA": ("South Africa",), "SS": ("South Sudan",),
    "SD": ("Sudan",), "TZ": ("Tanzania",), "TG": ("Togo",), "TN": ("Tunisia",),
    "UG": ("Uganda",), "ZM": ("Zambia",), "ZW": ("Zimbabwe",),
}

def _infer_african_country(title: str, summary: str) -> str:
    """Return a country code only for one explicit, unambiguous country mention."""
    text = f"{title} {summary}".casefold()
    matches = set()
    for code, aliases in _AFRICAN_COUNTRY_ALIASES.items():
        for alias in aliases:
            if re.search(rf"(?<!\w){re.escape(alias.casefold())}(?!\w)", text):
                matches.add(code)
                break
    if "niger river" in text:
        matches.discard("NE")
    return next(iter(matches)) if len(matches) == 1 else "AF"

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
            image_url = _extract_image(node, link)
            published = _parse_date(_text(node, ("pubdate", "published", "updated", "date")))
            assets, impact = _classify(title, summary, kind)
            language = _headline_language(name, link, title, summary)
            item_country = _infer_african_country(title, summary) if country == "AF" and kind == "africa" else country
            topic = "football" if kind == "football" else ("economic" if kind == "macro" or any(word in f"{title} {summary}".lower() for word in ("inflation", "interest rate", "gdp", "central bank", "economy", "economic", "jobs", "unemployment", "budget", "trade deficit")) else "general")
            items.append({
                "id": f"{name}:{link}", "title": _clean_summary(title, 240),
                "summary": summary, "url": link, "source": name,
                "language": language,
                "image_url": image_url, "source_image_url": _source_image(link),
                "published_at": published, "assets": assets,
                "impact": impact, "country": item_country, "topic": topic,
                "income_relevance": "INCOME" if any(k in f"{title} {summary}".lower() for k in ("dividend", "earnings", "yield", "profit", "cash flow", "interest rate", "bond")) else "GENERAL",
                "interpretation": "Context only. Verify the full source and compare with price action; headline keywords do not establish market direction.",
            })
        recent_items = [item for item in items if _is_within_news_retention(item)]
        published_dates = [item["published_at"] for item in items if item.get("published_at")]
        return items, {
            "source": name, "kind": kind, "country": country,
            "status": "LIVE" if items else "EMPTY",
            "count": len(items),
            "fetched_item_count": len(items),
            "recent_headline_count": len(recent_items),
            "latest_published_at": max(published_dates) if published_dates else None,
            "error": None,
        }
    except (OSError, TimeoutError, ET.ParseError, urllib.error.URLError, ValueError) as exc:
        return [], {"source": name, "kind": kind, "country": country, "status": "OFFLINE", "count": 0, "error": str(exc)[:180]}


def _is_within_news_retention(item: dict, now: datetime | None = None) -> bool:
    """Keep only verifiably published headlines from the trailing 24 hours."""
    raw = item.get("published_at")
    if not raw:
        return False
    try:
        published = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        published = published.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return False
    current = now or datetime.now(timezone.utc)
    age_seconds = (current.astimezone(timezone.utc) - published).total_seconds()
    return 0 <= age_seconds < 24 * 60 * 60


def get_fundamental_news(limit: int | None = 30, force_refresh: bool = False) -> dict:
    # Capture the version before waiting for the lock. Concurrent forced refreshes
    # can then share the first completed fetch instead of hitting every publisher.
    observed_fetched_at = float(_cache["fetched_at"])
    with _cache_lock:
        cached_at = float(_cache["fetched_at"])
        should_use_cache = (
            now_is_fresh(cached_at)
            if not force_refresh
            else cached_at > observed_fetched_at
        )
        if should_use_cache:
            items = list(_cache["items"])
            statuses = list(_cache["feed_status"])
        else:
            # Fetch feeds concurrently: a slow publisher should not make the
            # one-minute refresh cycle take the sum of all publisher timeouts.
            with ThreadPoolExecutor(max_workers=min(8, len(FEEDS))) as pool:
                results = list(pool.map(lambda feed: _fetch_feed(*feed), FEEDS))
            items = []
            statuses = []
            for feed_items, status in results:
                items.extend(feed_items)
                statuses.append(status)
            deduped = {item["url"].split("#", 1)[0].rstrip("/"): item for item in items}
            items = list(deduped.values())
            items.sort(key=lambda item: item.get("published_at") or "", reverse=True)
            fetched_at = time.time()
            _cache.update({"fetched_at": fetched_at, "items": items, "feed_status": statuses})

    items = [item for item in items if _is_within_news_retention(item)]
    africa_feed_health = {}
    for feed in statuses:
        if feed.get("kind") != "africa" or feed.get("country") in {None, "AF", "GLOBAL"}:
            continue
        code = feed["country"]
        country_health = africa_feed_health.setdefault(code, {
            "configured_feed_count": 0, "live_feed_count": 0,
            "empty_feed_count": 0, "offline_feed_count": 0,
            "recent_headline_count": 0,
        })
        country_health["configured_feed_count"] += 1
        state = feed.get("status", "OFFLINE").lower()
        if state in {"live", "empty", "offline"}:
            country_health[f"{state}_feed_count"] += 1
    for item in items:
        code = item.get("country")
        if code in africa_feed_health:
            africa_feed_health[code]["recent_headline_count"] += 1
    africa_feed_health = {
        code: {"country": code, **health}
        for code, health in sorted(africa_feed_health.items())
    }
    fetched_at = float(_cache["fetched_at"])
    return {
        "status": "LIVE" if items else ("EMPTY" if any(feed.get("status") == "EMPTY" for feed in statuses) else "OFFLINE"),
        "updated_at": datetime.fromtimestamp(fetched_at, timezone.utc).isoformat() if fetched_at else None,
        "cache_seconds": CACHE_SECONDS,
        # A None limit means the caller explicitly requested every retained
        # headline from the trailing 24-hour window.
        "count": len(items) if limit is None else min(len(items), limit),
        "items": items if limit is None else items[:limit],
        "feeds": statuses,
        "africa_feed_coverage": get_africa_feed_coverage(),
        "africa_feed_health": africa_feed_health,
        "feed_health_counts": {state: sum(1 for feed in statuses if feed.get("status") == state) for state in ("LIVE", "EMPTY", "OFFLINE")},
        "note": "Country-labelled curated public RSS headlines with dividend, earnings, yield and policy relevance tags; not a complete economic calendar. Official releases can be delayed or unavailable. No headline-only directional trading signals are generated.",
    }



_refresh_worker_lock = Lock()
_refresh_worker_active = False
_refresh_worker_last_error: str | None = None

def get_fundamental_news_fast(limit: int | None = 30, force_refresh: bool = False) -> dict:
    """Return the current in-process snapshot immediately and refresh it in background."""
    global _refresh_worker_active, _refresh_worker_last_error
    # Copy the published snapshot without waiting on _cache_lock: RSS collection
    # intentionally holds that lock while publishers are fetched.
    fetched_at = float(_cache.get("fetched_at") or 0.0)
    items = list(_cache.get("items") or [])
    statuses = list(_cache.get("feed_status") or [])
    retained = [item for item in items if _is_within_news_retention(item)]
    if limit is not None:
        retained = retained[:limit]
    stale = force_refresh or not now_is_fresh(fetched_at)
    if stale:
        with _refresh_worker_lock:
            if not _refresh_worker_active:
                _refresh_worker_active = True
                def refresh_worker():
                    global _refresh_worker_active
                    global _refresh_worker_last_error
                    try:
                        get_fundamental_news(limit=None, force_refresh=True)
                        _refresh_worker_last_error = None
                    except Exception as exc:
                        _refresh_worker_last_error = f"{type(exc).__name__}: {str(exc)[:240]}"
                    finally:
                        with _refresh_worker_lock:
                            _refresh_worker_active = False
                from threading import Thread
                Thread(target=refresh_worker, daemon=True, name="fundamental-news-refresh").start()
    updated_at = datetime.fromtimestamp(fetched_at, timezone.utc).isoformat() if fetched_at else None
    return {
        "status": "LIVE" if retained else ("EMPTY" if any(feed.get("status") == "EMPTY" for feed in statuses) else "OFFLINE"),
        "updated_at": updated_at,
        "cache_seconds": CACHE_SECONDS,
        "count": len(retained),
        "items": retained,
        "feeds": statuses,
        "africa_feed_coverage": get_africa_feed_coverage(),
        "africa_feed_health": {},
        "feed_health_counts": {state: sum(1 for feed in statuses if feed.get("status") == state) for state in ("LIVE", "EMPTY", "OFFLINE")},
        "refresh_in_progress": _refresh_worker_active,
        "refresh_last_error": _refresh_worker_last_error,
        "note": "Showing the latest in-process snapshot while publisher feeds refresh in the background. RSS updates can be delayed; this is not a complete economic calendar.",
    }


def get_africa_feed_coverage() -> dict:
    """Static dedicated-source coverage; this is configuration, not live health."""
    african_codes = set(_AFRICAN_COUNTRY_ALIASES)
    dedicated_codes = {country for _, _, kind, country in FEEDS if kind == "africa" and country not in {"AF", "GLOBAL"}}
    return {
        "dedicated_country_codes": sorted(dedicated_codes),
        "coverage_gap_country_codes": sorted(african_codes - dedicated_codes),
        "country_count": len(african_codes),
        "covered_country_count": len(african_codes & dedicated_codes),
        "note": "Coverage gaps indicate no dedicated country feed is configured; regional feeds may still contain relevant headlines.",
    }


def now_is_fresh(fetched_at: float) -> bool:
    return fetched_at > 0 and time.time() - fetched_at < CACHE_SECONDS

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
