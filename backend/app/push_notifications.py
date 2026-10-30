"""Web Push delivery for fresh GoldSight setup alerts.

Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_CLAIMS_EMAIL.
Subscriptions and notification history are stored in PostgreSQL.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from app.setup_history import _database_url, database_configured


def public_key() -> str | None:
    return os.getenv("VAPID_PUBLIC_KEY") or None


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


def send_setup_notification(symbol: str, timeframe: str, signal: dict[str, Any]) -> int:
    """Persist once and fan out a push for a newly inserted setup."""
    if not database_configured():
        return 0
    signal_time = signal.get("signal_time") or ""
    side = signal.get("status")
    event_key = f"{symbol}:{timeframe}:{side}:{signal_time}"
    entry = signal.get("entry")
    sl = signal.get("stop_loss")
    tps = signal.get("take_profits") or []
    title = f"{symbol} {side} setup · {timeframe}"
    body = f"Entry {entry} · SL {sl} · " + " / ".join(f"TP{i+1} {v}" for i, v in enumerate(tps))
    payload = {
        "event_key": event_key, "symbol": symbol, "timeframe": timeframe, "side": side,
        "entry": entry, "stop_loss": sl, "take_profits": tps,
        "confidence": signal.get("confidence"), "signal_time": signal_time,
        "reasons": signal.get("reasons") or [], "invalidation": signal.get("invalidation"),
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
    if not subscriptions or not os.getenv("VAPID_PRIVATE_KEY") or not public_key():
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        return 0
    sent = 0
    for row in subscriptions:
        try:
            webpush(
                subscription_info=row["subscription"],
                data=json.dumps({"title": title, "body": body, "url": "/"}),
                vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
                vapid_claims={"sub": os.getenv("VAPID_CLAIMS_EMAIL", "mailto:admin@goldsight.local")},
                ttl=300,
            )
            sent += 1
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                remove_subscription(row["endpoint"])
    return sent


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
            vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
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
