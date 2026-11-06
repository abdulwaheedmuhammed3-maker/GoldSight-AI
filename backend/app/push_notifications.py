"""Web Push delivery for fresh GoldSight setup alerts.

Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_CLAIMS_EMAIL.
Subscriptions and notification history are stored in PostgreSQL.
"""
from __future__ import annotations

import json
import math
import os
import base64
from urllib.parse import quote
from datetime import datetime, timezone, timedelta
from typing import Any

import psycopg
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from psycopg.rows import dict_row
from app.setup_history import _database_url, database_configured


def public_key() -> str | None:
    return os.getenv("VAPID_PUBLIC_KEY") or None


def _load_vapid_key():
    """Load PEM or base64url raw/DER VAPID private keys from environment."""
    from py_vapid import Vapid
    value = os.getenv("VAPID_PRIVATE_KEY", "").strip()
    if not value:
        raise RuntimeError("VAPID_PRIVATE_KEY is empty.")
    if "-----BEGIN" in value:
        key = Vapid.from_pem(value.encode("utf-8"))
    else:
        key = Vapid.from_string(value)
    derived_public = key.public_key.public_bytes(
        encoding=Encoding.X962,
        format=PublicFormat.UncompressedPoint,
    )
    derived_public_b64 = base64.urlsafe_b64encode(derived_public).decode("ascii").rstrip("=")
    configured_public = (public_key() or "").strip().rstrip("=")
    if not configured_public or derived_public_b64 != configured_public:
        raise RuntimeError("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY. Use the matching key pair.")
    return key


def service_status() -> dict[str, Any]:
    """Report configuration readiness, not guaranteed delivery to a device."""
    key = public_key()
    private_key = os.getenv("VAPID_PRIVATE_KEY", "").strip()
    email = os.getenv("VAPID_CLAIMS_EMAIL", "").strip()
    try:
        import pywebpush  # noqa: F401
        dependency_ready = True
    except ImportError:
        dependency_ready = False
    ready = bool(key and private_key and email.startswith("mailto:") and database_configured() and dependency_ready)
    return {
        "enabled": ready,
        "public_key": key,
        "checks": {
            "public_key": bool(key),
            "private_key": bool(private_key),
            "claims_email": email.startswith("mailto:"),
            "database_configured": database_configured(),
            "delivery_library": dependency_ready,
        },
        "note": "Configuration-ready does not confirm that a subscribed device can receive a push. Delivery must be tested separately.",
    }


def save_subscription(subscription: dict[str, Any]) -> None:
    if not database_configured():
        raise RuntimeError("Push subscriptions require DATABASE_URL.")
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys") or {}
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        raise ValueError("A valid HTTPS push endpoint is required.")
    if not isinstance(keys.get("p256dh"), str) or not isinstance(keys.get("auth"), str):
        raise ValueError("Push subscription keys are missing.")
    with psycopg.connect(_database_url()) as conn:
        conn.execute("""
            INSERT INTO goldsight_push_subscriptions (endpoint, subscription, created_at, last_seen_at)
            VALUES (%s, %s::jsonb, %s, %s)
            ON CONFLICT (endpoint) DO UPDATE SET
              subscription = EXCLUDED.subscription,
              last_seen_at = EXCLUDED.last_seen_at
        """, (endpoint, json.dumps(subscription), datetime.now(timezone.utc), datetime.now(timezone.utc)))
        conn.commit()


def _preference_enabled(subscription: dict[str, Any], category: str) -> bool:
    """Category approvals are device-specific and default to denied."""
    preferences = subscription.get("preferences") or {}
    return isinstance(preferences, dict) and preferences.get(category) is True


def remove_subscription(endpoint: str) -> None:
    if not database_configured():
        return
    with psycopg.connect(_database_url()) as conn:
        conn.execute("DELETE FROM goldsight_push_subscriptions WHERE endpoint = %s", (endpoint,))
        conn.commit()


def list_notifications(limit: int = 50) -> list[dict[str, Any]]:
    if not database_configured():
        return []
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        rows = conn.execute("""
            SELECT id, event_key, title, body, payload, created_at
            FROM goldsight_notifications ORDER BY created_at DESC LIMIT %s
        """, (max(1, min(limit, 100)),)).fetchall()
    for row in rows:
        row["created_at"] = row["created_at"].isoformat()
    return rows


