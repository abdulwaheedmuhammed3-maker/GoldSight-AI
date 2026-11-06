"""Nigeria currency and macroeconomic history from World Bank indicators."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
import httpx

BASE = "https://api.worldbank.org/v2/country/NGA/indicator"
INDICATORS = {
    "exchange_rate": ("PA.NUS.FCRF", "Official exchange rate", "NGN per US$"),
    "gdp_growth": ("NY.GDP.MKTP.KD.ZG", "Real GDP growth", "% year-on-year"),
    "inflation": ("FP.CPI.TOTL.ZG", "Consumer price inflation", "% year-on-year"),
}

def _series(client: httpx.Client, code: str) -> list[dict[str, Any]]:
    response = client.get(f"{BASE}/{code}", params={"format":"json","per_page":30,"date":"2000:2025"})
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list) or len(payload) < 2 or not isinstance(payload[1], list):
        return []
    rows=[]
    for item in payload[1]:
        value=item.get("value")
        if value is None: continue
        try: rows.append({"year":int(item["date"]),"value":float(value)})
        except (TypeError,ValueError,KeyError): continue
    return sorted(rows,key=lambda x:x["year"])

def get_nigeria_economy() -> dict[str, Any]:
    fetched=datetime.now(timezone.utc).isoformat()
    try:
        with httpx.Client(timeout=12.0,headers={"User-Agent":"TradeSight/1.0"}) as client:
            result={}
            for key,(code,label,unit) in INDICATORS.items():
                result[key]={"indicator":code,"label":label,"unit":unit,"series":_series(client,code)}
        # Latest FX reference quote is separately sourced and is not the official NFEM fixing.
        fx=None
        try:
            response=httpx.get("https://open.er-api.com/v6/latest/USD",timeout=8.0)
            response.raise_for_status()
            payload=response.json()
            if payload.get("result")=="success":
                fx={"ngn_per_usd":payload.get("rates",{}).get("NGN"),"provider":"open.er-api.com","updated_at":payload.get("time_last_update_utc"),"kind":"indicative reference rate"}
        except Exception:
            fx=None
        return {"status":"LIVE" if any(x["series"] for x in result.values()) else "OFFLINE","country":"Nigeria","currency":"Nigerian naira","currency_code":"NGN","indicators":result,"reference_fx":fx,"provider":"World Bank World Development Indicators","updated_at":fetched,"note":"Macro series are annual and lag publication. The latest USD/NGN reference quote is indicative, not the CBN NFEM fixing, bank rate or parallel-market rate."}
    except Exception as exc:
        return {"status":"OFFLINE","country":"Nigeria","currency":"Nigerian naira","currency_code":"NGN","indicators":{},"reference_fx":None,"provider":"World Bank World Development Indicators","updated_at":fetched,"note":f"Nigeria macro data unavailable: {str(exc)[:160]}"}
