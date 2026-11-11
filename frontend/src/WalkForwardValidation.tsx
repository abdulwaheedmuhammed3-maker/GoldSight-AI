import { useEffect, useState } from 'react'
import { readDataCache, writeDataCache } from './dataCache'

type Metrics = { trades?: number; wins?: number; losses?: number; breakeven?: number; win_rate_pct?: number | null; net_r_total?: number | null; expectancy_net_r_per_trade?: number | null; profit_factor?: number | string | null; max_drawdown_r?: number | null; max_drawdown_pct?: number | null; reason?: string | null }
type Validation = { symbol: string; timeframe: string; method: string; train_fraction: number; split_time: number | null; in_sample: Metrics; out_of_sample: Metrics; comparison: { in_sample_expectancy_net_r_per_trade?: number | null; out_of_sample_expectancy_net_r_per_trade?: number | null; expectancy_degradation_r?: number | null; in_sample_profit_factor?: number | string | null; out_of_sample_profit_factor?: number | string | null; in_sample_trades: number; out_of_sample_trades: number }; robustness_verdict: string; warnings: string[]; limitations: string[] }

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const fmt = (v: unknown, digits = 2) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'
const pf = (v: number | string | null | undefined) => v == null ? '—' : typeof v === 'number' ? fmt(v) : v
const metric = (label: string, value: string, hint?: string) => <article className="metric"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>