def _format_notification_price(symbol: str, value: Any) -> str:
    """Format prices for human-readable alerts without changing stored precision."""
    if value is None:
        return "—"
    try:
        price = float(value)
    except (TypeError, ValueError):
        return "—"
    if not math.isfinite(price):
        return "—"
    normalized_symbol = str(symbol or "").upper().replace("/", "").replace("_", "")
    if normalized_symbol.startswith(("XAU", "BTC")):
        decimals = 2
    elif normalized_symbol.endswith("JPY"):
        decimals = 3
    elif len(normalized_symbol) == 6 and normalized_symbol.isalpha():
        # Standard non-JPY FX pairs quote to five decimal places.
        decimals = 5
    else:
        decimals = 2
    return f"{price:,.{decimals}f}"


def is_high_quality_setup(signal: dict[str, Any]) -> bool:
    """Push only strong setups; all fresh setups remain in persisted signal history."""
    try:
        confidence = float(signal.get("confidence"))
        rr_values = signal.get("rr") or []
        first_rr = float(rr_values[0]) if isinstance(rr_values, (list, tuple)) and rr_values else float(rr_values)
    except (TypeError, ValueError, OverflowError, IndexError):
        return False
    return math.isfinite(confidence) and confidence >= 80 and math.isfinite(first_rr) and first_rr >= 1.5


def classify_order_type(side: Any, entry: Any, market_price: Any) -> str:
    """Classify BUY/SELL as LIMIT, STOP, or MARKET against the quote at signal time."""
    normalized_side = str(side or "").upper()
    try:
        entry_price = float(entry)
        quote_price = float(market_price)
    except (TypeError, ValueError):
        return f"{normalized_side} MARKET" if normalized_side in {"BUY", "SELL"} else "UNKNOWN"
    if not math.isfinite(entry_price) or not math.isfinite(quote_price):
        return f"{normalized_side} MARKET" if normalized_side in {"BUY", "SELL"} else "UNKNOWN"
    if normalized_side == "BUY":
        return "BUY LIMIT" if entry_price < quote_price else "BUY STOP" if entry_price > quote_price else "BUY MARKET"
    if normalized_side == "SELL":
        return "SELL LIMIT" if entry_price > quote_price else "SELL STOP" if entry_price < quote_price else "SELL MARKET"
    return "UNKNOWN"


