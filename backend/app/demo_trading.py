"""Persistent broker-aware paper-trading account; never places broker orders."""
from __future__ import annotations
import json
import logging
import math
import os
from datetime import datetime, timezone
from typing import Any
import psycopg
from psycopg.rows import dict_row
from app.setup_history import database_configured, _database_url

STARTING_BALANCE = 300_000.0
RISK_FRACTION = 0.01
MAX_OPEN_TRADES = 3
MAX_MARGIN_UTILIZATION = 0.50

# User-selected fixed volumes for the demo account.
DEMO_FIXED_LOTS = {"XAUUSD": 0.01, "BTCUSD": 0.03, "EURUSD": 0.08, "GBPUSD": 0.08}

logger = logging.getLogger(__name__)


def _has_margin_capacity(balance: float, used_margin: float, new_margin: float) -> bool:
    """Keep total used margin at or below half of demo equity."""
    values = (balance, used_margin, new_margin)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        return False
    if balance <= 0 or used_margin < 0 or new_margin < 0:
        return False
    margin_limit = balance * MAX_MARGIN_UTILIZATION
    return used_margin + new_margin <= margin_limit + 1e-8


def _signal_matches_latest_bar(signal_time: str | None, bar_time: int) -> bool:
    """Reject stale signals unless they were generated from this exact closed bar."""
    if not isinstance(signal_time, str) or not signal_time.strip():
        return False
    try:
        parsed = datetime.fromisoformat(signal_time.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp()) == int(bar_time)
    except (TypeError, ValueError, OverflowError):
        return False


def _valid_trade_levels(side: str, entry: Any, stop: Any, target: Any) -> bool:
    """Validate finite, correctly ordered entry, stop and first target prices."""
    try:
        entry, stop, target = float(entry), float(stop), float(target)
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(value) and value > 0 for value in (entry, stop, target)):
        return False
    side = str(side).upper()
    return (side == "BUY" and stop < entry < target) or (side == "SELL" and target < entry < stop)


def _usd_ngn_demo_rate() -> tuple[float | None, str]:
    """Prefer an explicitly supplied broker conversion; otherwise use a labelled
    public reference rate for paper-account estimates only."""
    try:
        rate = float(os.getenv("EXNESS_USD_NGN_RATE", "").strip())
        if math.isfinite(rate) and rate > 0:
            return rate, "BROKER_CONFIGURED"
    except (TypeError, ValueError):
        pass
    try:
        from app.currency_rates import get_currency_rates
        payload = get_currency_rates("USD")
        rate = float(payload.get("rates", {}).get("NGN"))
        if math.isfinite(rate) and rate > 0 and payload.get("status") == "LIVE":
            return rate, "PUBLIC_REFERENCE_ESTIMATE"
    except (RuntimeError, TypeError, ValueError, KeyError):
        logger.warning("Unable to obtain USD/NGN reference rate for demo sizing.")
    return None, "UNAVAILABLE"

def initialize_demo_store() -> None:
    if not database_configured():
        return
    with psycopg.connect(_database_url(), connect_timeout=8) as conn:
        conn.execute("""
          CREATE TABLE IF NOT EXISTS goldsight_demo_account (
            id INTEGER PRIMARY KEY CHECK (id=1),
            balance DOUBLE PRECISION NOT NULL,
            starting_balance DOUBLE PRECISION NOT NULL,
            auto_trade BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          )
        """)
        conn.execute("""
          CREATE TABLE IF NOT EXISTS goldsight_demo_trades (
            id BIGSERIAL PRIMARY KEY,
            signal_key TEXT NOT NULL UNIQUE,
            symbol TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
            entry DOUBLE PRECISION NOT NULL,
            stop_loss DOUBLE PRECISION NOT NULL,
            take_profit DOUBLE PRECISION NOT NULL,
            risk_amount DOUBLE PRECISION NOT NULL,
            status TEXT NOT NULL DEFAULT 'OPEN',
            opened_at TIMESTAMPTZ NOT NULL,
            closed_at TIMESTAMPTZ,
            exit_price DOUBLE PRECISION,
            pnl DOUBLE PRECISION,
            close_reason TEXT,
            signal_candle_time BIGINT NOT NULL DEFAULT 0,
            target_levels TEXT NOT NULL DEFAULT '[]'
          )
        """)
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS signal_candle_time BIGINT NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS target_levels TEXT NOT NULL DEFAULT '[]'")
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS lot_size DOUBLE PRECISION")
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS estimated_margin DOUBLE PRECISION")
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS quote_to_account_rate DOUBLE PRECISION")
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS contract_size DOUBLE PRECISION")
        now = datetime.now(timezone.utc)
        conn.execute("""INSERT INTO goldsight_demo_account
          (id,balance,starting_balance,auto_trade,created_at,updated_at)
          VALUES (1,%s,%s,TRUE,%s,%s) ON CONFLICT (id) DO NOTHING
        """, (STARTING_BALANCE, STARTING_BALANCE, now, now))
        # Upgrade a legacy ₦100,000 account when it has no active or
        # settled trades. RESET rows are retained as audit history and must
        # not prevent the one-time starting-balance migration.
        conn.execute("""UPDATE goldsight_demo_account
          SET balance=%s, starting_balance=%s, updated_at=%s
          WHERE id=1 AND starting_balance=100000
            AND NOT EXISTS (
              SELECT 1 FROM goldsight_demo_trades
              WHERE status IN ('OPEN','CLOSED')
            )
        """, (STARTING_BALANCE, STARTING_BALANCE, now))
        conn.commit()

