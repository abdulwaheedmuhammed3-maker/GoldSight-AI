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
  const [data,setData] = useState<any>(null)
  const [status,setStatus] = useState('Loading your separate stock wallet…')
  const [busy,setBusy] = useState(false)
  const [form,setForm] = useState({country:'NG',ticker:'GTCO.NG',company:'GTCO',side:'BUY',quantity:'100',price:'',fees:'0'})
  const load = useCallback(async () => {
    try {
      const response = await fetch(API+'/api/v1/stocks/portfolio',{headers:{'X-Portfolio-Key':key},cache:'no-store'})
      const json = await response.json()
      if (!response.ok) throw new Error(json.detail || 'Stock wallet unavailable')
      setData(json); setStatus(json.note || 'Stock wallet loaded')
    } catch(error) { setStatus(error instanceof Error ? error.message : 'Stock wallet unavailable.') }
  },[key])
  useEffect(()=>{ void load(); const id=window.setInterval(()=>void load(),60000); return ()=>window.clearInterval(id) },[load])
  const submit = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true)
    try {
      const response = await fetch(API+'/api/v1/stocks/portfolio/transactions',{
        method:'POST',headers:{'Content-Type':'application/json','X-Portfolio-Key':key},
        body:JSON.stringify({...form,quantity:Number(form.quantity),price:Number(form.price),fees:Number(form.fees)})
      })
      const json=await response.json()
      if(!response.ok) throw new Error(json.detail || 'Could not save transaction.')
      setData(json); setStatus(form.side+' transaction recorded in your stock wallet.')
      setForm(old=>({...old,price:''}))
    } catch(error) { setStatus(error instanceof Error ? error.message : 'Could not save transaction.') }
    finally { setBusy(false) }
  }
  return <section className="panel stock-portfolio-panel">
    <div className="stock-hero-art">
      <div><p className="eyebrow">YOUR INVESTMENT TRACKER</p><h2>Own your portfolio.<br/><em>Know your profit.</em></h2><p>Track shares you buy, holdings you keep and the profit you make when you sell.</p></div>
      <div className="stock-hero-graphic"><span>📈</span><small>STOCK INVESTMENTS</small><b>💹</b></div>
    </div>
    <div className="panel-head"><div><p className="eyebrow">SEPARATE INVESTMENT LEDGER</p><h2>My stock wallet</h2></div><span className="stock-live">PRIVATE LEDGER</span></div>
    <p className="muted">This wallet is completely separate from your Gold/BTC demo wallet. Record actual purchases and sales made through your broker. TradeSight does not hold or transfer money.</p>
    <div className="portfolio-balance-art"><div><span>REALIZED PROFIT / LOSS</span><strong className={(data?.summary?.realized_pnl || 0)>=0?'green':'red'}>{(data?.summary?.realized_pnl || 0)>=0?'+':''}{money(data?.summary?.realized_pnl || 0)}</strong><small>Profit/loss from recorded sales · no currency conversion</small></div><div className="portfolio-art-icon">💹💰</div></div>
    <div className="metrics demo-metrics">
      <article className="metric"><span>OPEN HOLDINGS</span><strong>{data?.summary?.open_positions ?? '—'}</strong></article>
      <article className="metric"><span>BUY / SELL RECORDS</span><strong>{data?.summary?.buy_transactions ?? 0} / {data?.summary?.sell_transactions ?? 0}</strong></article>
      <article className="metric"><span>HOLDINGS COST BASIS</span><strong>{money(data?.summary?.cost_basis || 0)}</strong><small>Raw total across currencies</small></article>
    </div>
    <form className="portfolio-form" onSubmit={submit}>
      <div className="portfolio-form-heading"><span>🧾</span><div><b>Record a completed transaction</b><small>Enter the actual execution price and charges from your broker contract note.</small></div></div>
      <div className="settings-actions"><button type="button" className={form.side==='BUY'?'selected':''} onClick={()=>setForm(old=>({...old,side:'BUY'}))}>＋ Buy shares</button><button type="button" className={form.side==='SELL'?'selected':''} onClick={()=>setForm(old=>({...old,side:'SELL'}))}>− Sell shares</button></div>
      <div className="portfolio-fields">
        <label>Market<select value={form.country} onChange={e=>setForm(old=>({...old,country:e.target.value}))}>{markets.map(m=><option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
        <label>Stock ticker<input required value={form.ticker} onChange={e=>setForm(old=>({...old,ticker:e.target.value.toUpperCase()}))} placeholder="e.g. GTCO.NG"/></label>
        <label>Company name<input required value={form.company} onChange={e=>setForm(old=>({...old,company:e.target.value}))} placeholder="Company"/></label>
        <label>Quantity (shares)<input required type="number" min="0.000001" step="any" value={form.quantity} onChange={e=>setForm(old=>({...old,quantity:e.target.value}))}/></label>
        <label>Execution price<input required type="number" min="0.000001" step="any" value={form.price} onChange={e=>setForm(old=>({...old,price:e.target.value}))} placeholder="Actual price per share"/></label>
        <label>Fees / charges<input type="number" min="0" step="any" value={form.fees} onChange={e=>setForm(old=>({...old,fees:e.target.value}))}/></label>
      </div>
      <button className="primary portfolio-submit" type="submit" disabled={busy || !form.price}>{busy?'Saving transaction…':'Record '+(form.side==='BUY'?'purchase':'sale')}</button>
      <p className="chart-foot">{status}</p>
    </form>
    <h3 className="portfolio-section-title">Your holdings</h3>
    {data?.positions?.length ? <div className="portfolio-holdings">{data.positions.map((p:any)=><article className="portfolio-holding" key={p.country+':'+p.ticker}><span className="holding-avatar">{markets.find(m=>m.v===p.country)?.l.slice(0,4) || '🌐'}</span><div className="holding-info"><b>{p.company}</b><small>{p.ticker} · {p.quantity.toLocaleString()} shares</small><small>Average cost: {money(p.average_cost,p.currency)}</small></div><strong>{money(p.cost_basis,p.currency)}</strong></article>)}</div> : <div className="chart-offline"><b>No shares recorded yet</b><p>When you buy shares through your broker, record the completed purchase here. Your holdings will appear separately from demo positions.</p></div>}
    <h3 className="portfolio-section-title">Transaction history</h3>
    {data?.transactions?.length ? <div className="history-list">{data.transactions.map((t:any)=><div className="history-row portfolio-transaction" key={t.id}><span className={t.side==='BUY'?'buy':'sell'}>{t.side}</span><b>{t.ticker}</b><span>{Number(t.quantity).toLocaleString()} shares</span><span>{money(t.price,t.currency)}</span><strong className={t.realized_pnl==null?'':t.realized_pnl>=0?'green':'red'}>{t.realized_pnl==null?'—':money(t.realized_pnl,t.currency)}</strong><time>{date(t.transacted_at)}</time></div>)}</div> : <div className="history-empty">No transactions recorded yet.</div>}
    <p className="chart-foot">Average-cost accounting: buy fees increase your cost basis; sale fees reduce realized proceeds. Different currencies are not combined or converted. Keep this browser's site data safe; it stores the private wallet access key.</p>
  </section>
}