export default function WalkForwardValidation() {
  const [symbol, setSymbol] = useState(() => readDataCache<string>('goldsight-walkforward-symbol-v1','XAUUSD'))
  const [timeframe, setTimeframe] = useState(() => readDataCache<string>('goldsight-walkforward-timeframe-v1','15m'))
  const [targetR, setTargetR] = useState(() => readDataCache<string>('goldsight-walkforward-target-r-v1','2'))
  const [maxHold, setMaxHold] = useState(() => readDataCache<string>('goldsight-walkforward-max-hold-v1','24'))
  const [limit, setLimit] = useState(() => readDataCache<string>('goldsight-walkforward-limit-v1','1000'))
  const [commission, setCommission] = useState(() => readDataCache<string>('goldsight-walkforward-commission-v1','0'))
  const [slippage, setSlippage] = useState(() => readDataCache<string>('goldsight-walkforward-slippage-v1','0'))
  const [trainFraction, setTrainFraction] = useState(() => readDataCache<string>('goldsight-walkforward-train-v1','0.70'))
  const resultKey = `goldsight-walkforward-result-v1:${symbol}:${timeframe}:${targetR}:${maxHold}:${limit}:${commission}:${slippage}:${trainFraction}`
  const [result, setResult] = useState<Validation | null>(() => readDataCache<Validation | null>(resultKey,null))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Run a chronological holdout to compare in-sample and unseen out-of-sample results.')
  useEffect(() => { setResult(readDataCache<Validation | null>(resultKey,null)) },[resultKey])
  useEffect(() => {
    writeDataCache('goldsight-walkforward-symbol-v1',symbol)
    writeDataCache('goldsight-walkforward-timeframe-v1',timeframe)
    writeDataCache('goldsight-walkforward-target-r-v1',targetR)
    writeDataCache('goldsight-walkforward-max-hold-v1',maxHold)
    writeDataCache('goldsight-walkforward-limit-v1',limit)
    writeDataCache('goldsight-walkforward-commission-v1',commission)
    writeDataCache('goldsight-walkforward-slippage-v1',slippage)
    writeDataCache('goldsight-walkforward-train-v1',trainFraction)
  },[symbol,timeframe,targetR,maxHold,limit,commission,slippage,trainFraction])
  const run = async () => {
    setBusy(true); setError(''); setStatus('Fetching candles and validating the holdout segment…')
    try {
      const params = new URLSearchParams({ timeframe, target_r: targetR, max_hold_bars: maxHold, candles_limit: limit, commission_r: commission, slippage_price: slippage, train_fraction: trainFraction })
      const response = await fetch(`${API}/api/v1/backtest/${symbol}/validation?${params.toString()}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || payload.reason || `Validation API returned ${response.status}`)
      setResult(payload); writeDataCache(resultKey,payload); setStatus(`Validation complete · ${payload.comparison?.out_of_sample_trades ?? 0} out-of-sample trades`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Validation failed.'); setStatus('Validation refresh failed; the last successful result is retained when available.') }
    finally { setBusy(false) }
  }
  return <section className="panel history-panel" aria-label="Walk-forward holdout validation">
    <div className="panel-head"><div><p className="eyebrow">CHRONOLOGICAL HOLDOUT · OOS</p><h2>Walk-forward validation</h2><p className="muted">Train on earlier candles; evaluate separately on later unseen candles</p></div><span className="history-count">{busy ? 'RUNNING' : result ? 'RESULTS' : 'READY'}</span></div>
    <div className="pip-fields">
      <label>Market<select value={symbol} onChange={e => setSymbol(e.target.value)}><option>XAUUSD</option><option>BTCUSD</option><option>EURUSD</option><option>GBPUSD</option></select></label>
      <label>Timeframe<select value={timeframe} onChange={e => setTimeframe(e.target.value)}><option>5m</option><option>15m</option><option>45m</option><option>1h</option><option>4h</option></select></label>
      <label>Target R<select value={targetR} onChange={e => setTargetR(e.target.value)}><option value="1">1R</option><option value="2">2R</option><option value="3">3R</option></select></label>
      <label>Max hold bars<input type="number" min="1" max="100" value={maxHold} onChange={e => setMaxHold(e.target.value)} /></label>
      <label>Candles (45–1000)<input type="number" min="45" max="1000" value={limit} onChange={e => setLimit(e.target.value)} /></label>
      <label>Training share (50–85%)<select value={trainFraction} onChange={e => setTrainFraction(e.target.value)}><option value="0.50">50%</option><option value="0.60">60%</option><option value="0.70">70%</option><option value="0.75">75%</option><option value="0.80">80%</option><option value="0.85">85%</option></select></label>
      <label>Commission (R)<input type="number" min="0" step="0.01" value={commission} onChange={e => setCommission(e.target.value)} /></label>
      <label>Slippage per side (price)<input type="number" min="0" step="0.01" value={slippage} onChange={e => setSlippage(e.target.value)} /></label>
    </div>
    <button className="refresh" type="button" onClick={() => void run()} disabled={busy}>{busy ? 'Validating…' : 'Run holdout validation'}</button>
    <p className="chart-foot" role="status">{status}</p>
    {error && <div className="pip-error" role="alert">{error}</div>}
    {result && <>
      <div className="metrics demo-metrics">
        {metric('IN-SAMPLE TRADES', String(result.comparison.in_sample_trades), 'Earlier training segment')}
        {metric('OOS TRADES', String(result.comparison.out_of_sample_trades), 'Later unseen segment')}
        {metric('IN-SAMPLE EXPECTANCY', `${fmt(result.comparison.in_sample_expectancy_net_r_per_trade)} R`)}
        {metric('OOS EXPECTANCY', `${fmt(result.comparison.out_of_sample_expectancy_net_r_per_trade)} R`)}
        {metric('EXPECTANCY DEGRADATION', `${fmt(result.comparison.expectancy_degradation_r)} R`, 'Train expectancy minus OOS')}
        {metric('OOS PROFIT FACTOR', pf(result.comparison.out_of_sample_profit_factor))}
      </div>
      <div className="panel" style={{padding:14,marginTop:12}}>
        <p className="eyebrow">ROBUSTNESS ASSESSMENT</p><h3>{result.robustness_verdict}</h3>
        {result.warnings.map((warning, i) => <p className="score-note" key={i}>{warning}</p>)}
        <p className="chart-foot">Split: {Math.round(result.train_fraction * 100)}% train / {Math.round((1-result.train_fraction) * 100)}% OOS · ${result.split_time ? new Date(result.split_time * 1000).toISOString() : 'split time unavailable'}</p>
      </div>
      <details style={{marginTop:12}}><summary>Validation method and limitations</summary><p>{result.method}</p><ul>{result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></details>
    </>}
  </section>
}
