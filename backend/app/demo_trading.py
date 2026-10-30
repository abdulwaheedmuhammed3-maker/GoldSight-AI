"""Persistent paper-trading account. R-based simulation; never places broker orders."""
from __future__ import annotations
import json
import os
from datetime import datetime, timezone
from typing import Any
import psycopg
from psycopg.rows import dict_row
from app.setup_history import database_configured, _database_url

STARTING_BALANCE = 100_000.0
RISK_FRACTION = 0.01
MAX_OPEN_TRADES = 2

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
            signal_candle_time BIGINT NOT NULL DEFAULT 0
          )
        """)
        conn.execute("ALTER TABLE goldsight_demo_trades ADD COLUMN IF NOT EXISTS signal_candle_time BIGINT NOT NULL DEFAULT 0")
        now = datetime.now(timezone.utc)
        conn.execute("""INSERT INTO goldsight_demo_account
          (id,balance,starting_balance,auto_trade,created_at,updated_at)
          VALUES (1,%s,%s,TRUE,%s,%s) ON CONFLICT (id) DO NOTHING
        """, (STARTING_BALANCE, STARTING_BALANCE, now, now))
        conn.commit()

def _account(conn):
    row = conn.execute("SELECT * FROM goldsight_demo_account WHERE id=1").fetchone()
    if not row:
        raise RuntimeError("Demo account has not been initialized.")
    return row

def process_demo_market(symbol: str, timeframe: str, market_data: dict[str, Any]) -> None:
    """Close open trades from completed candles, then auto-open a fresh aligned setup if capacity allows.
    Conservative same-candle rule: if TP and SL are both touched, assume SL first.
    """
    if not database_configured() or market_data.get("status") != "LIVE":
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
        account = _account(conn)
        open_trades = conn.execute("SELECT * FROM goldsight_demo_trades WHERE status='OPEN' ORDER BY opened_at").fetchall()
        for trade in open_trades:
            if trade["symbol"] != symbol or trade["timeframe"] != timeframe or int(bar["time"]) <= int(trade.get("signal_candle_time") or 0):
                continue
            high, low = float(bar["high"]), float(bar["low"])
            if trade["side"] == "BUY":
                hit_sl, hit_tp = low <= trade["stop_loss"], high >= trade["take_profit"]
            else:
                hit_sl, hit_tp = high >= trade["stop_loss"], low <= trade["take_profit"]
            if not hit_sl and not hit_tp:
                continue
            # If both levels fall inside one candle, take the conservative stop-loss outcome.
            won = hit_tp and not hit_sl
            pnl = trade["risk_amount"] if won else -trade["risk_amount"]
            exit_price = trade["take_profit"] if won else trade["stop_loss"]
            reason = "TP1" if won else "SL" if hit_sl else "TP1"
            conn.execute("""UPDATE goldsight_demo_trades SET status='CLOSED',closed_at=%s,
              exit_price=%s,pnl=%s,close_reason=%s WHERE id=%s""",
              (now, exit_price, pnl, reason, trade["id"]))
            conn.execute("UPDATE goldsight_demo_account SET balance=balance+%s,updated_at=%s WHERE id=1", (pnl, now))
        # Refresh account and capacity after closes.
        account = _account(conn)
        count = conn.execute("SELECT count(*) AS n FROM goldsight_demo_trades WHERE status='OPEN'").fetchone()["n"]
        if count < MAX_OPEN_TRADES and account["auto_trade"] and signal.get("status") in {"BUY","SELL"} and signal.get("signal_fresh") is True:
            entry, stop, targets = signal.get("entry"), signal.get("stop_loss"), signal.get("take_profits") or []
            signal_time = signal.get("signal_time")
            if entry is not None and stop is not None and targets and signal_time:
                side = signal["status"]
                risk_distance = abs(float(entry) - float(stop))
                if risk_distance > 0:
                    key = f"{symbol}:{timeframe}:{side}:{signal_time}"
                    signal_dt = datetime.fromisoformat(str(signal_time).replace("Z", "+00:00"))
                    signal_candle_time = int(signal_dt.timestamp())
                    risk_cash = max(0.0, float(account["balance"]) * RISK_FRACTION)
                    conn.execute("""INSERT INTO goldsight_demo_trades
                      (signal_key,symbol,timeframe,side,entry,stop_loss,take_profit,risk_amount,status,opened_at,signal_candle_time)
                      VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'OPEN',%s,%s) ON CONFLICT (signal_key) DO NOTHING""",
                      (key,symbol,timeframe,side,float(entry),float(stop),float(targets[0]),risk_cash,now,signal_candle_time))
        conn.commit()

def get_demo_account() -> dict[str, Any]:
    if not database_configured():
        raise RuntimeError("Demo trading requires DATABASE_URL.")
    initialize_demo_store()
    with psycopg.connect(_database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        account = _account(conn)
        trades = conn.execute("SELECT * FROM goldsight_demo_trades ORDER BY opened_at DESC LIMIT 100").fetchall()
        opened = [t for t in trades if t["status"] == "OPEN"]
        closed = [t for t in trades if t["status"] == "CLOSED"]
        realized = sum(float(t["pnl"] or 0) for t in closed)
        return {
          "status":"ok","currency":"NGN","balance":round(float(account["balance"]),2),
          "starting_balance":float(account["starting_balance"]),
          "realized_pnl":round(realized,2),"open_count":len(opened),
          "max_open_trades":MAX_OPEN_TRADES,"risk_per_trade_pct":RISK_FRACTION*100,
          "auto_trade":bool(account["auto_trade"]),
          "management":"Full position closes at TP1 or SL. If both are touched in one candle, SL is assumed first.",
          "sizing_note":"R-based paper simulation: each trade risks 1% of the current NGN balance and earns/loses 1R at TP1/SL. No broker lot sizing, commission, slippage or FX conversion is modeled.",
          "trades":[{**t,"opened_at":t["opened_at"].isoformat(),"closed_at":t["closed_at"].isoformat() if t["closed_at"] else None} for t in trades]
        }

def reset_demo_account() -> dict[str, Any]:
    if not database_configured():
        raise RuntimeError("Demo trading requires DATABASE_URL.")
    initialize_demo_store()
    now=datetime.now(timezone.utc)
    with psycopg.connect(_database_url(),connect_timeout=8) as conn:
        conn.execute("UPDATE goldsight_demo_trades SET status='RESET',closed_at=%s,close_reason='ACCOUNT RESET' WHERE status='OPEN'",(now,))
        conn.execute("UPDATE goldsight_demo_account SET balance=%s,starting_balance=%s,auto_trade=TRUE,updated_at=%s WHERE id=1",(STARTING_BALANCE,STARTING_BALANCE,now))
        conn.commit()
    return get_demo_account()
