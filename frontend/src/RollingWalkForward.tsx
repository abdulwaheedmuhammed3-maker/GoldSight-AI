import { useState } from 'react'

type FoldMetrics = { trades?: number; net_r_total?: number | null; expectancy_net_r_per_trade?: number | null; profit_factor?: number | string | null; max_drawdown_r?: number | null }
type Fold = { fold: number; training_candles: number; oos_candles: number; oos_start: number; oos_end: number; training: FoldMetrics; out_of_sample: FoldMetrics; expectancy_degradation_r: number | null }
type Result = { method: string; train_fraction: number; fold_count: number; folds: Fold[]; aggregate: { out_of_sample_trades: number; out_of_sample_net_r_total: number; pooled_out_of_sample_expectancy_net_r_per_trade: number | null; positive_oos_folds: number; total_folds: number }; robustness_verdict: string; warnings: string[]; limitations: string[] }
const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const fmt = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'
const pf = (value: number | string | null | undefined) => value == null ? '—' : typeof value === 'number' ? fmt(value) : value
const time = (stamp: number) => new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',dateStyle:'medium',timeStyle:'short'}).format(new Date(stamp*1000))+' WAT'

export default function RollingWalkForward() {
  const [symbol,setSymbol] = useState('XAUUSD')
  const [timeframe,setTimeframe] = useState('15m')
  const [targetR,setTargetR] = useState('2')
  const [hold,setHold] = useState('24')
  const [limit,setLimit] = useState('1000')
  const [train,setTrain] = useState('0.60')
  const [folds,setFolds] = useState('3')
  const [commission,setCommission] = useState('0')
  const [slippage,setSlippage] = useState('0')
  const [result,setResult] = useState<Result|null>(null)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [status,setStatus] = useState('Run multiple sequential out-of-sample folds to assess consistency across the candle sample.')
  const run = async () => {
    setBusy(true);setError('');setResult(null);setStatus('Fetching history and running expanding-window folds…')
    try {
      const params = new URLSearchParams({timeframe,target_r:targetR,max_hold_bars:hold,candles_limit:limit,train_fraction:train,folds,commission_r:commission,slippage_price:slippage})
      const response = await fetch(`${API}/api/v1/backtest/${symbol}/rolling-validation?${params.toString()}`,{cache:'no-store'})
      const payload = await response.json()
      if(!response.ok) throw new Error(payload.detail || payload.reason || `Rolling validation returned ${response.status}`)
      setResult(payload);setStatus(`Finished · ${payload.aggregate?.out_of_sample_trades ?? 0} OOS trades across ${payload.fold_count} folds`)
    } catch(e) {setError(e instanceof Error?e.message:'Rolling validation failed.');setStatus('Validation unavailable.')} finally {setBusy(false)}
  }
  return <section className="panel history-panel" aria-label="Rolling walk-forward validation">
    <div className="panel-head"><div><p className="eyebrow">EXPANDING WINDOW · MULTI-FOLD OOS</p><h2>Rolling walk-forward robustness</h2><p className="muted">Sequential unseen segments · fold-by-fold consistency</p></div><span className="history-count">{busy?'RUNNING':result?'RESULTS':'READY'}</span></div>
    <div className="pip-fields">
      <label>Market<select value={symbol} onChange={e=>setSymbol(e.target.value)}><option>XAUUSD</option><option>BTCUSD</option><option>EURUSD</option><option>GBPUSD</option></select></label>
      <label>Timeframe<select value={timeframe} onChange={e=>setTimeframe(e.target.value)}><option>5m</option><option>15m</option><option>45m</option><option>1h</option><option>4h</option></select></label>
      <label>Target R<select value={targetR} onChange={e=>setTargetR(e.target.value)}><option value="1">1R</option><option value="2">2R</option><option value="3">3R</option></select></label>
      <label>Max hold bars<input type="number" min="1" max="100" value={hold} onChange={e=>setHold(e.target.value)}/></label>
      <label>Candle history (300–1000)<input type="number" min="300" max="1000" value={limit} onChange={e=>setLimit(e.target.value)}/></label>
      <label>Initial training share<select value={train} onChange={e=>setTrain(e.target.value)}><option value="0.50">50%</option><option value="0.60">60%</option><option value="0.65">65%</option><option value="0.70">70%</option><option value="0.75">75%</option><option value="0.80">80%</option></select></label>
      <label>OOS folds<select value={folds} onChange={e=>setFolds(e.target.value)}><option value="2">2 folds</option><option value="3">3 folds</option><option value="4">4 folds</option><option value="5">5 folds</option></select></label>
      <label>Commission (R)<input type="number" min="0" step="0.01" value={commission} onChange={e=>setCommission(e.target.value)}/></label>
      <label>Slippage per side (price)<input type="number" min="0" step="0.01" value={slippage} onChange={e=>setSlippage(e.target.value)}/></label>
    </div>
    <button className="refresh" type="button" disabled={busy} onClick={()=>void run()}>{busy?'Running folds…':'Run rolling validation'}</button>
    <p className="chart-foot" role="status">{status}</p>{error&&<div className="pip-error" role="alert">{error}</div>}
    {result&&<>
      <div className="metrics demo-metrics">
        <article className="metric"><span>AGGREGATE OOS TRADES</span><strong>{result.aggregate.out_of_sample_trades}</strong><small>Across {result.fold_count} separate test windows</small></article>
        <article className="metric"><span>POOLED OOS EXPECTANCY</span><strong>{fmt(result.aggregate.pooled_out_of_sample_expectancy_net_r_per_trade)} R</strong></article>
        <article className="metric"><span>OOS NET RESULT</span><strong className={result.aggregate.out_of_sample_net_r_total>=0?'green':'red'}>{fmt(result.aggregate.out_of_sample_net_r_total)} R</strong></article>
        <article className="metric"><span>POSITIVE FOLDS</span><strong>{result.aggregate.positive_oos_folds}/{result.aggregate.total_folds}</strong></article>
      </div>
      <div className="panel" style={{padding:14,marginTop:12}}><p className="eyebrow">ROBUSTNESS VERDICT</p><h3>{result.robustness_verdict}</h3>{result.warnings.map((w,i)=><p className="score-note" key={i}>{w}</p>)}</div>
      <div className="panel" style={{padding:14,marginTop:12}}><div className="panel-head"><div><p className="eyebrow">FOLD DETAILS</p><h3>Train vs unseen test window</h3></div></div>
        {result.folds.map(f=><div key={f.fold} style={{padding:'12px 0',borderTop:'1px solid var(--border,#283241)'}}>
          <div className="panel-head"><strong>Fold {f.fold}</strong><span className="history-count">{time(f.oos_start)} — {time(f.oos_end)}</span></div>
          <div className="metrics demo-metrics">
            <article className="metric"><span>TRAIN TRADES</span><strong>{f.training.trades??'—'}</strong><small>{f.training_candles} candles</small></article>
            <article className="metric"><span>TRAIN EXPECTANCY</span><strong>{fmt(f.training.expectancy_net_r_per_trade)} R</strong></article>
            <article className="metric"><span>OOS TRADES</span><strong>{f.out_of_sample.trades??'—'}</strong><small>{f.oos_candles} candles</small></article>
            <article className="metric"><span>OOS EXPECTANCY</span><strong>{fmt(f.out_of_sample.expectancy_net_r_per_trade)} R</strong></article>
            <article className="metric"><span>OOS PROFIT FACTOR</span><strong>{pf(f.out_of_sample.profit_factor)}</strong></article>
            <article className="metric"><span>EXPECTANCY DEGRADATION</span><strong>{fmt(f.expectancy_degradation_r)} R</strong></article>
          </div>
        </div>)}
      </div>
      <details style={{marginTop:12}}><summary>Method and limitations</summary><p>{result.method}</p><ul>{result.limitations.map((l,i)=><li key={i}>{l}</li>)}</ul></details>
    </>}
  </section>
}
