import { useEffect, useState } from 'react'
import { readDataCache, writeDataCache } from './dataCache'

type Segment = { candles: number; start_time: number; end_time: number; trades: number; net_r_total: number; expectancy_net_r_per_trade: number | null; profit_factor: number | string | null; max_drawdown_r: number | null }
type Regime = { segments: number; evaluated_segments: number; candles: number; trades: number; net_r_total: number; expectancy_net_r_per_trade: number | null; segment_results: Segment[] }
type Result = { symbol: string; timeframe: string; method: string; regimes: Record<string, Regime>; classified_candles: number; skipped_short_segments: number; minimum_segment_candles: number; limitations: string[] }
type MatrixRow = { timeframe: string; result: Result }
const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const fmt = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'
const pf = (v: number | string | null) => v == null ? '—' : typeof v === 'number' ? fmt(v) : v
const time = (v: number) => new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',dateStyle:'medium',timeStyle:'short'}).format(new Date(v*1000))+' WAT'
const labels: Record<string,string> = { TRENDING:'Trending', RANGING:'Ranging', HIGH_VOLATILITY:'High volatility' }

export default function MarketRegimeAnalysis() {
  const [symbol,setSymbol] = useState(() => readDataCache<string>('goldsight-regime-symbol-v1','XAUUSD'))
  const [timeframe,setTimeframe] = useState(() => readDataCache<string>('goldsight-regime-timeframe-v1','15m'))
  const [targetR,setTargetR] = useState(() => readDataCache<string>('goldsight-regime-target-r-v1','2'))
  const [hold,setHold] = useState(() => readDataCache<string>('goldsight-regime-hold-v1','24'))
  const [limit,setLimit] = useState(() => readDataCache<string>('goldsight-regime-limit-v1','1000'))
  const [commission,setCommission] = useState(() => readDataCache<string>('goldsight-regime-commission-v1','0'))
  const [slippage,setSlippage] = useState(() => readDataCache<string>('goldsight-regime-slippage-v1','0'))
  const resultKey = `goldsight-regime-result-v1:${symbol}:${timeframe}:${targetR}:${hold}:${limit}:${commission}:${slippage}`
  const [result,setResult] = useState<Result|null>(() => readDataCache<Result|null>(resultKey,null))
  const [included,setIncluded] = useState<Record<string,boolean>>({ TRENDING:true, RANGING:true, HIGH_VOLATILITY:true })
  const [matrixTimeframes,setMatrixTimeframes] = useState<string[]>(() => readDataCache<string[]>('goldsight-regime-matrix-timeframes-v1',['5m','15m','1h','4h']))
  const matrixKey = `goldsight-regime-matrix-v1:${symbol}:${targetR}:${hold}:${limit}:${commission}:${slippage}:${[...matrixTimeframes].sort().join(',')}`
  const [matrixResult,setMatrixResult] = useState<MatrixRow[]>(() => readDataCache<MatrixRow[]>(matrixKey,[]))
  const [matrixBusy,setMatrixBusy] = useState(false)
  const [matrixError,setMatrixError] = useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [status,setStatus] = useState('Evaluate how the historical strategy behaved in distinct market conditions.')
  useEffect(() => { setResult(readDataCache<Result|null>(resultKey,null)) },[resultKey])
  useEffect(() => { setMatrixResult(readDataCache<MatrixRow[]>(matrixKey,[])) },[matrixKey])
  useEffect(() => {
    writeDataCache('goldsight-regime-symbol-v1',symbol)
    writeDataCache('goldsight-regime-timeframe-v1',timeframe)
    writeDataCache('goldsight-regime-target-r-v1',targetR)
    writeDataCache('goldsight-regime-hold-v1',hold)
    writeDataCache('goldsight-regime-limit-v1',limit)
    writeDataCache('goldsight-regime-commission-v1',commission)
    writeDataCache('goldsight-regime-slippage-v1',slippage)
    writeDataCache('goldsight-regime-matrix-timeframes-v1',matrixTimeframes)
  },[symbol,timeframe,targetR,hold,limit,commission,slippage,matrixTimeframes])
  const run = async () => {
    setBusy(true);setError('');setStatus('Fetching historical candles and classifying regimes…')
    try {
      const params = new URLSearchParams({timeframe,target_r:targetR,max_hold_bars:hold,candles_limit:limit,commission_r:commission,slippage_price:slippage})
      const response = await fetch(`${API}/api/v1/backtest/${symbol}/regime-analysis?${params.toString()}`,{cache:'no-store'})
      const payload = await response.json()
      if(!response.ok) throw new Error(payload.detail || payload.reason || `Regime analysis returned ${response.status}`)
      setResult(payload);writeDataCache(resultKey,payload);setStatus(`Analysis complete · ${payload.classified_candles} candles classified`)
    } catch(e) {setError(e instanceof Error?e.message:'Regime analysis failed.');setStatus('Refresh failed; the last successful analysis is retained when available.')} finally {setBusy(false)}
  }
  const runMatrix = async () => {
    if (!matrixTimeframes.length) { setMatrixError('Select at least one timeframe.'); return }
    setMatrixBusy(true); setMatrixError('')
    try {
      const rows = await Promise.all(matrixTimeframes.map(async tf => {
        const params = new URLSearchParams({timeframe:tf,target_r:targetR,max_hold_bars:hold,candles_limit:limit,commission_r:commission,slippage_price:slippage})
        const response = await fetch(`${API}/api/v1/backtest/${symbol}/regime-analysis?${params.toString()}`,{cache:'no-store'})
        const payload = await response.json()
        if (!response.ok) throw new Error(`${tf}: ${payload.detail || payload.reason || `HTTP ${response.status}`}`)
        return {timeframe:tf,result:payload as Result}
      }))
      setMatrixResult(rows); writeDataCache(matrixKey,rows)
    } catch(e) { setMatrixError(e instanceof Error?e.message:'Cross-timeframe refresh failed; the last successful matrix is retained when available.') }
    finally { setMatrixBusy(false) }
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
    <div className="panel" style={{padding:14,marginTop:14}}>
      <div className="panel-head"><div><p className="eyebrow">CROSS-TIMEFRAME DIAGNOSTIC</p><h3>Regime performance breakdown</h3><p className="muted">Compare historical regime outcomes across timeframes for the selected market.</p></div><span className="history-count">{matrixBusy?'RUNNING':matrixResult.length?'RESULTS':'READY'}</span></div>
      <div className="settings-actions" style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {['5m','15m','1h','4h'].map(tf=><button type="button" key={tf} className={matrixTimeframes.includes(tf)?'selected':''} aria-pressed={matrixTimeframes.includes(tf)} onClick={()=>setMatrixTimeframes(current=>current.includes(tf)?current.filter(x=>x!==tf):[...current,tf])}>{matrixTimeframes.includes(tf)?'Selected':'Select'} · {tf}</button>)}
      </div>
      <button className="refresh" type="button" disabled={matrixBusy} onClick={()=>void runMatrix()}>{matrixBusy?'Comparing timeframes…':'Run cross-timeframe breakdown'}</button>
      {matrixError&&<div className="pip-error" role="alert">{matrixError}</div>}
      {matrixResult.length>0&&<div style={{overflowX:'auto',marginTop:12}}>
        <table style={{width:'100%',borderCollapse:'collapse',textAlign:'left'}}>
          <thead><tr>{['Timeframe','Regime','Trades','Net result (R)','Expectancy (R/trade)','Sample note'].map(x=><th key={x} style={{padding:10,borderBottom:'1px solid var(--border,#283241)'}}>{x}</th>)}</tr></thead>
          <tbody>{matrixResult.flatMap(row=>Object.entries(row.result.regimes).map(([name,regime])=><tr key={row.timeframe+name}>
            <td style={{padding:10}}>{row.timeframe}</td><td style={{padding:10}}>{labels[name]||name}</td><td style={{padding:10}}>{regime.trades}</td>
            <td style={{padding:10}} className={regime.net_r_total>=0?'green':'red'}>{fmt(regime.net_r_total)}</td><td style={{padding:10}}>{fmt(regime.expectancy_net_r_per_trade)}</td>
            <td style={{padding:10}}>{regime.trades<20?'Low sample (<20 trades)':regime.trades<50?'Limited sample (<50 trades)':'Sample size ≥50 trades'}</td>
          </tr>))}</tbody>
        </table>
        <p className="score-note">This compares independent historical slices, not a simultaneous portfolio. Low trade counts make expectancy unstable; no timeframe or regime is ranked as a guaranteed edge.</p>
      </div>}
    </div>

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
      {(() => {
        const entries = Object.entries(result.regimes)
        const summarize = (items: typeof entries) => {
          const trades = items.reduce((sum, [, regime]) => sum + regime.trades, 0)
          const netR = items.reduce((sum, [, regime]) => sum + regime.net_r_total, 0)
          const expectancy = trades ? items.reduce((sum, [, regime]) => sum + (regime.expectancy_net_r_per_trade ?? 0) * regime.trades, 0) / trades : null
          return { trades, netR, expectancy }
        }
        const all = summarize(entries)
        const chosen = summarize(entries.filter(([name]) => included[name] !== false))
        const excluded = entries.filter(([name]) => included[name] === false).map(([name]) => labels[name] || name)
        return <div className="panel" style={{padding:14,marginTop:14}}>
          <div className="panel-head"><div><p className="eyebrow">REGIME FILTER COMPARISON</p><h3>Include or exclude market conditions</h3><p className="muted">Compare the aggregate historical result when the strategy skips selected regimes.</p></div></div>
          <div className="settings-actions" style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {entries.map(([name])=><button type="button" key={name} className={included[name] !== false ? 'selected' : ''} aria-pressed={included[name] !== false} onClick={()=>setIncluded(current=>({...current,[name]:current[name] === false}))}>{included[name] !== false ? 'Include' : 'Exclude'} · {labels[name] || name}</button>)}
          </div>
          <div className="metrics demo-metrics" style={{marginTop:12}}>
            <article className="metric"><span>ALL REGIMES · BASELINE</span><strong className={all.netR>=0?'green':'red'}>{fmt(all.netR)} R</strong><small>{all.trades} trades · expectancy {fmt(all.expectancy)} R/trade</small></article>
            <article className="metric"><span>SELECTED REGIMES</span><strong className={chosen.netR>=0?'green':'red'}>{fmt(chosen.netR)} R</strong><small>{chosen.trades} trades · expectancy {fmt(chosen.expectancy)} R/trade</small></article>
            <article className="metric"><span>CHANGE VS BASELINE</span><strong className={chosen.netR-all.netR>=0?'green':'red'}>{fmt(chosen.netR-all.netR)} R</strong><small>{chosen.trades-all.trades} trades · excluded {excluded.length ? excluded.join(', ') : 'none'}</small></article>
          </div>
          <p className="score-note">Descriptive aggregation of regime slices, not a rerun with a live filter. Slice boundaries restart strategy warm-up; overlapping trades and transition effects are not modeled as one continuous portfolio.</p>
        </div>
      })()}
      <p className="score-note">Classified {result.classified_candles} candles. Skipped {result.skipped_short_segments} short segments (minimum {result.minimum_segment_candles} candles).</p>
      <details style={{marginTop:12}}><summary>Method and limitations</summary><p>{result.method}</p><ul>{result.limitations.map((item,i)=><li key={i}>{item}</li>)}</ul></details>
      <p className="chart-foot">Historical diagnostic only—not a live signal, prediction, or proof of a future trading edge. Results depend on available data and estimated costs.</p>
    </>}
  </section>
}
