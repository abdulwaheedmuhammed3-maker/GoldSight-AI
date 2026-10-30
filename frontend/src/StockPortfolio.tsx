import { useCallback, useEffect, useState, type FormEvent } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const markets = [{v:'NG',l:'🇳🇬 Nigeria · NGX'},{v:'US',l:'🇺🇸 USA'},{v:'GB',l:'🇬🇧 UK'},{v:'CA',l:'🇨🇦 Canada'},{v:'ZA',l:'🇿🇦 South Africa'},{v:'IN',l:'🇮🇳 India'},{v:'DE',l:'🇩🇪 Germany'},{v:'AU',l:'🇦🇺 Australia'}]
const money = (value:number, currency='') => Number(value || 0).toLocaleString('en-NG',{maximumFractionDigits:2}) + (currency ? ' '+currency : '')
const date = (value:string) => value ? new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',dateStyle:'medium',timeStyle:'short'}).format(new Date(value))+' WAT' : '—'

export default function StockPortfolio() {
  const [key] = useState(() => {
    const existing = window.localStorage.getItem('tradesight-stock-portfolio-key')
    if (existing) return existing
    const created = window.crypto.randomUUID().replace(/-/g,'')
    window.localStorage.setItem('tradesight-stock-portfolio-key',created)
    return created
  })
  const [country,setCountry] = useState('NG')
  const [data,setData] = useState<any>(null)
  const [marketData,setMarketData] = useState<any>(null)
  const [status,setStatus] = useState('Loading your separate stock wallet…')
  const [busy,setBusy] = useState(false)
  const [mode,setMode] = useState<'DEPOSIT'|'BUY'|'SELL'>('DEPOSIT')
  const [form,setForm] = useState({ticker:'GTCO.NG',company:'GTCO',quantity:'100',price:'',stop_loss:'',fees:'0'})
  const [fundAmount,setFundAmount] = useState('')
  const suggestedShares = (() => {
    const entry=Number(form.price), stop=Number(form.stop_loss)
    if(country!=='NG' || !Number.isFinite(entry) || !Number.isFinite(stop) || entry<=0 || stop<=0 || stop>=entry) return 0
    return Math.max(0,Math.floor(Math.min(20000/entry,1000/(entry-stop))))
  })()

  const load = useCallback(async () => {
    try {
      const response = await fetch(API+'/api/v1/stocks/portfolio?country='+country,{headers:{'X-Portfolio-Key':key},cache:'no-store'})
      const json = await response.json()
      if (!response.ok) throw new Error(json.detail || 'Stock wallet unavailable')
      setData(json); setStatus(json.note || 'Stock wallet loaded')
      try { const marketResponse=await fetch(API+'/api/v1/stocks/intelligence?country='+country,{cache:'no-store'}); const marketJson=await marketResponse.json(); if(marketResponse.ok) setMarketData(marketJson); else setMarketData(null) } catch { setMarketData(null) }
    } catch(error) { setStatus(error instanceof Error ? error.message : 'Stock wallet unavailable.') }
  },[key,country])
  useEffect(()=>{ void load(); const id=window.setInterval(()=>void load(),60000); return ()=>window.clearInterval(id) },[load])
  const submit = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true)
    try {
      const endpoint = mode==='DEPOSIT' ? '/api/v1/stocks/portfolio/deposit' : '/api/v1/stocks/portfolio/trade'
      const payload = mode==='DEPOSIT'
        ? {country,amount:Number(fundAmount),note:'Manual stock wallet funding'}
        : {country,ticker:form.ticker,company:form.company,side:mode,quantity:Number(form.quantity),price:Number(form.price),stop_loss:mode==='BUY'?Number(form.stop_loss):null,fees:Number(form.fees)}
      const response = await fetch(API+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Portfolio-Key':key},body:JSON.stringify(payload)})
      const json=await response.json()
      if(!response.ok) throw new Error(json.detail || 'Could not save this wallet transaction.')
      setData(json); setStatus(mode==='DEPOSIT'?'Wallet funding recorded.':mode+' transaction recorded.')
      setFundAmount(''); setForm(old=>({...old,price:'',stop_loss:''}))
    } catch(error) { setStatus(error instanceof Error ? error.message : 'Could not save transaction.') }
    finally { setBusy(false) }
  }
  return <section className="panel stock-portfolio-panel">
    <div className="stock-hero-art"><div><p className="eyebrow">YOUR INVESTMENT TRACKER</p><h2>Own your portfolio.<br/><em>Know your profit.</em></h2><p>Track shares you buy, holdings you keep and the profit you make when you sell.</p></div><div className="stock-hero-graphic"><span>📈</span><small>STOCK INVESTMENTS</small><b>💹</b></div></div>
    <div className="panel-head"><div><p className="eyebrow">SEPARATE INVESTMENT LEDGER</p><h2>My stock wallet</h2></div><span className="stock-live">PRIVATE LEDGER</span></div>
    <p className="muted">This wallet is separate from your Gold/BTC demo account. It records stock wallet funding and completed purchases or sales made through your broker. TradeSight does not hold or transfer money.</p>
    <label className="portfolio-market-select">Select wallet market<select value={country} onChange={e=>setCountry(e.target.value)}>{markets.map(m=><option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
    <div className="portfolio-balance-art"><div><span>AVAILABLE STOCK WALLET CASH</span><strong>{data ? money(data.cash_balance,data.currency) : '—'}</strong><small>₦100,000 initial tracking capital · separate from demo</small></div><div className="portfolio-art-icon">💹💰</div></div>
    <div className="metrics demo-metrics">
      <article className="metric"><span>REALIZED PROFIT / LOSS</span><strong className={(data?.realized_pnl || 0)>=0?'green':'red'}>{(data?.realized_pnl || 0)>=0?'+':''}{money(data?.realized_pnl || 0,data?.currency || '')}</strong><small>From completed sales</small></article>
      <article className="metric"><span>OPEN HOLDINGS</span><strong>{data?.holdings?.length ?? 0}</strong></article>
      <article className="metric"><span>HOLDINGS COST BASIS</span><strong>{money((data?.holdings || []).reduce((sum:number,p:any)=>sum+Number(p.cost_basis),0),data?.currency || '')}</strong></article>
    </div>
    {country==='NG' && <section className="monthly-plan-card">
      <div className="monthly-plan-top"><span>🗓️</span><div><b>Monthly investing rules</b><small>₦100,000 starting capital · patient, diversified share investing</small></div></div>
      <div className="monthly-plan-grid"><article><b>₦20,000</b><small>Maximum cost per company</small></article><article><b>₦20,000</b><small>Cash reserve to protect</small></article><article><b>₦1,000</b><small>Maximum planned loss per position</small></article></div>
      <p>Review the market monthly, but do not force a purchase every month. Start with one or two well-researched positions, spread exposure across sectors and add only when valuation, company results, liquidity and price structure support the decision.</p>
      <p><b>Share quantity:</b> use the smaller of ₦20,000 ÷ share price or ₦1,000 ÷ (entry price − stop-loss). Include fees and keep at least ₦20,000 in cash. The server rejects buys that break these limits.</p>
      <p><b>Exit discipline:</b> set the stop before buying. At +2R, consider selling part and trail the rest; close if the stop or investment thesis is invalidated. TradeSight can flag a stop or +2R level using the latest available daily data, but it cannot automatically sell or close a broker position. Quotes may be delayed; confirm with your broker.</p>
    </section>}
    <form className="portfolio-form" onSubmit={submit}>
      <div className="portfolio-form-heading"><span>🧾</span><div><b>Manage your stock wallet</b><small>Initial NGX tracking capital: ₦100,000. Record actual broker fills; no real money is transferred by TradeSight.</small></div></div>
      <div className="settings-actions">
        <button type="button" className={mode==='DEPOSIT'?'selected':''} onClick={()=>setMode('DEPOSIT')}>＋ Fund wallet</button>
        <button type="button" className={mode==='BUY'?'selected':''} onClick={()=>setMode('BUY')}>＋ Buy shares</button>
        <button type="button" className={mode==='SELL'?'selected':''} onClick={()=>setMode('SELL')}>− Sell shares</button>
      </div>
      {mode==='DEPOSIT' ? <div className="portfolio-fields"><label>Amount to allocate ({data?.currency || 'NGN'})<input required type="number" min="1" step="any" value={fundAmount} onChange={e=>setFundAmount(e.target.value)} placeholder="e.g. 150000"/></label></div> :
      <div className="portfolio-fields">
        <label>Stock ticker<input required value={form.ticker} onChange={e=>setForm(old=>({...old,ticker:e.target.value.toUpperCase()}))} placeholder="e.g. GTCO.NG"/></label>
        <label>Company name<input required value={form.company} onChange={e=>setForm(old=>({...old,company:e.target.value}))} placeholder="Company"/></label>
        <label>Quantity (shares)<input required type="number" min="0.000001" step="any" value={form.quantity} onChange={e=>setForm(old=>({...old,quantity:e.target.value}))}/></label>
        <label>Execution price<input required type="number" min="0.000001" step="any" value={form.price} onChange={e=>setForm(old=>({...old,price:e.target.value}))} placeholder="Actual broker fill price"/></label>
        {mode==='BUY' && <label>Planned stop-loss<input required type="number" min="0.000001" step="any" value={form.stop_loss} onChange={e=>setForm(old=>({...old,stop_loss:e.target.value}))} placeholder="Price where trade thesis fails"/></label>}
        <label>Fees / charges<input type="number" min="0" step="any" value={form.fees} onChange={e=>setForm(old=>({...old,fees:e.target.value}))}/></label>
      </div>}
      {mode==='BUY' && country==='NG' && <div className="share-sizing-preview"><div><b>Suggested maximum shares</b><strong>{suggestedShares ? suggestedShares.toLocaleString('en-NG') : 'Enter entry and stop-loss'}</strong></div><small>Calculated using the lower of ₦20,000 per-company allocation and ₦1,000 planned loss. The backend also protects a ₦20,000 cash reserve and ₦2,000 total open-position risk. Enter a quantity at or below this figure.</small></div>}
      <button className="primary portfolio-submit" type="submit" disabled={busy || (mode==='DEPOSIT'?!fundAmount:(!form.price || (mode==='BUY' && (!form.stop_loss || Number(form.stop_loss)>=Number(form.price)))))}>{busy?'Saving…':mode==='DEPOSIT'?'Record wallet funding':'Record '+(mode==='BUY'?'purchase':'sale')}</button>
      <p className="chart-foot">{status}</p>
    </form>
    <h3 className="portfolio-section-title">Your holdings</h3>
    {data?.holdings?.length ? <div className="portfolio-holdings">{data.holdings.map((p:any)=>{
      const quote=marketData?.status==='LIVE' ? marketData.watchlist?.find((x:any)=>x.ticker===p.ticker) : null
      const mark=quote?.fresh && Number.isFinite(Number(quote.price)) ? Number(quote.price) : null
      const unrealized=mark==null ? null : (mark-Number(p.average_cost))*Number(p.quantity)
      const target=p.stop_loss!=null ? Number(p.average_cost)+2*(Number(p.average_cost)-Number(p.stop_loss)) : null
      const exitFlag=mark!=null && p.stop_loss!=null && mark<=Number(p.stop_loss) ? 'STOP LEVEL BREACHED' : mark!=null && target!=null && mark>=target ? '+2R PROFIT LEVEL REACHED' : 'HOLD / REVIEW'
      return <article className="portfolio-holding" key={p.ticker}><span className="holding-avatar">{markets.find(m=>m.v===country)?.l.slice(0,4) || '🌐'}</span><div className="holding-info"><b>{p.company}</b><small>{p.ticker} · {Number(p.quantity).toLocaleString()} shares</small><small>Average cost: {money(p.average_cost,data.currency)}</small>{p.stop_loss != null && <small>Risk stop: {money(p.stop_loss,data.currency)} · +2R level: {money(target,data.currency)}</small>}<small className={mark==null?'':unrealized!>=0?'green':'red'}>{mark==null?'Market price unavailable / stale':`Indicative ${money(mark,data.currency)} · Unrealized ${unrealized!>=0?'+':''}${money(unrealized!,data.currency)}`}</small><small className={exitFlag==='STOP LEVEL BREACHED'?'red':exitFlag==='+2R PROFIT LEVEL REACHED'?'green':''}>{exitFlag}</small></div><strong>{money(p.cost_basis,data.currency)}</strong></article>
    })}</div> : <div className="chart-offline"><b>No shares recorded yet</b><p>Fund this stock wallet, then record a completed purchase. Your holdings will appear here.</p></div>}
    <h3 className="portfolio-section-title">Transaction history</h3>
    {data?.transactions?.length ? <div className="history-list">{data.transactions.map((t:any)=><div className="history-row portfolio-transaction" key={t.id}><span className={t.kind==='BUY'?'buy':t.kind==='SELL'?'sell':'buy'}>{t.kind}</span><b>{t.ticker || 'Wallet'}</b><span>{t.quantity ? Number(t.quantity).toLocaleString()+' shares' : '—'}</span><span>{t.price ? money(t.price,data.currency) : money(t.gross,data.currency)}</span><strong className={t.kind==='SELL'?(t.realized_pnl>=0?'green':'red'):''}>{t.kind==='SELL'?money(t.realized_pnl,data.currency):t.kind==='DEPOSIT'?'Funded':'—'}</strong><time>{date(t.created_at)}</time></div>)}</div> : <div className="history-empty">No transactions recorded yet.</div>}
    <p className="chart-foot">Average-cost accounting: buy fees increase your cost basis; sale fees reduce realized proceeds. Funded cash, shares and realized P/L are maintained in this market's currency. This is a manual record, not a broker-connected account.</p>
    <p className="chart-foot">{status} Keep this browser's site data safe; it stores the private wallet access key.</p>
  </section>
}
