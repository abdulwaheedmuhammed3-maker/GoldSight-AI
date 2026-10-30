"""Separate manual stock holdings ledger. This is not connected to the demo wallet or a broker."""
from __future__ import annotations
import hashlib, os
from datetime import datetime, timezone
from typing import Any
import psycopg
from psycopg.rows import dict_row
from app.setup_history import _database_url, database_configured

CURRENCIES={"NG":"NGN","US":"USD","GB":"GBP","CA":"CAD","ZA":"ZAR","IN":"INR","DE":"EUR","AU":"AUD"}

def _owner_hash(key: str) -> str:
    if not key or len(key)<32:
        raise ValueError("A valid private portfolio key is required.")
    return hashlib.sha256(key.encode("utf-8")).hexdigest()

def _connect():
    if not database_configured():
        raise RuntimeError("DATABASE_URL is not configured; stock portfolio storage is unavailable.")
    return psycopg.connect(_database_url(),connect_timeout=8,row_factory=dict_row)

def initialize_portfolio_store():
    if not database_configured(): return
    with _connect() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS tradesight_stock_positions (
          owner_hash TEXT NOT NULL, country TEXT NOT NULL, ticker TEXT NOT NULL,
          company TEXT NOT NULL, currency TEXT NOT NULL, quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
          average_cost DOUBLE PRECISION NOT NULL DEFAULT 0, realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(owner_hash,country,ticker))
        """)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS tradesight_stock_transactions (
          id BIGSERIAL PRIMARY KEY, owner_hash TEXT NOT NULL, country TEXT NOT NULL,
          ticker TEXT NOT NULL, company TEXT NOT NULL, currency TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('BUY','SELL')), quantity DOUBLE PRECISION NOT NULL,
          price DOUBLE PRECISION NOT NULL, fees DOUBLE PRECISION NOT NULL DEFAULT 0,
          gross_value DOUBLE PRECISION NOT NULL, realized_pnl DOUBLE PRECISION,
          transacted_at TIMESTAMPTZ NOT NULL
        )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS tradesight_stock_tx_owner_idx ON tradesight_stock_transactions(owner_hash,transacted_at DESC)")
        conn.commit()

def get_portfolio(key: str) -> dict[str,Any]:
    owner=_owner_hash(key)
    with _connect() as conn:
        positions=conn.execute("""SELECT country,ticker,company,currency,quantity,average_cost,
          quantity*average_cost AS cost_basis,realized_pnl,updated_at
          FROM tradesight_stock_positions WHERE owner_hash=%s AND quantity>0 ORDER BY updated_at DESC""",(owner,)).fetchall()
        transactions=conn.execute("""SELECT id,country,ticker,company,currency,side,quantity,price,fees,
          gross_value,realized_pnl,transacted_at FROM tradesight_stock_transactions
          WHERE owner_hash=%s ORDER BY transacted_at DESC LIMIT 100""",(owner,)).fetchall()
        totals=conn.execute("""SELECT COALESCE(SUM(realized_pnl),0) AS realized_pnl,
          COUNT(*) FILTER (WHERE side='BUY') AS buy_count,
          COUNT(*) FILTER (WHERE side='SELL') AS sell_count
          FROM tradesight_stock_transactions WHERE owner_hash=%s""",(owner,)).fetchone()
    return {"status":"LIVE","wallet_type":"STOCK_INVESTMENT_LEDGER","separate_from_demo_wallet":True,
      "positions":[dict(x) for x in positions],"transactions":[dict(x) for x in transactions],
      "summary":{"realized_pnl":float(totals["realized_pnl"] or 0),"open_positions":len(positions),
      "buy_transactions":totals["buy_count"],"sell_transactions":totals["sell_count"],
      "cost_basis":sum(float(x["cost_basis"]) for x in positions)},
      "note":"Manual record-keeping only. Buys and sells must already have been executed with your broker. No money is held or transferred by TradeSight."}

def record_transaction(key: str, *, country: str, ticker: str, company: str,
                       side: str, quantity: float, price: float, fees: float=0) -> dict[str,Any]:
    owner=_owner_hash(key); country=country.upper(); side=side.upper(); ticker=ticker.upper().strip()
    if country not in CURRENCIES: raise ValueError("Unsupported country or market.")
    if side not in {"BUY","SELL"}: raise ValueError("Transaction side must be BUY or SELL.")
    if not ticker or not company.strip(): raise ValueError("Ticker and company name are required.")
    if quantity<=0 or price<=0 or fees<0: raise ValueError("Quantity and price must be positive; fees cannot be negative.")
    currency=CURRENCIES[country]; now=datetime.now(timezone.utc)
    with _connect() as conn:
        row=conn.execute("""SELECT quantity,average_cost,realized_pnl FROM tradesight_stock_positions
          WHERE owner_hash=%s AND country=%s AND ticker=%s FOR UPDATE""",(owner,country,ticker)).fetchone()
        old_qty=float(row["quantity"]) if row else 0.0
        old_avg=float(row["average_cost"]) if row else 0.0
        realized=None
        gross=quantity*price
        if side=="SELL":
            if quantity>old_qty+1e-9: raise ValueError(f"Cannot sell {quantity:g}; only {old_qty:g} shares are recorded in this portfolio.")
            realized=quantity*(price-old_avg)-fees
            new_qty=max(0.0,old_qty-quantity)
            new_avg=old_avg if new_qty>1e-9 else 0.0
            new_realized=(float(row["realized_pnl"]) if row else 0.0)+realized
        else:
            new_qty=old_qty+quantity
            new_avg=((old_qty*old_avg)+(gross+fees))/new_qty
            new_realized=float(row["realized_pnl"]) if row else 0.0
        conn.execute("""INSERT INTO tradesight_stock_positions
          (owner_hash,country,ticker,company,currency,quantity,average_cost,realized_pnl,updated_at)
          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
          ON CONFLICT(owner_hash,country,ticker) DO UPDATE SET company=EXCLUDED.company,
          currency=EXCLUDED.currency,quantity=EXCLUDED.quantity,average_cost=EXCLUDED.average_cost,
          realized_pnl=EXCLUDED.realized_pnl,updated_at=EXCLUDED.updated_at""",
          (owner,country,ticker,company.strip(),currency,new_qty,new_avg,new_realized,now))
        conn.execute("""INSERT INTO tradesight_stock_transactions
          (owner_hash,country,ticker,company,currency,side,quantity,price,fees,gross_value,realized_pnl,transacted_at)
          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
          (owner,country,ticker,company.strip(),currency,side,quantity,price,fees,gross,realized,now))
        conn.commit()
    return get_portfolio(key)
