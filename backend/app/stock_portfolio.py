"""Private stock investment wallet, isolated from the demo trading account."""
from datetime import datetime,timezone
import hashlib
import psycopg
from psycopg.rows import dict_row
from app.setup_history import database_configured,_database_url

CC={"NG":"NGN","US":"USD","GB":"GBP","CA":"CAD","ZA":"ZAR","IN":"INR","DE":"EUR","AU":"AUD"}

def _c(value):
 c=str(value or "NG").upper()
 if c not in CC: raise ValueError("Unsupported country.")
 return c

def _owner(key):
 if not isinstance(key,str) or len(key)<32: raise ValueError("A valid private stock wallet key is required.")
 return hashlib.sha256(key.encode("utf-8")).hexdigest()

def _connect():
 if not database_configured(): raise RuntimeError("DATABASE_URL is not configured; persistent stock wallet is unavailable.")
 return psycopg.connect(_database_url(),connect_timeout=8,row_factory=dict_row)

def initialize_portfolio_store():
 if not database_configured(): return
 with _connect() as db:
  db.execute("""CREATE TABLE IF NOT EXISTS tradesight_stock_wallet_v2(
   owner_hash TEXT NOT NULL,country TEXT NOT NULL,currency TEXT NOT NULL,
   cash_balance DOUBLE PRECISION NOT NULL DEFAULT 0,realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
   updated_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(owner_hash,country))""")
  db.execute("""CREATE TABLE IF NOT EXISTS tradesight_stock_holdings_v2(
   owner_hash TEXT NOT NULL,country TEXT NOT NULL,ticker TEXT NOT NULL,company TEXT NOT NULL,
   quantity DOUBLE PRECISION NOT NULL,average_cost DOUBLE PRECISION NOT NULL,updated_at TIMESTAMPTZ NOT NULL,
   PRIMARY KEY(owner_hash,country,ticker))""")
  db.execute("""CREATE TABLE IF NOT EXISTS tradesight_stock_ledger_v2(
   id BIGSERIAL PRIMARY KEY,owner_hash TEXT NOT NULL,country TEXT NOT NULL,currency TEXT NOT NULL,
   kind TEXT NOT NULL,ticker TEXT,company TEXT,quantity DOUBLE PRECISION,price DOUBLE PRECISION,
   fees DOUBLE PRECISION NOT NULL,gross DOUBLE PRECISION NOT NULL,realized_pnl DOUBLE PRECISION NOT NULL,
   note TEXT,created_at TIMESTAMPTZ NOT NULL)""")
  db.execute("CREATE INDEX IF NOT EXISTS tradesight_stock_ledger_v2_owner_idx ON tradesight_stock_ledger_v2(owner_hash,country,id DESC)")

def _wallet(db,owner,country):
 now=datetime.now(timezone.utc)
 inserted=db.execute("INSERT INTO tradesight_stock_wallet_v2(owner_hash,country,currency,cash_balance,realized_pnl,updated_at) VALUES(%s,%s,%s,%s,0,%s) ON CONFLICT(owner_hash,country) DO NOTHING RETURNING owner_hash",(owner,country,CC[country],100000.0 if country=="NG" else 0.0,now)).fetchone()
 if inserted and country=="NG":
  db.execute("INSERT INTO tradesight_stock_ledger_v2(owner_hash,country,currency,kind,fees,gross,realized_pnl,note,created_at) VALUES(%s,%s,%s,'OPENING_CAPITAL',0,100000,0,%s,%s)",(owner,country,CC[country],"Initial NGX research portfolio capital (paper ledger; not a real bank deposit)",now))
 return db.execute("SELECT * FROM tradesight_stock_wallet_v2 WHERE owner_hash=%s AND country=%s FOR UPDATE",(owner,country)).fetchone()

def get_portfolio(key,country="NG"):
 owner=_owner(key); c=_c(country)
 with _connect() as db:
  w=_wallet(db,owner,c)
  holdings=db.execute("SELECT ticker,company,quantity,average_cost,quantity*average_cost AS cost_basis FROM tradesight_stock_holdings_v2 WHERE owner_hash=%s AND country=%s AND quantity>0 ORDER BY ticker",(owner,c)).fetchall()
  tx=db.execute("SELECT id,kind,ticker,company,quantity,price,fees,gross,realized_pnl,note,created_at FROM tradesight_stock_ledger_v2 WHERE owner_hash=%s AND country=%s ORDER BY id DESC LIMIT 100",(owner,c)).fetchall()
 return {"status":"ok","country":c,"currency":w["currency"],"cash_balance":round(w["cash_balance"],2),
  "realized_pnl":round(w["realized_pnl"],2),"holdings":[dict(x) for x in holdings],
  "transactions":[dict(x) for x in tx],"wallet_type":"STOCK_INVESTMENT_WALLET",
  "separate_from_demo_wallet":True,
  "note":"Private manual stock investment wallet. Only record completed broker fills; no orders or money transfers are executed."}

