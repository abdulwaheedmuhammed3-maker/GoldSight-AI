"""Persistent server-side recording of valid setups.

Requires DATABASE_URL pointing to a persistent PostgreSQL database. No browser
state or ephemeral local file is used as the source of truth.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta
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
        conn.execute("ALTER TABLE goldsight_setup_history ADD COLUMN IF NOT EXISTS entry_style TEXT NOT NULL DEFAULT 'STANDARD'")
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
        conn.execute("ALTER TABLE goldsight_notifications ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMPTZ")
        conn.commit()


def is_symbol_in_setup_cooldown(symbol: str, cooldown_minutes: int = 10) -> bool:
    """Check the symbol-wide setup cooldown across every timeframe."""
    if not database_configured():
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max(1, cooldown_minutes))
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        row = conn.execute(
            """SELECT 1 FROM goldsight_setup_history
               WHERE UPPER(symbol) = UPPER(%s) AND detected_at >= %s
               ORDER BY detected_at DESC LIMIT 1""",
            (symbol, cutoff),
        ).fetchone()
    return row is not None


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
        # Per-symbol cooldown spans all timeframes and blocks new history entries too.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"setup-generation-cooldown:{symbol.upper()}",))
        recent_setup = conn.execute(
            """
            SELECT id FROM goldsight_setup_history
            WHERE UPPER(symbol) = UPPER(%s)
              AND detected_at >= %s
            ORDER BY detected_at DESC LIMIT 1
            """,
            (symbol, datetime.now(timezone.utc) - timedelta(minutes=20)),
        ).fetchone()
        if recent_setup:
            conn.commit()
            return False
        result = conn.execute("""
            INSERT INTO goldsight_setup_history (
                signal_key, symbol, timeframe, side, signal_time, detected_at,
                entry, stop_loss, take_profits, rr, confidence, trend, reasons,
                invalidation, provider, trade_type, news_context, entry_style
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s,
                %s::jsonb, %s, %s, %s, %s::jsonb, %s
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
            signal.get("entry_style", "STANDARD"),
        ))
        conn.commit()
        inserted = result.fetchone() is not None
    if inserted:
        try:
            from app.push_notifications import classify_order_type, send_setup_notification
            # Notify for every newly recorded fresh BUY/SELL setup. Confidence is
            # displayed in the push itself; it does not suppress delivery.
            quote_price = market_data.get("ask") if side == "BUY" else market_data.get("bid")
            if quote_price is None:
                quote_price = market_data.get("price")
            order_type = classify_order_type(side, entry, quote_price)
            notification_signal = dict(signal)
            notification_signal["order_type"] = order_type
            send_setup_notification(symbol, timeframe, notification_signal, order_type)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Could not deliver setup push notification")
    return inserted



def _target_reached_before_entry(side: str, low: float, high: float, entry: float, targets: list[float]) -> bool:
    """Return true when price reaches a profit target without ever touching entry."""
    if low <= entry <= high:
        return False
    if side == "BUY":
        return low > entry and any(high >= target for target in targets)
    return high < entry and any(low <= target for target in targets)


def _same_candle_outcome(side: str, low: float, high: float, stop: float, targets: list[float]) -> tuple[str | None, float | None, list[int]]:
    """Resolve an SL/TP collision using target-touch priority for history display.

    OHLC candles cannot prove intrabar order. If a candle touches both the stop
    and one or more targets, record the highest touched target as the outcome
    rather than labeling the setup SL_HIT. This is an explicit target-priority
    convention, not proof of the intrabar sequence.
    """
    stop_hit = low <= stop if side == "BUY" else high >= stop
    touched = [i for i, target in enumerate(targets)
               if (high >= target if side == "BUY" else low <= target)]
    if touched:
        highest = max(touched)
        return f"TP{highest + 1}_HIT", targets[highest], touched
    if stop_hit:
        return "SL_HIT", stop, []
    return None, None, []