def _send_setup_notification_once(symbol: str, timeframe: str, signal: dict[str, Any], order_type: str | None = None) -> int:
    """Persist once; retry delivery until at least one subscribed device accepts the push."""
    if not database_configured():
        return 0
    signal_time = signal.get("signal_time") or ""
    side = signal.get("status")
    order_type = order_type or signal.get("order_type") or f"{str(side or 'UPDATE').upper()} MARKET"
    event_key = f"{symbol}:{timeframe}:{side}:{order_type}:{signal_time}"
    entry = signal.get("entry")
    sl = signal.get("stop_loss")
    tps = signal.get("take_profits") or []
    # Use a short instrument label so Android notification previews are easy to scan.
    upper_symbol = str(symbol or "").upper().replace("/", "").replace("_", "")
    if upper_symbol.startswith("XAU"):
        instrument_label = "XAU"
    elif upper_symbol.startswith("BTC"):
        instrument_label = "BTC"
    else:
        instrument_label = str(symbol or "MARKET").upper()
    confidence = signal.get("confidence")
    try:
        confidence_label = f"{float(confidence):g}%" if confidence is not None else "N/A"
    except (TypeError, ValueError, OverflowError):
        confidence_label = "N/A"
    title = f"{instrument_label} · {order_type} · {timeframe} · {confidence_label}"
    body = f"{confidence_label} · Entry {_format_notification_price(symbol, entry)} · SL {_format_notification_price(symbol, sl)} · " + " / ".join(f"TP{i+1} {_format_notification_price(symbol, v)}" for i, v in enumerate(tps))
    payload = {
        "event_key": event_key, "symbol": symbol, "timeframe": timeframe, "side": side, "order_type": order_type,
        "entry": entry, "stop_loss": sl, "take_profits": tps,
        "confidence": signal.get("confidence"), "signal_time": signal_time,
        "reasons": signal.get("reasons") or [], "invalidation": signal.get("invalidation"),
    }
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        conn.execute("""
            INSERT INTO goldsight_notifications (event_key, title, body, payload, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (event_key) DO NOTHING
        """, (event_key, title, body, json.dumps(payload), datetime.now(timezone.utc)))
        row = conn.execute(
            "SELECT push_sent_at FROM goldsight_notifications WHERE event_key = %s FOR UPDATE",
            (event_key,),
        ).fetchone()
        if not row or row["push_sent_at"] is not None:
            conn.commit()
            return 0

        # Per-instrument cooldown: allow one setup push every 20 minutes
        # for each symbol independently. Other instruments are unaffected.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"setup-push-cooldown:{upper_symbol}",))
        latest_delivery = conn.execute(
            """
            SELECT MAX(push_sent_at) AS latest
            FROM goldsight_notifications
            WHERE push_sent_at IS NOT NULL
              AND payload->>'symbol' = %s
              AND event_key NOT LIKE 'news:'
            """,
            (symbol,),
        ).fetchone()
        latest_sent_at = latest_delivery.get("latest") if latest_delivery else None
        if latest_sent_at and latest_sent_at > datetime.now(timezone.utc) - timedelta(minutes=20):
            conn.commit()
            return 0

        subscriptions = conn.execute("SELECT endpoint, subscription FROM goldsight_push_subscriptions").fetchall()
        conn.commit()
    fcm_sent = 0
    try:
        from app.fcm_notifications import send_to_devices
        fcm_sent = send_to_devices(
            title, body,
            {"type": "SETUP", "url": f"/?setup={symbol}&tf={timeframe}", "symbol": symbol, "timeframe": timeframe, "side": str(side or ""), "order_type": order_type},
            preference="setups",
        )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("FCM setup alert delivery failed.")
    if not subscriptions or not os.getenv("VAPID_PRIVATE_KEY") or not public_key():
        if fcm_sent:
            with psycopg.connect(_database_url()) as conn:
                conn.execute(
                    "UPDATE goldsight_notifications SET push_sent_at = %s WHERE event_key = %s AND push_sent_at IS NULL",
                    (datetime.now(timezone.utc), event_key),
                )
                conn.commit()
        return fcm_sent
    try:
        from pywebpush import webpush
    except ImportError:
        return 0
    sent = 0
    for subscription in subscriptions:
        if not _preference_enabled(subscription["subscription"], "setups"):
            continue
        try:
            encoded_signal_time = quote(signal_time, safe="")
            webpush(
                subscription_info=subscription["subscription"],
                data=json.dumps({"title": title, "body": body, "url": f"/?setup={symbol}&tf={timeframe}&signal_time={encoded_signal_time}"}),
                vapid_private_key=_load_vapid_key(),
                vapid_claims={"sub": os.getenv("VAPID_CLAIMS_EMAIL", "mailto:admin@goldsight.local")},
                ttl=300,
            )
            sent += 1
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                remove_subscription(subscription["endpoint"])
    if sent or fcm_sent:
        with psycopg.connect(_database_url()) as conn:
            conn.execute(
                "UPDATE goldsight_notifications SET push_sent_at = %s WHERE event_key = %s AND push_sent_at IS NULL",
                (datetime.now(timezone.utc), event_key),
            )
            conn.commit()
    return sent + fcm_sent


def send_setup_notification(symbol: str, timeframe: str, signal: dict[str, Any], order_type: str | None = None) -> int:
    """Serialize delivery attempts for an event across concurrent workers."""
    side = signal.get("status")
    resolved_order_type = order_type or signal.get("order_type") or f"{str(side or 'UPDATE').upper()} MARKET"
    signal_time = signal.get("signal_time") or ""
    event_key = f"{symbol}:{timeframe}:{side}:{resolved_order_type}:{signal_time}"
    if not database_configured():
        return 0

    # A session-level lock remains held while provider calls happen on their own
    # connections. A transaction-level lock would be released before delivery.
    with psycopg.connect(_database_url()) as lock_conn:
        lock_conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (f"setup-push-event:{event_key}",))
        lock_conn.commit()
        try:
            return _send_setup_notification_once(symbol, timeframe, signal, resolved_order_type)
        finally:
            lock_conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (f"setup-push-event:{event_key}",))
            lock_conn.commit()


