"""Multi-country equity screener. Indicative Yahoo chart data; no orders."""
from __future__ import annotations
import json,time,urllib.parse,urllib.request
from datetime import datetime,timezone
UNIVERSE={
"NG":{"name":"Nigeria · NGX","flag":"🇳🇬","currency":"NGN","benchmark":"^NGSEINDX","benchmark_name":"NGX All-Share Index","symbols":{"GTCO.NG":"GTCO","ZENITHBANK.NG":"Zenith Bank","UBA.NG":"UBA","DANGCEM.NG":"Dangote Cement","MTNN.NG":"MTN Nigeria","SEPLAT.NG":"Seplat Energy","PRESCO.NG":"Presco"}},
"US":{"name":"United States · NYSE/Nasdaq","flag":"🇺🇸","currency":"USD","benchmark":"^GSPC","benchmark_name":"S&P 500","symbols":{"AAPL":"Apple","MSFT":"Microsoft","NVDA":"NVIDIA","AMZN":"Amazon","GOOGL":"Alphabet","JPM":"JPMorgan"}},
"GB":{"name":"United Kingdom · LSE","flag":"🇬🇧","currency":"GBP","benchmark":"^FTSE","benchmark_name":"FTSE 100","symbols":{"HSBA.L":"HSBC","SHEL.L":"Shell","AZN.L":"AstraZeneca","BP.L":"BP","ULVR.L":"Unilever"}},
"CA":{"name":"Canada · TSX","flag":"🇨🇦","currency":"CAD","benchmark":"^GSPTSE","benchmark_name":"S&P/TSX Composite","symbols":{"RY.TO":"RBC","SHOP.TO":"Shopify","ENB.TO":"Enbridge","TD.TO":"TD Bank"}},
"ZA":{"name":"South Africa · JSE","flag":"🇿🇦","currency":"ZAR","benchmark":"^JTOPI","benchmark_name":"FTSE/JSE All Share","symbols":{"NPN.JO":"Prosus","AGL.JO":"Anglo American","SBK.JO":"Standard Bank","MTN.JO":"MTN Group"}},
"IN":{"name":"India · NSE","flag":"🇮🇳","currency":"INR","benchmark":"^NSEI","benchmark_name":"NIFTY 50","symbols":{"RELIANCE.NS":"Reliance","TCS.NS":"TCS","HDFCBANK.NS":"HDFC Bank","INFY.NS":"Infosys"}},
"DE":{"name":"Germany · Xetra","flag":"🇩🇪","currency":"EUR","benchmark":"^GDAXI","benchmark_name":"DAX","symbols":{"SAP.DE":"SAP","SIE.DE":"Siemens","ALV.DE":"Allianz","DTE.DE":"Deutsche Telekom"}},
"AU":{"name":"Australia · ASX","flag":"🇦🇺","currency":"AUD","benchmark":"^AXJO","benchmark_name":"S&P/ASX 200","benchmark":"^AXJO","benchmark_name":"S&P/ASX 200","symbols":{"CBA.AX":"Commonwealth Bank","BHP.AX":"BHP","CSL.AX":"CSL","WBC.AX":"Westpac"}}}
CACHE={}
def _chart(ticker):
 url="https://query1.finance.yahoo.com/v8/finance/chart/"+urllib.parse.quote(ticker,safe="")+"?range=6mo&interval=1d"
 req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 TradeSight/1.0","Accept":"application/json"})
 with urllib.request.urlopen(req,timeout=8) as r: raw=json.loads(r.read(1200000).decode())
 items=raw.get("chart",{}).get("result") or []
 if not items: raise ValueError("No price history returned")
 x=items[0]; q=x.get("indicators",{}).get("quote",[{}])[0]
 valid=[(int(t),float(c)) for t,c in zip(x.get("timestamp") or [],q.get("close") or []) if t and isinstance(c,(int,float))]
 if len(valid)<55: raise ValueError("Insufficient daily history (need 55 sessions)")
 closes=[v for _,v in valid]; volumes=[v for v in (q.get("volume") or []) if isinstance(v,(int,float))]
 last=closes[-1]; s20=sum(closes[-20:])/20; s50=sum(closes[-50:])/50
 diffs=[closes[i]-closes[i-1] for i in range(1,len(closes))][-14:]
 gains=sum(max(v,0) for v in diffs)/14; losses=sum(max(-v,0) for v in diffs)/14
 rsi=100 if losses==0 else 100-100/(1+gains/losses)
 ch20=(last/closes[-21]-1)*100
 score=(30 if last>s20 else 0)+(25 if s20>s50 else 0)+(15 if ch20>0 else 0)+(15 if 45<=rsi<=68 else 0)+(15 if len(volumes)>=20 and volumes[-1]>=sum(volumes[-20:])/20 else 0)
 ts=valid[-1][0]; age=max(0,int((datetime.now(timezone.utc).timestamp()-ts)/86400))
 return {"price":last,"as_of":datetime.fromtimestamp(ts,timezone.utc).isoformat(),"age_days":age,"fresh":age<=5,"sma20":round(s20,4),"sma50":round(s50,4),"rsi14":round(rsi,1),"change20_pct":round(ch20,2),"trend":"BULLISH" if last>s20>s50 else "BEARISH" if last<s20<s50 else "MIXED","technical_score":score,"history_bars":len(valid),"volume":volumes[-1] if volumes else None,"change1d_pct":round((last/closes[-2]-1)*100,2) if len(closes)>1 and closes[-2] else None}
