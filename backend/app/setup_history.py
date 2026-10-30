"""Persistent server-side recording of valid setups.

Requires DATABASE_URL pointing to a persistent PostgreSQL database. No browser
state or ephemeral local file is used as the source of truth.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row


def database_configured() -> bool:
    return bool(os.getenv("DATABASE_URL", "").strip())


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not configured; persistent setup history is disabled.")
    # Render may provide postgres://; psycopg accepts postgresql:// consistently.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


def initialize_history_store() -> None:
    if not database_configured():
        return
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_setup_history (
                id BIGSERIAL PRIMARY KEY,
                signal_key TEXT NOT NULL UNIQUE,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
                signal_time TIMESTAMPTZ NOT NULL,
                detected_at TIMESTAMPTZ NOT NULL,
                entry DOUBLE PRECISION NOT NULL,
                stop_loss DOUBLE PRECISION NOT NULL,
                take_profits JSONB NOT NULL,
                rr JSONB,
                confidence INTEGER,
                trend TEXT,
                reasons JSONB NOT NULL,
                invalidation TEXT,
                provider TEXT,
                status TEXT NOT NULL DEFAULT 'DETECTED',
                outcome_at TIMESTAMPTZ,
                outcome_price DOUBLE PRECISION,
                entered_at TIMESTAMPTZ,
                reached_target INTEGER,
                targets_hit JSONB NOT NULL DEFAULT '[]'::jsonb
            )
        """)
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS trade_type TEXT NOT NULL DEFAULT 'TECHNICAL TRADE'")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS news_context JSONB")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS outcome_price DOUBLE PRECISION")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS reached_target INTEGER")
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS targets_hit JSONB NOT NULL DEFAULT '[]'::jsonb")
        conn.execute("CREATE INDEX IF NOT EXISTS goldsight_setup_detected_at_idx ON goldsight_setup_history (detected_at DESC)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_push_subscriptions (
                endpoint TEXT PRIMARY KEY,
                subscription JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                last_seen_at TIMESTAMPTZ NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goldsight_notifications (
                id BIGSERIAL PRIMARY KEY,
                event_key TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                payload JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL
            )
        """)
        conn.commit()


def record_setup(symbol: str, timeframe: str, market_data: dict[str, Any]) -> bool:
    """Insert one genuinely observed, fresh BUY/SELL setup; duplicate candles are ignored."""
    signal = market_data.get("signal") or {}
    if market_data.get("status") != "LIVE" or signal.get("status") not in {"BUY", "SELL"}:
        return False
    if signal.get("signal_fresh") is not True:
        return False
    signal_time = signal.get("signal_time")
    entry, stop_loss = signal.get("entry"), signal.get("stop_loss")
    take_profits = signal.get("take_profits")
    if not signal_time or entry is None or stop_loss is None or not isinstance(take_profits, list) or not take_profits:
        return False
    try:
        parsed_signal_time = datetime.fromisoformat(signal_time.replace("Z", "+00:00"))
        if parsed_signal_time.tzinfo is None:
            parsed_signal_time = parsed_signal_time.replace(tzinfo=timezone.utc)
        parsed_signal_time = parsed_signal_time.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return False
    side = signal["status"]
    key = f"{symbol}:{timeframe}:{side}:{parsed_signal_time.isoformat()}"
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        result = conn.execute("""
            INSERT INTO goldsight_setup_history (
                signal_key, symbol, timeframe, side, signal_time, detected_at,
                entry, stop_loss, take_profits, rr, confidence, trend, reasons,
                invalidation, provider, trade_type, news_context
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s,
                %s::jsonb, %s, %s, %s, %s::jsonb
            )
            ON CONFLICT (signal_key) DO NOTHING
            RETURNING id
        """, (
            key, symbol, timeframe, side, parsed_signal_time, datetime.now(timezone.utc),
            float(entry), float(stop_loss), json.dumps(take_profits),
            json.dumps(signal.get("rr")) if signal.get("rr") is not None else None,
            signal.get("confidence"), signal.get("trend"),
            json.dumps(signal.get("reasons") or []), signal.get("invalidation"),
            market_data.get("provider"),
            signal.get("trade_type", "TECHNICAL TRADE"),
            json.dumps(signal.get("news_context")) if signal.get("news_context") is not None else None,
        ))
        conn.commit()
        inserted = result.fetchone() is not None
    if inserted:
        try:
            from app.push_notifications import send_setup_notification
            send_setup_notification(symbol, timeframe, signal)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Could not deliver setup push notification")
    return inserted



def refresh_setup_outcomes(symbol: str, timeframe: str, market_data: dict[str, Any]) -> int:
    """Track entry, TP progression, and final SL/TP3 outcome from completed candles.

    If SL and a target are touched in one candle, assume SL first because OHLC
    candles cannot prove intrabar order. Previously reached targets remain recorded.
    """
    if not database_configured() or market_data.get("status") != "LIVE":
        return 0
    candles = market_data.get("candles") or []
    seconds = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}.get(timeframe)
    if not candles or not seconds:
        return 0
    now_ts = datetime.now(timezone.utc).timestamp()
    bars = sorted((bar for bar in candles if bar.get("closed") is not False
                   and int(bar.get("time", 0)) + seconds <= now_ts),
                  key=lambda bar: int(bar.get("time", 0)))
    updated = 0
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        rows = conn.execute(
            """SELECT id, side, signal_time, entry, stop_loss, take_profits,
                      status, entered_at, reached_target, targets_hit
               FROM goldsight_setup_history
               WHERE symbol=%s AND timeframe=%s AND status IN ('DETECTED','ACTIVE')
               ORDER BY signal_time""", (symbol, timeframe)
        ).fetchall()
        for row in rows:
            side = row["side"]
            entry, stop = float(row["entry"]), float(row["stop_loss"])
            targets = [float(v) for v in (row["take_profits"] or [])]
            entered_at = row["entered_at"]
            hit_indices = set(int(v) for v in (row.get("targets_hit") or []))
            reached_target = row.get("reached_target")
            final_status = final_price = final_stamp = None
            for bar in bars:
                stamp = datetime.fromtimestamp(int(bar["time"]), timezone.utc)
                if stamp <= row["signal_time"] or (entered_at is not None and stamp <= entered_at):
                    continue
                high, low = float(bar["high"]), float(bar["low"])
                if entered_at is None:
                    if not (low <= entry <= high):
                        stop_before_entry = low <= stop if side == "BUY" else high >= stop
                        if stop_before_entry:
                            final_status, final_price, final_stamp = "VOID", stop, stamp
                            break
                        continue
                    entered_at = stamp
                stop_hit = low <= stop if side == "BUY" else high >= stop
                touched = [i for i, target in enumerate(targets)
                           if (high >= target if side == "BUY" else low <= target)]
                if stop_hit:
                    final_status, final_price, final_stamp = "SL_HIT", stop, stamp
                    break
                if touched:
                    hit_indices.update(touched)
                    reached_target = max(hit_indices) + 1
                    if targets and reached_target >= len(targets):
                        final_status, final_price, final_stamp = f"TP{len(targets)}_HIT", targets[-1], stamp
                        break
            targets_json = json.dumps(sorted(hit_indices))
            if final_status:
                conn.execute(
                    """UPDATE goldsight_setup_history
                       SET status=%s, outcome_at=%s, outcome_price=%s,
                           entered_at=COALESCE(entered_at,%s), reached_target=%s,
                           targets_hit=%s::jsonb
                       WHERE id=%s AND status IN ('DETECTED','ACTIVE')""",
                    (final_status, final_stamp, final_price, entered_at, reached_target, targets_json, row["id"]),
                )
                updated += 1
            elif entered_at is not None or hit_indices:
                conn.execute(
                    """UPDATE goldsight_setup_history
                       SET status='ACTIVE', entered_at=COALESCE(entered_at,%s),
                           reached_target=%s, targets_hit=%s::jsonb
                       WHERE id=%s AND status IN ('DETECTED','ACTIVE')""",
                    (entered_at, reached_target, targets_json, row["id"]),
                )
                updated += 1
        conn.commit()
    return updated

def list_setups(limit: int = 50) -> list[dict[str, Any]]:
    if not database_configured():
        return []
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        rows = conn.execute("""
            SELECT id, symbol, timeframe, side, signal_time, detected_at, entry,
                   stop_loss, take_profits, rr, confidence, trend, reasons,
                   invalidation, provider, status, trade_type, news_context, outcome_at, outcome_price, entered_at, reached_target, targets_hit
            FROM goldsight_setup_history
            ORDER BY detected_at DESC
            LIMIT %s
        """, (max(1, min(limit, 200)),)).fetchall()
    for row in rows:
        row["signal_time"] = row["signal_time"].isoformat()
        row["detected_at"] = row["detected_at"].isoformat()
        for field in ("outcome_at", "entered_at"):
            if row.get(field):
                row[field] = row[field].isoformat()
    return rows
