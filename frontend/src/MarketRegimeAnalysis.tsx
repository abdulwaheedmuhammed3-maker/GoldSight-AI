import { useState } from 'react'

type Segment = { candles: number; start_time: number; end_time: number; trades: number; net_r_total: number; expectancy_net_r_per_trade: number | null; profit_factor: number | string | null; max_drawdown_r: number | null }
type Regime = { segments: number; evaluated_segments: number; candles: number; trades: number; net_r_total: number; expectancy_net_r_per_trade: number | null; segment_results: Segment[] }
type Result = { symbol: string; timeframe: string; method: string; regimes: Record<string, Regime>; classified_candles: number; skipped_short_segments: number; minimum_segment_candles: number; limitations: string[] }
const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const fmt = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'
const pf = (v: number | string | null) => v == null ? '—' : typeof v === 'number' ? fmt(v) : v
const time = (v: number) => new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',dateStyle:'medium',timeStyle:'short'}).format(new Date(v*1000))+' WAT'
const labels: Record<string,string> = { TRENDING:'Trending', RANGING:'Ranging', HIGH_VOLATILITY:'High volatility' }

export default function MarketRegimeAnalysis() {
  const [symbol,setSymbol] = useState('XAUUSD')
  const [timeframe,setTimeframe] = useState('15m')
  const [targetR,setTargetR] = useState('2')
  const [hold,setHold] = useState('24')
  const [limit,setLimit] = useState('1000')
  const [commission,setCommission] = useState('0')
  const [slippage,setSlippage] = useState('0')
  const [result,setResult] = useState<Result|null>(null)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [status,setStatus] = useState('Evaluate how the historical strategy behaved in distinct market conditions.')
  const run = async () => {
    setBusy(true);setError('');setResult(null);setStatus('Fetching historical candles and classifying regimes…')
    try {
      const params = new URLSearchParams({timeframe,target_r:targetR,max_hold_bars:hold,candles_limit:limit,commission_r:commission,slippage_price:slippage})
      const response = await fetch(`${API}/api/v1/backtest/${symbol}/regime-analysis?${params.toString()}`,{cache:'no-store'})
      const payload = await response.json()
      if(!response.ok) throw new Error(payload.detail || payload.reason || `Regime analysis returned ${response.status}`)
      setResult(payload);setStatus(`Analysis complete · ${payload.classified_candles} candles classified`)
    } catch(e) {setError(e instanceof Error?e.message:'Regime analysis failed.');setStatus('Analysis unavailable.')} finally {setBusy(false)}
  }
  return <section className="panel history-panel" aria-label="Historical market regime analysis">
    <div className="panel-head"><div><p className="eyebrow">HISTORICAL MARKET CONDITIONS</p><h2>Market regime analysis</h2><p className="muted">Compare strategy results in trending, ranging and high-volatility periods</p></div><span className="history-count">{busy?'RUNNING':result?'RESULTS':'READY'}</span></div>
    <div className="pip-fields">
      <label>Market<select value={symbol} onChange={e=>setSymbol(e.target.value)}><option>XAUUSD</option><option>BTCUSD</option><option>EURUSD</option><option>GBPUSD</option></select></label>
      <label>Timeframe<select value={timeframe} onChange={e=>setTimeframe(e.target.value)}><option>5m</option><option>15m</option><option>45m</option><option>1h</option><option>4h</option></select></label>
      <label>Target R<select value={targetR} onChange={e=>setTargetR(e.target.value)}><option value="1">1R</option><option value="2">2R</option><option value="3">3R</option></select></label>
      <label>Max hold bars<input type="number" min="1" max="100" value={hold} onChange={e=>setHold(e.target.value)}/></label>
      <label>Candles (45–1000)<input type="number" min="45" max="1000" value={limit} onChange={e=>setLimit(e.target.value)}/></label>
      <label>Commission (R)<input type="number" min="0" step="0.01" value={commission} onChange={e=>setCommission(e.target.value)}/></label>
      <label>Slippage per side (price)<input type="number" min="0" step="0.01" value={slippage} onChange={e=>setSlippage(e.target.value)}/></label>
    </div>
    <button className="refresh" type="button" disabled={busy} onClick={()=>void run()}>{busy?'Analyzing…':'Run regime analysis'}</button>
    <p className="chart-foot" role="status">{status}</p>{error&&<div className="pip-error" role="alert">{error}</div>}
    {result&&<>
      <div className="metrics demo-metrics">{Object.entries(result.regimes).map(([name,regime])=><article className="metric" key={name}>
        <span>{labels[name] || name}</span><strong className={regime.net_r_total>=0?'green':'red'}>{fmt(regime.net_r_total)} R</strong>
        <small>{regime.trades} trades · expectancy {fmt(regime.expectancy_net_r_per_trade)} R/trade</small>
        <small>{regime.evaluated_segments}/{regime.segments} segments evaluated</small>
      </article>)}</div>
      {Object.entries(result.regimes).map(([name,regime])=><div className="panel" style={{padding:14,marginTop:12}} key={name}>
        <div className="panel-head"><div><p className="eyebrow">SEGMENT BREAKDOWN</p><h3>{labels[name] || name}</h3></div><span className="history-count">{regime.candles} candles</span></div>
        {regime.segment_results.length ? regime.segment_results.map((segment,i)=><div key={i} style={{padding:'12px 0',borderTop:'1px solid var(--border,#283241)'}}>
          <div className="panel-head"><strong>Segment {i+1}</strong><span className="history-count">{time(segment.start_time)} — {time(segment.end_time)}</span></div>
          <div className="metrics demo-metrics">
            <article className="metric"><span>TRADES</span><strong>{segment.trades}</strong><small>{segment.candles} bars</small></article>
            <article className="metric"><span>NET RESULT</span><strong className={segment.net_r_total>=0?'green':'red'}>{fmt(segment.net_r_total)} R</strong></article>
            <article className="metric"><span>EXPECTANCY</span><strong>{fmt(segment.expectancy_net_r_per_trade)} R</strong></article>
            <article className="metric"><span>PROFIT FACTOR</span><strong>{pf(segment.profit_factor)}</strong></article>
            <article className="metric"><span>MAX DRAWDOWN</span><strong>{fmt(segment.max_drawdown_r)} R</strong></article>
          </div>
        </div>) : <p className="score-note">No segment in this regime met the minimum candle threshold.</p>}
      </div>)}
      <p className="score-note">Classified {result.classified_candles} candles. Skipped {result.skipped_short_segments} short segments (minimum {result.minimum_segment_candles} candles).</p>
      <details style={{marginTop:12}}><summary>Method and limitations</summary><p>{result.method}</p><ul>{result.limitations.map((item,i)=><li key={i}>{item}</li>)}</ul></details>
      <p className="chart-foot">Historical diagnostic only—not a live signal, prediction, or proof of a future trading edge. Results depend on available data and estimated costs.</p>
    </>}
  </section>
}