def get_stock_intelligence(country="NG",refresh=False):
 country=country.upper()
 if country not in UNIVERSE: raise ValueError("Supported markets: NG, US, GB, CA, ZA, IN, DE, AU")
 now=time.time()
 if not refresh and country in CACHE and now-CACHE[country][0]<900: return CACHE[country][1]
 market=UNIVERSE[country]; rows=[]; errors=[]
 for ticker,name in market["symbols"].items():
  try:
   q=_chart(ticker); candidate=q["fresh"] and q["trend"]=="BULLISH" and q["technical_score"]>=70
   q.update({"ticker":ticker,"name":name,"signal":"TECHNICAL WATCH" if candidate else "WAIT / AVOID","holding_horizon":"2–20 trading sessions; review daily" if candidate else "Not assigned","entry":None,"stop_loss":None,"take_profit":None,"fundamental_status":"NOT CONNECTED","reason":"Technical screening only. A BUY needs verified financial statements, valuation, exchange liquidity, corporate actions and a risk-defined entry."})
   rows.append(q)
  except Exception as e: errors.append({"ticker":ticker,"error":str(e)[:140]})
 benchmark=None
 try:
  b=_chart(market["benchmark"])
  benchmark={"name":market["benchmark_name"],"symbol":market["benchmark"],"value":b["price"],"change1d_pct":b["change1d_pct"],"as_of":b["as_of"],"status":"LIVE" if b["fresh"] else "STALE"}
 except Exception as e:
  errors.append({"ticker":market["benchmark"],"error":("Benchmark: "+str(e))[:140]})
 advances=sum(1 for row in rows if (row.get("change20_pct") or 0)>0)
 declines=sum(1 for row in rows if (row.get("change20_pct") or 0)<0)
 unchanged=max(0,len(rows)-advances-declines)
 total_volume=sum(row["volume"] for row in rows if isinstance(row.get("volume"),(int,float)))
 volume_count=sum(1 for row in rows if isinstance(row.get("volume"),(int,float)))
 overview={"benchmark":benchmark,"market_cap":None,"advancers":advances if rows else None,"decliners":declines if rows else None,"unchanged":unchanged if rows else None,"breadth_basis":"Tracked watchlist · 20-session change","volume":total_volume if volume_count else None,"volume_basis":f"Tracked constituents only · {volume_count}/{len(rows)} reported" if rows else None,"market_cap_status":"Unavailable from current provider"}
 data={"status":"LIVE" if rows else "OFFLINE","country":country,"market":market["name"],"flag":market["flag"],"currency":market["currency"],"overview":overview,"provider":"Yahoo Finance daily chart history · indicative/delayed, not an exchange execution feed","updated_at":datetime.now(timezone.utc).isoformat(),"watchlist":rows,"errors":errors,"coverage":{"requested":len(market["symbols"]),"returned":len(rows)},"capital_range":"₦100,000–₦500,000 (configured user research range; position sizes require broker fees and liquidity)","approach":"Technical screening only; not a buy recommendation.","note":"Indicative delayed data · research only · no broker orders."}
 CACHE[country]=(now,data); return data