def _preserve_tp_outcome_after_stop(
    candle_status: str, candle_price: float | None, candle_stamp: datetime,
    hit_indices: set[int], targets: list[float], highest_tp_stamp: datetime | None,
) -> tuple[str, float | None, datetime]:
    """A setup that reached any TP remains TP_HIT in terminal history status."""
    if candle_status == "SL_HIT" and hit_indices:
        highest = max(hit_indices)
        return f"TP{highest + 1}_HIT", targets[highest], highest_tp_stamp or candle_stamp
    return candle_status, candle_price, candle_stamp


def refresh_setup_outcomes(symbol: str, timeframe: str, market_data: dict[str, Any]) -> int:
    """Track entry, TP progression, and final SL/TP outcome from completed candles.

    If SL and a target are touched in one candle, target-touch priority is used
    for history display because the requested convention is to record TP hits.
    A target reached before entry voids the missed setup.
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
               WHERE symbol=%s AND timeframe=%s AND status IN ('DETECTED','ACTIVE','TP1_HIT','TP2_HIT')
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
            highest_tp_stamp = None
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
                        if _target_reached_before_entry(side, low, high, entry, targets):
                            touched_before_entry = [
                                target for target in targets
                                if (high >= target if side == "BUY" else low <= target)
                            ]
                            missed_target = (
                                max(touched_before_entry) if side == "BUY"
                                else min(touched_before_entry)
                            )
                            final_status, final_price, final_stamp = "VOID", missed_target, stamp
                            break
                        continue
                    entered_at = stamp
                candle_status, candle_price, touched = _same_candle_outcome(side, low, high, stop, targets)
                if touched:
                    previous_highest = max(hit_indices) if hit_indices else -1
                    hit_indices.update(touched)
                    reached_target = max(hit_indices) + 1
                    if max(hit_indices) > previous_highest:
                        highest_tp_stamp = stamp
                if candle_status:
                    # TP1/TP2 are progress states, not terminal states: continue
                    # through later completed candles so the recorded outcome can
                    # advance to TP2/TP3. A stop or final target ends progression.
                    if candle_status == "SL_HIT" or (targets and reached_target >= len(targets)):
                        final_status, final_price, final_stamp = _preserve_tp_outcome_after_stop(
                            candle_status, candle_price, stamp, hit_indices, targets, highest_tp_stamp
                        )
                        break
                    final_status, final_price, final_stamp = candle_status, candle_price, stamp
            targets_json = json.dumps(sorted(hit_indices))
            if final_status:
                conn.execute(
                    """UPDATE goldsight_setup_history
                       SET status=%s, outcome_at=%s, outcome_price=%s,
                           entered_at=COALESCE(entered_at,%s), reached_target=%s,
                           targets_hit=%s::jsonb
                       WHERE id=%s AND status IN ('DETECTED','ACTIVE','TP1_HIT','TP2_HIT')""",
                    (final_status, final_stamp, final_price, entered_at, reached_target, targets_json, row["id"]),
                )
                updated += 1
            elif entered_at is not None or hit_indices:
                if row["status"] in {"TP1_HIT", "TP2_HIT"}:
                    # If this refresh lacks enough candle history to re-evaluate,
                    # retain the last known TP progress rather than reverting it.
                    conn.execute(
                        """UPDATE goldsight_setup_history
                           SET entered_at=COALESCE(entered_at,%s),
                               reached_target=%s, targets_hit=%s::jsonb
                           WHERE id=%s AND status IN ('TP1_HIT','TP2_HIT')""",
                        (entered_at, reached_target, targets_json, row["id"]),
                    )
                else:
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

def list_setups(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    if not database_configured():
        return []
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        rows = conn.execute("""
            SELECT id, symbol, timeframe, side, signal_time, detected_at, entry,
                   stop_loss, take_profits, rr, confidence, trend, reasons,
                   invalidation, provider, status, trade_type, entry_style, news_context, outcome_at, outcome_price, entered_at, reached_target, targets_hit
            FROM goldsight_setup_history
            ORDER BY detected_at DESC
            LIMIT %s OFFSET %s
        """, (max(1, min(limit, 200)), max(0, offset))).fetchall()
    for row in rows:
        row["signal_time"] = row["signal_time"].isoformat()
        row["detected_at"] = row["detected_at"].isoformat()
        for field in ("outcome_at", "entered_at"):
            if row.get(field):
                row[field] = row[field].isoformat()
    return rows
