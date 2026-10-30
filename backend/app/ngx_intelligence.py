"""Read-only NGX stock intelligence using optional Kobo Terminal market data."""
from __future__ import annotations
import os, json, urllib.request
from datetime import datetime, timezone
from typing import Any
BASE = "https://koboterminal.com"
WATCHLIST = {"GTCO":"Guaranty Trust Holding Company Plc","ZENITHBANK":"Zenith Bank Plc","UBA":"United Bank for Africa Plc","FIDELITYBK":"Fidelity Bank Plc","DANGCEM":"Dangote Cement Plc","BUACEMENT":"BUA Cement Plc","MTNN":"MTN Nigeria Communications Plc","AIRTELAFRI":"Airtel Africa Plc","PRESCO":"Presco Plc","SEPLAT":"Seplat Energy Plc"}
CACHE: dict[str, Any] = {"at":0.0,"data":None}
def _get(path: str) -> Any:
    headers={"Accept":"application/json","User-Agent":"TradeSight/1.0"}
    key=os.getenv("NGX_KOBO_API_KEY","").strip()
    if key: headers["X-API-Key"]=key
    request=urllib.request.Request(BASE+path,headers=headers)
    with urllib.request.urlopen(request,timeout=8) as response:
        return json.loads(response.read(2_000_000).decode("utf-8"))
def _num(value):
    try:
        n=float(value)
        return n if n==n and abs(n)!=float("inf") else None
    except (TypeError,ValueError): return None
def _score(stock: dict, fundamentals: dict|None) -> dict:
    f=fundamentals or {}; checks=[]
    roe,margin,de,pe=(_num(f.get(k)) for k in ("roe","profit_margin","debt_equity","pe_ratio"))
    if roe is not None: checks.append(("ROE",20 if roe>=15 else 10 if roe>=8 else 0,f"ROE {roe:.1f}%"))
    if margin is not None: checks.append(("Profit margin",20 if margin>=15 else 10 if margin>=5 else 0,f"Profit margin {margin:.1f}%"))
    if de is not None: checks.append(("Leverage",15 if de<=.5 else 8 if de<=1 else 0,f"Debt/equity {de:.2f}"))
    if pe is not None: checks.append(("Valuation",15 if 0<pe<=12 else 8 if pe<=20 else 0,f"P/E {pe:.1f}"))
    dividend=_num(f.get("dividend_yield"))
    if dividend is not None: checks.append(("Dividend",10 if dividend>=5 else 5 if dividend>0 else 0,f"Dividend yield {dividend:.1f}%"))
    enough=len(checks)>=4; score=sum(x[1] for x in checks)
    price=_num(stock.get("current_price"))
    status=("WAIT — INSUFFICIENT DATA","Not assigned") if not enough or price is None else (("WATCHLIST CANDIDATE" if score>=45 else "AVOID / REVIEW"),"1–6 months (review only)")
    return {"score":score if enough else None,"status":status[0],"suggested_horizon":status[1],"checks":[x[2] for x in checks],"missing":[n for n,v in (("ROE",roe),("Profit margin",margin),("Debt/equity",de),("P/E",pe),("Dividend yield",dividend)) if v is None],"entry":None,"stop_loss":None,"take_profit":None,"reason":"A one-day quote or incomplete fundamentals cannot justify a BUY. Require multi-session history, liquidity and a defensible entry/exit plan.","data_quality":"FUNDAMENTALS_PARTIAL" if enough else "INSUFFICIENT"}
def get_ngx_intelligence(force: bool=False) -> dict:
    import time
    now=time.time()
    if not force and CACHE["data"] is not None and now-CACHE["at"]<300: return CACHE["data"]
    key_configured=bool(os.getenv("NGX_KOBO_API_KEY","").strip())
    try:
        raw=_get("/api/ngxdata/stocks"); stocks=raw if isinstance(raw,list) else raw.get("data",[])
        market=_get("/api/ngxdata/market")
        fundamentals_map={}
        if key_configured:
            try:
                fr=_get("/api/ngxdata/fundamentals?symbols="+",".join(WATCHLIST))
                values=fr.get("data",fr.get("fundamentals",[])) if isinstance(fr,dict) else fr
                if isinstance(values,list): fundamentals_map={str(x.get("symbol","")).upper():x for x in values}
                elif isinstance(values,dict) and values.get("symbol"): fundamentals_map[str(values["symbol"]).upper()]=values
            except Exception: pass
        by_symbol={str(x.get("symbol","")).upper():x for x in stocks if isinstance(x,dict)}
        rows=[]
        for symbol,name in WATCHLIST.items():
            q=by_symbol.get(symbol)
            if not q: continue
            f=fundamentals_map.get(symbol)
            rows.append({"symbol":symbol,"name":q.get("name") or name,"sector":q.get("sector"),"price":_num(q.get("current_price")),"change_percent":_num(q.get("change_percent")),"volume":_num(q.get("volume")),"market_cap":_num(q.get("market_cap")),"pe_ratio":_num((f or {}).get("pe_ratio",q.get("pe_ratio"))),"fundamentals_updated_at":(f or {}).get("updated_at"),"analysis":_score(q,f)})
        data={"status":"LIVE" if rows else "OFFLINE","provider":"Kobo Terminal NGX data (delayed snapshot)","updated_at":datetime.now(timezone.utc).isoformat(),"market":market if isinstance(market,dict) else {},"watchlist":rows,"data_entitlement":"API key configured" if key_configured else "Public snapshot only; configure NGX_KOBO_API_KEY for authenticated access","note":"Delayed market data · research only · no broker orders."}
    except Exception as exc:
        data={"status":"OFFLINE","provider":"Kobo Terminal NGX","updated_at":datetime.now(timezone.utc).isoformat(),"market":{},"watchlist":[],"data_entitlement":"Not configured or unavailable","note":f"NGX data unavailable: {str(exc)[:180]}. No sample prices or recommendations are shown."}
    CACHE.update({"at":now,"data":data}); return data