def retry_pending_setup_notifications(limit: int = 30) -> int:
    """Retry recent setup alerts that were saved but never accepted by a push provider."""
    if not database_configured():
        return 0
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        rows = conn.execute("""
            SELECT payload FROM goldsight_notifications
            WHERE event_key NOT LIKE 'news:%%' AND push_sent_at IS NULL
              AND created_at >= %s
            ORDER BY created_at DESC LIMIT %s
        """, (datetime.now(timezone.utc) - timedelta(hours=24), max(1, min(limit, 100)))).fetchall()
    delivered = 0
    for row in rows:
        payload = row.get("payload") or {}
        symbol, timeframe = payload.get("symbol"), payload.get("timeframe")
        if symbol and timeframe and payload.get("side") in {"BUY", "SELL"}:
            delivered += send_setup_notification(symbol, timeframe, payload, payload.get("order_type"))
    return delivered



def is_news_notification_eligible(item: dict[str, Any]) -> bool:
    """Accept classified news; each device's region/topic approvals decide delivery.

    Country-labelled low-impact international stories are now valid because users
    explicitly choose which regions and topics they want to receive.
    """
    return bool(
        str(item.get("country") or "").strip()
        or str(item.get("topic") or "").strip()
        or item.get("impact") == "HIGH"
    )


def _news_preference_matches(subscription: dict[str, Any], item: dict[str, Any]) -> bool:
    """Match a headline against the device's independently approved region/topic choices."""
    preferences = subscription.get("preferences") or {}
    news = preferences.get("news") if isinstance(preferences, dict) else None
    if not isinstance(news, dict):
        return False
    country = str(item.get("country") or "").upper()
    headline_text = f"{item.get('title') or ''} {item.get('summary') or ''}".lower()
    nigeria_markers = ("nigeria", "nigerian", "lagos", "abuja", "port harcourt", "kano", "kwara", "ilorin", "naira", "nairametrics")
    if country == "AF" and any(marker in headline_text for marker in nigeria_markers):
        country = "NG"
    african_countries = {
        "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CD", "CG",
        "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE",
        "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ", "NA", "NE", "RW",
        "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "TZ", "TG", "TN", "UG", "ZM", "ZW",
    }
    region_keys = []
    if country == "NG":
        region_keys.append("nigeria")
    elif country == "AF" or country in african_countries:
        region_keys.append("africa")
    elif country == "US":
        region_keys.append("usa")
    elif country == "GB":
        region_keys.append("uk")
    elif country in {"GLOBAL", "EU"}:
        region_keys.append("global")

    topic = str(item.get("topic") or "").lower()
    if topic == "economic":
        topic_keys = ["economic"]
    elif topic == "football":
        topic_keys = ["football"]
    else:
        topic_keys = []
    return any(news.get(key) is True for key in region_keys + topic_keys)


