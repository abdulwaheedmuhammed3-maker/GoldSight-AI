import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, LineSeries, type IChartApi, type Time } from 'lightweight-charts'

type EquityPoint = { trade_index: number; exit_time: string; side: string; net_r: number; cumulative_net_r: number; equity_index: number; peak_equity_index: number; drawdown_r: number; drawdown_pct: number }
type TradeDetail = { trade_index?: number; side: string; entry_time?: string; exit_time: string; entry?: number; exit?: number; stop_loss?: number; target?: number; net_r: number; exit_reason?: string }
type BacktestResult = { symbol: string; timeframe: string; trades: number; wins: number; losses: number; breakeven: number; win_rate_pct: number | null; net_r_total: number; expectancy_net_r_per_trade?: number | null; profit_factor?: number | string | null; max_drawdown_r: number; max_drawdown_pct?: number; max_drawdown_duration_trades?: number; equity_curve?: EquityPoint[]; equity_curve_model?: string; trade_details?: TradeDetail[]; sample_start?: string; sample_end?: string; sample_size_warning?: string | null; reason?: string; limitations?: string[] }

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const number = (value: unknown, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—'
const timeLabel = (value?: string) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) + ' WAT' : '—'

function CurveChart({ points, drawdown = false }: { points: EquityPoint[]; drawdown?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    if (!host.current) return
    const chart = createChart(host.current, { autoSize: true, height: 230, layout: { background: { color: 'transparent' }, textColor: '#9ba8ba', fontFamily: 'Inter, system-ui, sans-serif' }, grid: { vertLines: { color: '#202936' }, horzLines: { color: '#202936' } }, rightPriceScale: { borderColor: '#283241' }, timeScale: { borderColor: '#283241', timeVisible: false }, crosshair: { vertLine: { color: '#718096' }, horzLine: { color: '#718096' } } })
    const series = chart.addSeries(LineSeries, { color: drawdown ? '#ff647c' : '#27d6a0', lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    const data = points.map(point => ({ time: point.trade_index as Time, value: drawdown ? -point.drawdown_pct : point.equity_index })).filter(point => Number.isFinite(Number(point.time)) && Number.isFinite(point.value))
    if (data.length) { series.setData(data); chart.timeScale().fitContent() }
    chartRef.current = chart
    return () => { chart.remove(); chartRef.current = null }
  }, [points, drawdown])
  return <div ref={host} style={{ height: 230, width: '100%' }} aria-label={drawdown ? 'Backtest drawdown chart' : 'Backtest equity curve'} />
}

export default function BacktestAnalytics() {
  const [symbol, setSymbol] = useState('XAUUSD')
  const [timeframe, setTimeframe] = useState('15m')
  const [targetR, setTargetR] = useState('2')
  const [maxHold, setMaxHold] = useState('24')
  const [limit, setLimit] = useState('1000')
  const [commission, setCommission] = useState('0')
  const [slippage, setSlippage] = useState('0')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [selectedTrade, setSelectedTrade] = useState<TradeDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Run a backtest to load verified provider candle history.')
  const curve = useMemo(() => result?.equity_curve || [], [result])
  const run = async () => {
    setBusy(true); setError(''); setSelectedTrade(null); setStatus('Fetching historical candles and running walk-forward simulation…')
    try {
      const params = new URLSearchParams({ timeframe, target_r: targetR, max_hold_bars: maxHold, candles_limit: limit, commission_r: commission, slippage_price: slippage })
      const response = await fetch(`${API}/api/v1/backtest/${symbol}?${params.toString()}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || payload.reason || `Backtest API returned ${response.status}`)
      setResult(payload); setStatus(`Backtest complete · ${payload.trades ?? 0} trades · ${payload.candles_used ?? 0} candles`)
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : 'Backtest failed.'); setStatus('Backtest unavailable.') }
    finally { setBusy(false) }
  }
  return <section className="panel history-panel" aria-label="Backtest equity and drawdown analytics">
    <div className="panel-head"><div><p className="eyebrow">WALK-FORWARD · HISTORICAL CANDLES</p><h2>Backtest analytics</h2><p className="muted">Equity curve and drawdown review</p></div><span className="history-count">{busy ? 'RUNNING' : result ? 'RESULTS' : 'READY'}</span></div>
    <div className="pip-fields">
      <label>Market<select value={symbol} onChange={e => setSymbol(e.target.value)}><option>XAUUSD</option><option>BTCUSD</option><option>EURUSD</option><option>GBPUSD</option></select></label>
      <label>Timeframe<select value={timeframe} onChange={e => setTimeframe(e.target.value)}><option>5m</option><option>15m</option><option>45m</option><option>1h</option><option>4h</option></select></label>
      <label>Target R<select value={targetR} onChange={e => setTargetR(e.target.value)}><option value="1">1R</option><option value="2">2R</option><option value="3">3R</option></select></label>
      <label>Max hold bars<input type="number" min="1" max="100" value={maxHold} onChange={e => setMaxHold(e.target.value} /></label>
      <label>Candles (45–1000)<input type="number" min="45" max="1000" value={limit} onChange={e => setLimit(e.target.value)} /></label>
      <label>Commission (R)<input type="number" min="0" step="0.01" value={commission} onChange={e => setCommission(e.target.value)} /></label>
      <label>Slippage per side (price)<input type="number" min="0" step="0.01" value={slippage} onChange={e => setSlippage(e.target.value)} /></label>
    </div>
    <button className="refresh" type="button" onClick={() => void run()} disabled={busy}>{busy ? 'Running backtest…' : 'Run backtest'}</button>
    <p className="chart-foot" role="status">{status}</p>
    {error && <div className="pip-error" role="alert">{error}</div>}
    {result && <><div className="metrics demo-metrics">
      <article className="metric"><span>NET RESULT</span><strong className={result.net_r_total >= 0 ? 'green' : 'red'}>{number(result.net_r_total)} R</strong><small>{result.trades} completed trades</small></article>
      <article className="metric"><span>WIN RATE</span><strong>{number(result.win_rate_pct)}%</strong><small>{result.wins} wins · {result.losses} losses · {result.breakeven} BE</small></article>
      <article className="metric"><span>EXPECTANCY</span><strong>{number(result.expectancy_net_r_per_trade)} R/trade</strong><small>Net of configured costs</small></article>
      <article className="metric"><span>PROFIT FACTOR</span><strong>{result.profit_factor == null ? '—' : typeof result.profit_factor === 'string' ? result.profit_factor : number(result.profit_factor)}</strong></article>
      <article className="metric"><span>MAX DRAWDOWN</span><strong className="red">{number(result.max_drawdown_r)} R · {number(result.max_drawdown_pct)}%</strong><small>{result.max_drawdown_duration_trades ?? 0} trades peak-to-recovery duration</small></article>
    </div>
    <div className="panel" style={{padding:14,marginTop:12}}><div className="panel-head"><div><p className="eyebrow">FIXED-RISK APPROXIMATION</p><h3>Equity curve · index starts at 100</h3></div><span className="history-count">{curve.length} points</span></div>{curve.length ? <CurveChart points={curve} /> : <div className="history-empty">No equity points returned for this sample.</div>}<p className="score-note">{result.equity_curve_model || 'Equity model description unavailable.'}</p></div>
    <div className="panel" style={{padding:14,marginTop:12}}><div className="panel-head"><div><p className="eyebrow">PEAK-TO-TROUGH</p><h3>Drawdown curve</h3></div><span className="history-count">Maximum {number(result.max_drawdown_pct)}%</span></div>{curve.length ? <CurveChart points={curve} drawdown /> : <div className="history-empty">No drawdown points returned for this sample.</div>}</div>
    {result.sample_size_warning && <p className="pip-error">{result.sample_size_warning}</p>}
    <p className="chart-foot">Sample: {timeLabel(result.sample_start)} — {timeLabel(result.sample_end)} · Provider candle sample, not multi-year proof.</p>
    <div className="panel-head" style={{marginTop:16}}><div><p className="eyebrow">TRADE INSPECTION</p><h3>Recent simulated trades</h3></div><span className="history-count">{result.trade_details?.length || 0} shown</span></div>
    {result.trade_details?.length ? <div className="history-list">{[...result.trade_details].reverse().map((trade, index) => <button type="button" className="history-row history-row-button" key={trade.trade_index ?? index} onClick={() => setSelectedTrade(trade)}><span className={trade.side.toLowerCase()}>{trade.side}</span><b>{trade.trade_index ?? index + 1}</b><span className={trade.net_r >= 0 ? 'green' : 'red'}>{number(trade.net_r)} R</span><span>{trade.exit_reason || 'EXIT'}</span><time>{timeLabel(trade.exit_time)}</time></button>)}</div> : <div className="history-empty">No trades in this backtest sample.</div>}
    {selectedTrade && <div className="history-detail"><div className="history-levels"><article><span>ENTRY</span><strong>{number(selectedTrade.entry, 4)}</strong></article><article><span>EXIT</span><strong>{number(selectedTrade.exit, 4)}</strong></article><article><span>STOP LOSS</span><strong>{number(selectedTrade.stop_loss, 4)}</strong></article><article><span>TARGET</span><strong>{number(selectedTrade.target, 4)}</strong></article><article><span>NET RESULT</span><strong className={selectedTrade.net_r >= 0 ? 'green' : 'red'}>{number(selectedTrade.net_r)} R</strong></article></div><p className="chart-foot">{selectedTrade.side} · {timeLabel(selectedTrade.entry_time)} to {timeLabel(selectedTrade.exit_time)} · {selectedTrade.exit_reason || 'Exit recorded'}</p><button type="button" className="refresh" onClick={() => setSelectedTrade(null)}>Close trade details</button></div>}
    <details style={{marginTop:12}}><summary>Backtest limitations</summary><ul>{(result.limitations || []).map((item,index) => <li key={index}>{item}</li>)}</ul></details>
    </>}
  </section>
}
