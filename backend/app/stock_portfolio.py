"""Independent manual stock wallet; does not interact with demo trading or brokers."""
from datetime import datetime,timezone
import psycopg
from app.setup_history import database_configured,_database_url
from psycopg.rows import dict_row
CC={"NG":"NGN","US":"USD","GB":"GBP","CA":"CAD","ZA":"ZAR","IN":"INR","DE":"EUR","AU":"AUD"}
def _c(v):
 c=str(v or "NG").upper()
 if c not in CC: raise ValueError("Unsupported country.")
 return c
def _connect():
 if not database_configured(): raise RuntimeError("DATABASE_URL is not configured; persistent portfolio is unavailable.")
 return psycopg.connect(_database_url(),connect_timeout=8,row_factory=dict_row)
def _init(db):
 db.execute("CREATE TABLE IF NOT EXISTS tradesight_stock_wallet(country TEXT PRIMARY KEY,currency TEXT NOT NULL,cash_balance DOUBLE PRECISION NOT NULL DEFAULT 0,realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ NOT NULL)")
 db.execute("CREATE TABLE IF NOT EXISTS tradesight_stock_holdings(country TEXT NOT NULL,ticker TEXT NOT NULL,company TEXT NOT NULL,quantity DOUBLE PRECISION NOT NULL,average_cost DOUBLE PRECISION NOT NULL,updated_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(country,ticker))")
 db.execute("CREATE TABLE IF NOT EXISTS tradesight_stock_ledger(id BIGSERIAL PRIMARY KEY,country TEXT NOT NULL,currency TEXT NOT NULL,kind TEXT NOT NULL,ticker TEXT,company TEXT,quantity DOUBLE PRECISION,price DOUBLE PRECISION,fees DOUBLE PRECISION NOT NULL,gross DOUBLE PRECISION NOT NULL,realized_pnl DOUBLE PRECISION NOT NULL,note TEXT,created_at TIMESTAMPTZ NOT NULL)")
def _wallet(db,c):
 now=datetime.now(timezone.utc)
 db.execute("INSERT INTO tradesight_stock_wallet(country,currency,updated_at) VALUES(%s,%s,%s) ON CONFLICT(country) DO NOTHING",(c,CC[c],now))
 return db.execute("SELECT * FROM tradesight_stock_wallet WHERE country=%s FOR UPDATE",(c,)).fetchone()
def get_portfolio(country="NG"):
 c=_c(country)
 with _connect() as db:
  _init(db); w=_wallet(db,c)
  h=db.execute("SELECT ticker,company,quantity,average_cost,quantity*average_cost AS cost_basis FROM tradesight_stock_holdings WHERE country=%s AND quantity>0 ORDER BY ticker",(c,)).fetchall()
  tx=db.execute("SELECT id,kind,ticker,company,quantity,price,fees,gross,realized_pnl,note,created_at FROM tradesight_stock_ledger WHERE country=%s ORDER BY id DESC LIMIT 100",(c,)).fetchall()
 return {"status":"ok","country":c,"currency":w["currency"],"cash_balance":round(w["cash_balance"],2),"realized_pnl":round(w["realized_pnl"],2),"holdings":h,"transactions":tx,"note":"Manual stock portfolio, separate from demo wallet. Actual fills only; no orders are placed."}
def deposit(country,amount,note=None):
 c=_c(country); a=float(amount)
 if not 0<a<1e12: raise ValueError("Deposit must be positive.")
 now=datetime.now(timezone.utc)
 with _connect() as db:
  _init(db); _wallet(db,c)
  db.execute("UPDATE tradesight_stock_wallet SET cash_balance=cash_balance+%s,updated_at=%s WHERE country=%s",(a,now,c))
  db.execute("INSERT INTO tradesight_stock_ledger(country,currency,kind,fees,gross,realized_pnl,note,created_at) VALUES(%s,%s,'DEPOSIT',0,%s,0,%s,%s)",(c,CC[c],a,(note or "Wallet funding")[:250],now))
 return get_portfolio(c)
def trade(country,ticker,company,side,quantity,price,fees=0,note=None):
 c=_c(country); t=str(ticker or "").strip().upper(); n=str(company or t)[:150]; s=str(side or "").upper()
 q=float(quantity); p=float(price); f=float(fees or 0)
 if not t or s not in ("BUY","SELL") or not(0<q<1e12 and 0<p<1e12 and 0<=f<1e12): raise ValueError("Enter valid ticker, BUY/SELL, positive quantity/price and non-negative fees.")
 gross=q*p; now=datetime.now(timezone.utc)
 with _connect() as db:
  _init(db); w=_wallet(db,c)
  h=db.execute("SELECT * FROM tradesight_stock_holdings WHERE country=%s AND ticker=%s FOR UPDATE",(c,t)).fetchone()
  oq=float(h["quantity"]) if h else 0.; avg=float(h["average_cost"]) if h else 0.; pnl=0.
  if s=="BUY":
   cost=gross+f
   if w["cash_balance"]+1e-8<cost: raise ValueError(f"Insufficient stock wallet cash. Need {cost:.2f} {CC[c]}; available {w['cash_balance']:.2f}.")
   nq=oq+q; na=(oq*avg+gross+f)/nq
   db.execute("INSERT INTO tradesight_stock_holdings(country,ticker,company,quantity,average_cost,updated_at) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(country,ticker) DO UPDATE SET company=EXCLUDED.company,quantity=EXCLUDED.quantity,average_cost=EXCLUDED.average_cost,updated_at=EXCLUDED.updated_at",(c,t,n,nq,na,now))
   db.execute("UPDATE tradesight_stock_wallet SET cash_balance=cash_balance-%s,updated_at=%s WHERE country=%s",(cost,now,c))
  else:
   if not h or oq+1e-8<q: raise ValueError(f"Cannot sell {q:g}; holding available is {oq:g}.")
   pnl=gross-f-q*avg; nq=oq-q
   if nq<=1e-8: db.execute("DELETE FROM tradesight_stock_holdings WHERE country=%s AND ticker=%s",(c,t))
   else: db.execute("UPDATE tradesight_stock_holdings SET quantity=%s,updated_at=%s WHERE country=%s AND ticker=%s",(nq,now,c,t))
   db.execute("UPDATE tradesight_stock_wallet SET cash_balance=cash_balance+%s,realized_pnl=realized_pnl+%s,updated_at=%s WHERE country=%s",(gross-f,pnl,now,c))
  db.execute("INSERT INTO tradesight_stock_ledger(country,currency,kind,ticker,company,quantity,price,fees,gross,realized_pnl,note,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",(c,CC[c],s,t,n,q,p,f,gross,pnl,(note or "")[:250],now))
 return get_portfolio(c)