def send_news_notification(item: dict[str, Any]) -> int:
    """Persist once and deliver only to devices approving a matching news region or topic."""
    if not database_configured():
        return 0
    article_url = item.get("url")
    headline = str(item.get("title") or "").strip()
    if not isinstance(article_url, str) or not article_url.startswith("https://") or not headline:
        return 0
    assets = item.get("assets") or []
    country = str(item.get("country") or "").upper()
    nigeria_news = country == "NG"
    high_impact = item.get("impact") == "HIGH"
    source = str(item.get("source") or "News")
    category = "Nigeria news" if nigeria_news else ("African news" if country in {"AF", "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CD", "CG", "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ", "NA", "NE", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "TZ", "TG", "TN", "UG", "ZM", "ZW"} else "Global news")
    title = f"{category} · {source}"
    asset_labels = [asset for asset in assets if asset in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"}]
    context = ", ".join(asset_labels) if asset_labels else ("Nigeria" if nigeria_news else "Markets")
    body = f"{context}: {headline}"[:240]
    event_key = f"news:{item.get('id') or article_url}"
    payload = {
        "event_key": event_key, "type": "NEWS", "title": headline,
        "source": source, "url": article_url, "published_at": item.get("published_at"),
        "assets": assets, "country": item.get("country"), "impact": item.get("impact"),
    }
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        inserted = conn.execute("""
            INSERT INTO goldsight_notifications (event_key, title, body, payload, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (event_key) DO NOTHING RETURNING id
        """, (event_key, title, body, json.dumps(payload), datetime.now(timezone.utc))).fetchone()
        if not inserted:
            return 0
        subscriptions = conn.execute("SELECT endpoint, subscription FROM goldsight_push_subscriptions").fetchall()
        conn.commit()
    fcm_sent = 0
    try:
        from app.fcm_notifications import send_news_to_devices
        fcm_sent = send_news_to_devices(item, title, body, article_url)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("FCM news alert delivery failed.")
    if not subscriptions or not os.getenv("VAPID_PRIVATE_KEY") or not public_key():
        return fcm_sent
    try:
        from pywebpush import webpush
    except ImportError:
        return 0
    sent = 0
    for row in subscriptions:
        if not _news_preference_matches(row["subscription"], item):
            continue
        try:
            webpush(
                subscription_info=row["subscription"],
                data=json.dumps({"title": title, "body": body, "url": article_url, "event_key": event_key}),
                vapid_private_key=_load_vapid_key(),
                vapid_claims={"sub": os.getenv("VAPID_CLAIMS_EMAIL", "mailto:admin@goldsight.local")},
                ttl=3600,
            )
            sent += 1
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                remove_subscription(row["endpoint"])
    return sent + fcm_sent


def send_test_notification(subscription: dict[str, Any]) -> None:
    """Send a test push only to the exact already-registered requesting device."""
    if not database_configured():
        raise RuntimeError("Push testing requires DATABASE_URL.")
    endpoint = subscription.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        raise ValueError("A valid HTTPS device subscription is required.")
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        row = conn.execute(
            "SELECT endpoint, subscription FROM goldsight_push_subscriptions WHERE endpoint = %s",
            (endpoint,),
        ).fetchone()
    if not row:
        raise LookupError("This device is not registered. Enable push notifications again and retry.")
    if not os.getenv("VAPID_PRIVATE_KEY") or not public_key():
        raise RuntimeError("Push delivery keys are not configured.")
    try:
        from pywebpush import webpush
    except ImportError as exc:
        raise RuntimeError("The Web Push delivery library is unavailable.") from exc
    try:
        webpush(
            subscription_info=row["subscription"],
            data=json.dumps({
                "title": "TradeSight test notification",
                "body": "Success — this Android device can receive TradeSight push alerts.",
                "url": "/",
                "event_key": f"tradesight-test-{int(datetime.now(timezone.utc).timestamp())}",
            }),
            vapid_private_key=_load_vapid_key(),
            vapid_claims={"sub": os.environ["VAPID_CLAIMS_EMAIL"]},
            ttl=120,
        )
    except Exception as exc:
        import logging
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        # Keep provider diagnostics in server logs; never expose subscription
        # endpoints, auth keys, or VAPID private material to the browser.
        response_text = getattr(response, "text", "") if response is not None else ""
        logging.getLogger(__name__).exception(
            "Web Push test delivery failed (exception=%s, http_status=%s, provider_response=%s)",
            type(exc).__name__, status, str(response_text)[:1000],
        )
        if status in (404, 410):
            remove_subscription(endpoint)
            raise LookupError("The device subscription has expired. Enable push notifications again.") from exc
        if status == 401 or status == 403:
            raise RuntimeError("The push provider rejected VAPID authentication. Check that the public/private VAPID keys belong together and that VAPID_CLAIMS_EMAIL is valid.") from exc
        if status is not None:
            raise RuntimeError(f"The push provider rejected the test notification (HTTP {status}). Check backend logs for provider details.") from exc
        raise RuntimeError("The push test failed before provider acceptance. Check backend logs for the exception details.") from exc



def send_opportunity_notification(item: dict[str, Any]) -> int:
    """Send a recent Tech & Careers item only to devices that opted in."""
    if not database_configured():
        return 0
    from datetime import timedelta
    try:
        published = datetime.fromisoformat(str(item.get("published_at") or "").replace("Z", "+00:00"))
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return 0
    now = datetime.now(timezone.utc)
    if published < now - timedelta(hours=36) or published > now + timedelta(minutes=10):
        return 0
    url = item.get("url")
    headline = str(item.get("title") or "").strip()
    if not isinstance(url, str) or not url.startswith("https://") or not headline:
        return 0
    event_key = "opportunity:" + str(item.get("id") or url)
    category = str(item.get("category") or "TECH").upper()
    preference_by_category = {"TECH": "tech_news", "WEB": "web_development", "AI": "ai_news", "JOBS": "remote_jobs"}
    preference = preference_by_category.get(category)
    if not preference:
        return 0
    title = "TradeSight · " + {"TECH": "Technology", "WEB": "Web Development", "AI": "AI News", "JOBS": "Remote Jobs"}[category]
    body = (str(item.get("source") or "TradeSight") + ": " + headline)[:240]
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        inserted = conn.execute("""
            INSERT INTO goldsight_notifications (event_key, title, body, payload, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (event_key) DO NOTHING RETURNING id
        """, (event_key, title, body, json.dumps({"type": "OPPORTUNITY", "url": url, "category": category}), now)).fetchone()
        if not inserted:
            return 0
        subscriptions = conn.execute("SELECT endpoint, subscription FROM goldsight_push_subscriptions").fetchall()
        conn.commit()
    delivered = 0
    try:
        from app.fcm_notifications import send_to_devices
        delivered += send_to_devices(title, body, {"type": "OPPORTUNITY", "url": url, "category": category}, preference=preference)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("FCM Tech & Careers notification failed.")
    if subscriptions and os.getenv("VAPID_PRIVATE_KEY") and public_key():
        try:
            from pywebpush import webpush
            for row in subscriptions:
                if not _preference_enabled(row["subscription"], preference):
                    continue
                try:
                    webpush(subscription_info=row["subscription"], data=json.dumps({"title": title, "body": body, "url": url, "event_key": event_key, "type": "OPPORTUNITY"}), vapid_private_key=_load_vapid_key(), vapid_claims={"sub": os.getenv("VAPID_CLAIMS_EMAIL", "mailto:admin@goldsight.local")}, ttl=3600)
                    delivered += 1
                except Exception as exc:
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    if status in (404, 410):
                        remove_subscription(row["endpoint"])
        except ImportError:
            pass
    return delivered

def send_stock_suggestion_notification(item: dict[str, Any]) -> int:
    """Send a stock-investment research suggestion only to devices approving stocks."""
    if not database_configured():
        return 0
    ticker = str(item.get("ticker") or "").strip().upper()
    headline = str(item.get("title") or "").strip()
    if not ticker or not headline:
        return 0
    event_key = f"stock:{item.get('id') or ticker + ':' + headline}"
    title = f"Stock research · {ticker}"
    body = headline[:240]
    payload = {
        "event_key": event_key, "type": "STOCK", "ticker": ticker,
        "title": headline, "url": item.get("url") or "/?tab=stocks",
    }
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        inserted = conn.execute("""
            INSERT INTO goldsight_notifications (event_key, title, body, payload, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (event_key) DO NOTHING RETURNING id
        """, (event_key, title, body, json.dumps(payload), datetime.now(timezone.utc))).fetchone()
        if not inserted:
            return 0
        subscriptions = conn.execute("SELECT endpoint, subscription FROM goldsight_push_subscriptions").fetchall()
        conn.commit()
    fcm_sent = 0
    try:
        from app.fcm_notifications import send_to_devices
        fcm_sent = send_to_devices(
            title, body,
            {"type": "STOCK", "url": str(payload["url"]), "ticker": ticker},
            preference="stocks",
        )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("FCM stock alert delivery failed.")
    if not subscriptions or not os.getenv("VAPID_PRIVATE_KEY") or not public_key():
        return fcm_sent
    try:
        from pywebpush import webpush
    except ImportError:
        return 0
    sent = 0
    for row in subscriptions:
        if not _preference_enabled(row["subscription"], "stocks"):
            continue
        try:
            webpush(
                subscription_info=row["subscription"],
                data=json.dumps({"title": title, "body": body, "url": payload["url"], "event_key": event_key, "type": "STOCK"}),
                vapid_private_key=_load_vapid_key(),
                vapid_claims={"sub": os.getenv("VAPID_CLAIMS_EMAIL", "mailto:admin@goldsight.local")},
                ttl=3600,
            )
            sent += 1
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                remove_subscription(row["endpoint"])
    return sent + fcm_sent