def _account(conn, for_update: bool = False):
    # Lock the singleton account row for the full market-processing transaction.
    # Concurrent symbol/timeframe workers then re-check open count and margin
    # against committed state before any new entry can be inserted.
    query = "SELECT * FROM goldsight_demo_account WHERE id=1"
    if for_update:
        query += " FOR UPDATE"
    row = conn.execute(query).fetchone()
    if not row:
        raise RuntimeError("Demo account has not been initialized.")
    return row

def process_demo_market(symbol: str, timeframe: str, market_data: dict[str, Any], allow_new_entries: bool = True) -> None:
    """Close open trades from completed candles, then auto-open a fresh aligned setup if capacity allows.
    If TP and SL are touched in the same candle, prioritize the highest TP level reached.
    """
    if not database_configured() or market_data.get("status") != "LIVE":
        return
    # BTCUSD demo trades require the actual Exness CFD feed; never use BTCUSDT spot.
    if symbol == "BTCUSD" and "exness" not in str(market_data.get("provider", "")).lower():
        logger.info("Skipping BTCUSD demo processing: an Exness CFD feed is required.")
        return
    signal = market_data.get("signal") or {}
    candles = market_data.get("candles") or []
    if not candles:
        return
    # API market endpoint has already filtered signal candles; for trade management,
    # use the last fully completed candle only.
    from app.market import completed_candles
    bars = completed_candles(candles, timeframe)
    if not bars:
        return
    bar = bars[-1]
    now = datetime.now(timezone.utc)
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        account = _account(conn, for_update=True)
        open_trades = conn.execute("SELECT * FROM goldsight_demo_trades WHERE status='OPEN' ORDER BY opened_at").fetchall()
        for trade in open_trades:
            if trade["symbol"] != symbol or trade["timeframe"] != timeframe or int(bar["time"]) <= int(trade.get("signal_candle_time") or 0):
                continue
            high, low = float(bar["high"]), float(bar["low"])
            hit_sl = low <= trade["stop_loss"] if trade["side"] == "BUY" else high >= trade["stop_loss"]
            try:
                stored_targets = json.loads(trade.get("target_levels") or "[]")
                targets = [float(value) for value in stored_targets if math.isfinite(float(value)) and float(value) > 0]
            except (TypeError, ValueError, json.JSONDecodeError):
                targets = []
            # Legacy positions have only TP1 saved.
            if not targets:
                targets = [float(trade["take_profit"])]

            hit_targets = []
            for index, target in enumerate(targets[:3], start=1):
                reached = high >= target if trade["side"] == "BUY" else low <= target
                if reached:
                    hit_targets.append((index, target))
            if not hit_sl and not hit_targets:
                continue

            # OHLC candles cannot prove intrabar ordering. Per requested behavior,
            # prioritize any reached target over SL and choose the highest TP reached.
            won = bool(hit_targets)
            if won:
                target_index, exit_price = hit_targets[-1]
                reason = f"TP{target_index}"
            else:
                exit_price = float(trade["stop_loss"])
                reason = "SL"

            if trade.get("lot_size") and trade.get("contract_size") and trade.get("quote_to_account_rate"):
                direction = 1.0 if trade["side"] == "BUY" else -1.0
                pnl = (exit_price - float(trade["entry"])) * direction * float(trade["lot_size"]) * float(trade["contract_size"]) * float(trade["quote_to_account_rate"])
            else:
                risk_distance = abs(float(trade["entry"]) - float(trade["stop_loss"]))
                reward_distance = abs(float(exit_price) - float(trade["entry"]))
                pnl = float(trade["risk_amount"]) * reward_distance / risk_distance if won and risk_distance > 0 else -float(trade["risk_amount"])
            conn.execute("""UPDATE goldsight_demo_trades SET status='CLOSED',closed_at=%s,
              exit_price=%s,pnl=%s,close_reason=%s WHERE id=%s""",
              (now, exit_price, pnl, reason, trade["id"]))
            conn.execute("UPDATE goldsight_demo_account SET balance=balance+%s,updated_at=%s WHERE id=1", (pnl, now))
        # Refresh account and capacity after closes.
        account = _account(conn)
        count = conn.execute("SELECT count(*) AS n FROM goldsight_demo_trades WHERE status='OPEN'").fetchone()["n"]
        # BTCUSD is enabled using the verified Exness Standard CFD contract only.
        if allow_new_entries and count < MAX_OPEN_TRADES and account["auto_trade"] and symbol in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"} and signal.get("status") in {"BUY", "SELL"} and signal.get("signal_fresh") is True:
            entry, stop, targets = signal.get("entry"), signal.get("stop_loss"), signal.get("take_profits") or []
            signal_time = signal.get("signal_time")
            # A fresh flag alone is not enough: the setup must belong to the
            # exact latest completed candle currently being processed.
            if not targets or not _signal_matches_latest_bar(signal_time, int(bar["time"])) or not _valid_trade_levels(signal.get("status"), entry, stop, targets[0]):
                conn.commit()
                return
            fx_rate, fx_rate_source = _usd_ngn_demo_rate()
            if fx_rate is not None:
                try:
                    contract_size = 100.0 if symbol == "XAUUSD" else 1.0 if symbol == "BTCUSD" else 100_000.0
                    leverage = float(os.getenv("DEMO_LEVERAGE", "200"))
                    margin_per_lot_quote = None
                    if symbol == "BTCUSD":
                        # Crypto CFD margin is not determined by account leverage.
                        # Use a conservative 0.5% estimate unless explicitly configured.
                        margin_rate = float(os.getenv("DEMO_BTCUSD_MARGIN_RATE", "0.005"))
                        if not math.isfinite(margin_rate) or not 0 < margin_rate <= 0.05:
                            raise ValueError("DEMO_BTCUSD_MARGIN_RATE must be between 0 and 0.05.")
                        margin_per_lot_quote = float(entry) * contract_size * margin_rate
                    from app.risk_calculator import calculate_position_size
                    sizing = calculate_position_size(
                        symbol=symbol, side=signal["status"],
                        balance=float(account["balance"]), risk_pct=RISK_FRACTION * 100,
                        entry=float(entry), stop_loss=float(stop), leverage=leverage,
                        contract_size=contract_size, quote_to_account_rate=fx_rate,
                        volume_step=0.01,
                        min_volume=DEMO_FIXED_LOTS[symbol],
                        max_volume=DEMO_FIXED_LOTS[symbol],
                        margin_per_lot_quote=margin_per_lot_quote,
                    )
                    used_margin = conn.execute(
                        "SELECT COALESCE(SUM(estimated_margin),0) AS total FROM goldsight_demo_trades WHERE status='OPEN'"
                    ).fetchone()["total"]
                    # Preserve a 50% free-margin buffer; do not consume the
                    # entire demo balance with estimated margin requirements.
                    # Fixed volumes are used only when the configured size stays within
                    # the existing 1% risk budget; never force a risk-over-budget entry.
                    if (sizing["status"] == "OK"
                        and float(sizing["estimated_loss"]) <= float(sizing["risk_budget"])
                        and _has_margin_capacity(
                        float(account["balance"]), float(used_margin or 0),
                        float(sizing["estimated_margin"]),
                    )):
                        side = signal["status"]
                        key = "{}:{}:{}:{}".format(symbol, timeframe, side, signal_time)
                        signal_dt = datetime.fromisoformat(str(signal_time).replace("Z", "+00:00"))
                        signal_candle_time = int(signal_dt.timestamp())
                        conn.execute("""INSERT INTO goldsight_demo_trades
                          (signal_key,symbol,timeframe,side,entry,stop_loss,take_profit,risk_amount,status,opened_at,signal_candle_time,lot_size,estimated_margin,quote_to_account_rate,contract_size,target_levels)
                          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'OPEN',%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (signal_key) DO NOTHING""",
                          (key, symbol, timeframe, side, float(entry), float(stop), float(targets[0]),
                           float(sizing["estimated_loss"]), now, signal_candle_time,
                           float(sizing["recommended_lot"]), float(sizing["estimated_margin"]), fx_rate, contract_size,
                           json.dumps([float(value) for value in targets[:3]])))
                except (TypeError, ValueError, KeyError) as sizing_exc:
                    logger.warning("Demo sizing rejected %s %s: %s", symbol, timeframe, sizing_exc)
        conn.commit()

