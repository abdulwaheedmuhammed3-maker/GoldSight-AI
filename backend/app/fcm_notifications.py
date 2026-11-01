"""Firebase Cloud Messaging registration and delivery for native TradeSight devices."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from app.setup_history import _database_url, database_configured


def _ensure_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tradesight_fcm_devices (
            token TEXT PRIMARY KEY,
            preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


def register_device(payload: dict[str, Any]) -> None:
    token = payload.get("token")
    preferences = payload.get("preferences") or {}
    if not isinstance(token, str) or len(token) < 20 or len(token) > 4096:
        raise ValueError("A valid Firebase device token is required.")
    if not isinstance(preferences, dict):
        raise ValueError("Notification preferences must be an object.")
    if not database_configured():
        raise RuntimeError("Device registration requires DATABASE_URL.")
    now = datetime.now(timezone.utc)
    with psycopg.connect(_database_url()) as conn:
        _ensure_table(conn)
        conn.execute("""
            INSERT INTO tradesight_fcm_devices (token, preferences, created_at, last_seen_at)
            VALUES (%s, %s::jsonb, %s, %s)
            ON CONFLICT (token) DO UPDATE SET
              preferences = EXCLUDED.preferences, last_seen_at = EXCLUDED.last_seen_at
        """, (token, json.dumps(preferences), now, now))
        conn.commit()


def _firebase_app():
    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        raise RuntimeError("Firebase backend credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON on the API service.")
    try:
        credentials_info = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.") from exc
    import firebase_admin
    from firebase_admin import credentials
    try:
        return firebase_admin.get_app()
    except ValueError:
        return firebase_admin.initialize_app(credentials.Certificate(credentials_info))


def send_to_devices(title: str, body: str, data: dict[str, Any] | None = None, preference: str | None = None) -> int:
    if not database_configured():
        return 0
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        _ensure_table(conn)
        rows = conn.execute("SELECT token, preferences FROM tradesight_fcm_devices").fetchall()
        conn.commit()
    if preference:
        rows = [r for r in rows if (r.get("preferences") or {}).get(preference) is True]
    if not rows:
        return 0
    try:
        from firebase_admin import messaging
        _firebase_app()
    except Exception:
        import logging
        logging.getLogger(__name__).exception("Firebase Admin SDK is not ready.")
        return 0
    sent = 0
    for row in rows:
        message = messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            data={str(k): str(v) for k, v in (data or {}).items() if v is not None},
            token=row["token"],
            android=messaging.AndroidConfig(
                priority="high",
                notification=messaging.AndroidNotification(channel_id="tradesight-alerts-v2", priority="high", visibility="public"),
            ),
        )
        try:
            messaging.send(message)
            sent += 1
        except messaging.UnregisteredError:
            with psycopg.connect(_database_url()) as conn:
                conn.execute("DELETE FROM tradesight_fcm_devices WHERE token = %s", (row["token"],))
                conn.commit()
        except Exception:
            import logging
            logging.getLogger(__name__).exception("FCM delivery failed for a registered device.")
    return sent


def send_test(token: str) -> None:
    if not isinstance(token, str) or not token:
        raise ValueError("Firebase device token is required.")
    if not database_configured():
        raise RuntimeError("Push testing requires DATABASE_URL.")
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        _ensure_table(conn)
        row = conn.execute("SELECT token FROM tradesight_fcm_devices WHERE token = %s", (token,)).fetchone()
        conn.commit()
    if not row:
        raise LookupError("This device is not registered. Connect notifications again and retry.")
    try:
        from firebase_admin import messaging
        _firebase_app()
        messaging.send(messaging.Message(
            notification=messaging.Notification(
                title="TradeSight test notification",
                body="Success — this Android device can receive TradeSight alerts.",
            ),
            data={"type": "TEST", "url": "/"},
            token=token,
            android=messaging.AndroidConfig(priority="high"),
        ))
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("FCM test delivery failed.")
        raise RuntimeError("Firebase did not accept the test notification. Check Firebase service-account credentials and backend logs.") from exc


def send_news_to_devices(item: dict[str, Any], title: str, body: str, article_url: str) -> int:
    """Send news only to native devices approving the matching region/topic."""
    if not database_configured():
        return 0
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        _ensure_table(conn)
        rows = conn.execute("SELECT token, preferences FROM tradesight_fcm_devices").fetchall()
        conn.commit()
    from app.push_notifications import _news_preference_matches
    rows = [row for row in rows if _news_preference_matches({"preferences": row.get("preferences") or {}}, item)]
    if not rows:
        return 0
    try:
        from firebase_admin import messaging
        _firebase_app()
    except Exception:
        import logging
        logging.getLogger(__name__).exception("Firebase Admin SDK is not ready for news delivery.")
        return 0
    sent = 0
    for row in rows:
        try:
            # Attach the article's real preview image to Android's expanded notification.
            # Do not substitute the publisher favicon: only use an actual article image.
            preview_image = item.get("image_url")
            if not isinstance(preview_image, str) or not preview_image.startswith("https://"):
                preview_image = None
            android_notification = messaging.AndroidNotification(
                image=preview_image,
                channel_id="tradesight-alerts-v2",
                priority="high",
                visibility="public",
            )
            messaging.send(messaging.Message(
                notification=messaging.Notification(title=title, body=body, image=preview_image),
                data={
                    "type": "NEWS",
                    "url": article_url,
                    "title": str(item.get("title") or ""),
                    **({"image": preview_image} if preview_image else {}),
                },
                token=row["token"],
                android=messaging.AndroidConfig(
                    priority="high",
                    notification=android_notification,
                ),
            ))
            sent += 1
        except messaging.UnregisteredError:
            with psycopg.connect(_database_url()) as conn:
                conn.execute("DELETE FROM tradesight_fcm_devices WHERE token = %s", (row["token"],))
                conn.commit()
        except Exception:
            import logging
            logging.getLogger(__name__).exception("FCM news delivery failed.")
    return sent