def deposit(key,country,amount,note=None):
 owner=_owner(key); c=_c(country); a=float(amount)
 if not 0<a<1e12: raise ValueError("Wallet funding amount must be positive.")
 now=datetime.now(timezone.utc)
 with _connect() as db:
  _wallet(db,owner,c)
  db.execute("UPDATE tradesight_stock_wallet_v2 SET cash_balance=cash_balance+%s,updated_at=%s WHERE owner_hash=%s AND country=%s",(a,now,owner,c))
  db.execute("INSERT INTO tradesight_stock_ledger_v2(owner_hash,country,currency,kind,fees,gross,realized_pnl,note,created_at) VALUES(%s,%s,%s,'DEPOSIT',0,%s,0,%s,%s)",(owner,c,CC[c],a,(note or "Wallet funding")[:250],now))
 return get_portfolio(key,c)

def trade(key,country,ticker,company,side,quantity,price,fees=0,note=None):
 owner=_owner(key); c=_c(country); t=str(ticker or "").strip().upper(); n=str(company or t)[:150]; s=str(side or "").upper()
 q=float(quantity); p=float(price); f=float(fees or 0)
 if not t or s not in ("BUY","SELL") or not(0<q<1e12 and 0<p<1e12 and 0<=f<1e12):
  raise ValueError("Enter valid ticker, BUY/SELL, positive quantity/price and non-negative fees.")
 gross=q*p; now=datetime.now(timezone.utc)
 with _connect() as db:
  w=_wallet(db,owner,c)
  h=db.execute("SELECT * FROM tradesight_stock_holdings_v2 WHERE owner_hash=%s AND country=%s AND ticker=%s FOR UPDATE",(owner,c,t)).fetchone()
  oq=float(h["quantity"]) if h else 0.; avg=float(h["average_cost"]) if h else 0.; pnl=0.
  if s=="BUY":
   cost=gross+f
   if w["cash_balance"]+1e-8<cost: raise ValueError(f"Insufficient stock wallet cash. Need {cost:.2f} {CC[c]}; available {w['cash_balance']:.2f}. Fund this stock wallet first.")
   nq=oq+q; na=(oq*avg+gross+f)/nq
   db.execute("""INSERT INTO tradesight_stock_holdings_v2(owner_hash,country,ticker,company,quantity,average_cost,updated_at)
    VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_hash,country,ticker) DO UPDATE SET company=EXCLUDED.company,
    quantity=EXCLUDED.quantity,average_cost=EXCLUDED.average_cost,updated_at=EXCLUDED.updated_at""",(owner,c,t,n,nq,na,now))
   db.execute("UPDATE tradesight_stock_wallet_v2 SET cash_balance=cash_balance-%s,updated_at=%s WHERE owner_hash=%s AND country=%s",(cost,now,owner,c))
  else:
   if not h or oq+1e-8<q: raise ValueError(f"Cannot sell {q:g}; holding available is {oq:g}.")
   pnl=gross-f-q*avg; nq=oq-q
   if nq<=1e-8: db.execute("DELETE FROM tradesight_stock_holdings_v2 WHERE owner_hash=%s AND country=%s AND ticker=%s",(owner,c,t))
   else: db.execute("UPDATE tradesight_stock_holdings_v2 SET quantity=%s,updated_at=%s WHERE owner_hash=%s AND country=%s AND ticker=%s",(nq,now,owner,c,t))
   db.execute("UPDATE tradesight_stock_wallet_v2 SET cash_balance=cash_balance+%s,realized_pnl=realized_pnl+%s,updated_at=%s WHERE owner_hash=%s AND country=%s",(gross-f,pnl,now,owner,c))
  db.execute("""INSERT INTO tradesight_stock_ledger_v2(owner_hash,country,currency,kind,ticker,company,quantity,price,fees,gross,realized_pnl,note,created_at)
   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",(owner,c,CC[c],s,t,n,q,p,f,gross,pnl,(note or "")[:250],now))
 return get_portfolio(key,c)