def get_demo_account() -> dict[str, Any]:
    if not database_configured():
        raise RuntimeError("Demo trading requires DATABASE_URL.")
    initialize_demo_store()
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        account = _account(conn)
        # Keep the history payload bounded, but calculate account-wide metrics
        # independently so the 100-row display limit cannot distort totals.
        trades = conn.execute("SELECT * FROM goldsight_demo_trades ORDER BY opened_at DESC LIMIT 100").fetchall()
        totals = conn.execute("""
          SELECT COUNT(*) FILTER (WHERE status='OPEN') AS open_count,
                 COALESCE(SUM(pnl) FILTER (WHERE status='CLOSED'), 0) AS realized_pnl
          FROM goldsight_demo_trades
        """).fetchone()
        realized = float(totals["realized_pnl"] or 0)
        return {
          "status":"ok","currency":"NGN","balance":round(float(account["balance"]),2),
          "starting_balance":float(account["starting_balance"]),
          "realized_pnl":round(realized,2),"open_count":int(totals["open_count"] or 0),
          "max_open_trades":MAX_OPEN_TRADES,"risk_per_trade_pct":RISK_FRACTION*100,
          "max_margin_utilization_pct":MAX_MARGIN_UTILIZATION*100,
          "auto_trade":bool(account["auto_trade"]),
          "management":"Full position closes at the highest reached TP1/TP2/TP3 or SL. When TP and SL are both touched in the same completed candle, the highest reached TP takes priority.",
          "sizing_note":"Demo starts at ₦300,000 with fixed user-selected volumes: XAUUSD 0.01 lot, BTCUSD 0.03 lot, EURUSD 0.08 lot, GBPUSD 0.08 lot. Fixed volume entries are rejected if estimated stop-loss risk exceeds the 1% NGN risk budget. Uses 1:200 default leverage. Uses an explicitly configured broker USD/NGN rate when available, otherwise a clearly labelled public reference rate for paper estimates only. EURUSD and GBPUSD use 100,000-unit contracts; XAUUSD uses 100 oz. BTCUSD uses the verified Exness Standard CFD contract (1 BTC per lot, 0.01 minimum/step), requires an Exness-labelled live CFD feed, and uses DEMO_BTCUSD_MARGIN_RATE (default 0.5% conservative estimate) for margin rather than account leverage. Total estimated margin is capped at 50% of demo equity to preserve a free-margin buffer. Entries must match the latest completed candle and have correctly ordered finite price levels. Spread, commission, swap and slippage are not modeled.",
          "risk_engine":"BROKER_AWARE_MULTI_ASSET",
          "fx_rate_configured":_usd_ngn_demo_rate()[0] is not None,
          "fx_rate_source":_usd_ngn_demo_rate()[1],
          "supported_demo_symbols":["XAUUSD","BTCUSD","EURUSD","GBPUSD"],
          "trades":[{**t,"opened_at":t["opened_at"].isoformat(),"closed_at":t["closed_at"].isoformat() if t["closed_at"] else None} for t in trades]
        }

def reset_demo_account() -> dict[str, Any]:
    if not database_configured():
        raise RuntimeError("Demo trading requires DATABASE_URL.")
    initialize_demo_store()
    from app.setup_history import initialize_history_store
    initialize_history_store()
    now=datetime.now(timezone.utc)
    with psycopg.connect(_database_url(),connect_timeout=8) as conn:
        # Acquire the account lock first, matching process_demo_market lock order.
        # Clear paper trades and signal history in one transaction; do not retain
        # RESET audit rows because reset is an explicit global history wipe.
        conn.execute("SELECT id FROM goldsight_demo_account WHERE id=1 FOR UPDATE")
        conn.execute("LOCK TABLE goldsight_setup_history IN ACCESS EXCLUSIVE MODE")
        conn.execute("DELETE FROM goldsight_demo_trades")
        conn.execute("DELETE FROM goldsight_setup_history")
        conn.execute("UPDATE goldsight_demo_account SET balance=%s,starting_balance=%s,auto_trade=TRUE,updated_at=%s WHERE id=1",(STARTING_BALANCE,STARTING_BALANCE,now))
        conn.commit()
    return get_demo_account()
