import { useCallback, useEffect, useMemo, useState } from 'react'
import { readDataCache, writeDataCache } from './dataCache'

type Metrics = { wins: number; losses: number; void: number; resolved: number; win_rate_pct: number }
type MarketMetrics = Metrics & { symbol: string; timeframe: string }
type PerformanceResponse = { records_scanned: number; overall: Metrics; by_market: MarketMetrics[]; scope: string; method: string }

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const metric = (value: number) => Number.isFinite(value) ? value.toLocaleString() : '—'

export default function SetupPerformance() {
  const [data, setData] = useState<PerformanceResponse | null>(() => readDataCache<PerformanceResponse | null>('goldsight-setup-performance-cache-v1',null))
  const [loading, setLoading] = useState(() => !readDataCache<PerformanceResponse | null>('goldsight-setup-performance-cache-v1',null))
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(() => readDataCache<string | null>('goldsight-setup-performance-updated-v1',null))
  const [symbolFilter, setSymbolFilter] = useState('ALL')
  const [timeframeFilter, setTimeframeFilter] = useState('ALL')

  const load = useCallback(async (isActive: () => boolean = () => true) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${API}/api/v1/setups/performance?limit=200`)
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail || `Performance request failed (${response.status})`)
      }
      const payload = await response.json() as PerformanceResponse
      if (isActive()) {
        setData(payload)
        const updated = new Date().toISOString()
        setUpdatedAt(updated)
        writeDataCache('goldsight-setup-performance-cache-v1',payload)
        writeDataCache('goldsight-setup-performance-updated-v1',updated)
      }
    } catch (err) {
      if (isActive()) setError(err instanceof Error ? err.message : 'Unable to load tracked setup performance.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void load(() => active)
    return () => { active = false }
  }, [load])

  const symbols = useMemo(() => ['ALL', ...new Set(data?.by_market.map(row => row.symbol) ?? [])], [data])
  const timeframes = useMemo(() => ['ALL', ...new Set(data?.by_market.map(row => row.timeframe) ?? [])], [data])
  const filtered = useMemo(() => (data?.by_market ?? []).filter(row =>
    (symbolFilter === 'ALL' || row.symbol === symbolFilter) &&
    (timeframeFilter === 'ALL' || row.timeframe === timeframeFilter)
  ), [data, symbolFilter, timeframeFilter])
  const summary = useMemo<Metrics>(() => {
    if (symbolFilter === 'ALL' && timeframeFilter === 'ALL' && data) return data.overall
    const wins = filtered.reduce((sum, row) => sum + row.wins, 0)
    const losses = filtered.reduce((sum, row) => sum + row.losses, 0)
    const voidCount = filtered.reduce((sum, row) => sum + row.void, 0)
    const resolved = wins + losses
    return { wins, losses, void: voidCount, resolved, win_rate_pct: resolved ? wins / resolved * 100 : 0 }
  }, [data, filtered, symbolFilter, timeframeFilter])

  return <section className="panel" aria-live="polite">
    <div className="panel-head"><div><p className="eyebrow">RECORDED SETUPS · LAST 200 RECORDS MAX</p><h2>Setup performance</h2>{updatedAt ? <p className="muted" style={{fontSize:12}}>Updated {new Date(updatedAt).toLocaleTimeString('en-NG', {timeZone:'Africa/Lagos',hour:'2-digit',minute:'2-digit',second:'2-digit'})} WAT</p> : null}</div><div style={{display:'flex',alignItems:'center',gap:8}}><span className="signal-badge">{loading ? (data ? 'REFRESHING' : 'LOADING') : error ? 'STALE / ERROR' : 'TRACKED'}</span><button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh setup performance">{loading ? 'Refreshing…' : 'Refresh'}</button></div></div>
    {loading && !data ? <p className="muted">Loading recorded outcomes…</p> : error && !data ? <p role="alert" className="muted">{error}</p> : data ? <>
      {error ? <p role="status" className="muted">Refresh failed: {error}. Showing the last successfully loaded results.</p> : null}
      <div style={{display:'flex',flexWrap:'wrap',gap:10,marginBottom:16}}>
        <label>Market <select value={symbolFilter} onChange={event => setSymbolFilter(event.target.value)}>{symbols.map(value => <option key={value} value={value}>{value === 'ALL' ? 'All markets' : value}</option>)}</select></label>
        <label>Timeframe <select value={timeframeFilter} onChange={event => setTimeframeFilter(event.target.value)}>{timeframes.map(value => <option key={value} value={value}>{value === 'ALL' ? 'All timeframes' : value}</option>)}</select></label>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:12,marginBottom:16}}>
        <div><p className="eyebrow">WIN RATE</p><strong style={{fontSize:24}}>{summary.win_rate_pct.toFixed(2)}%</strong></div>
        <div><p className="eyebrow">RESOLVED</p><strong style={{fontSize:24}}>{metric(summary.resolved)}</strong></div>
        <div><p className="eyebrow">WINS / LOSSES</p><strong style={{fontSize:24}}>{metric(summary.wins)} / {metric(summary.losses)}</strong></div>
        <div><p className="eyebrow">VOID</p><strong style={{fontSize:24}}>{metric(summary.void)}</strong></div>
      </div>
      {filtered.length ? <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><th align="left">Market</th><th align="left">TF</th><th align="right">Win rate</th><th align="right">Resolved</th><th align="right">W / L</th></tr></thead><tbody>{filtered.map(row => <tr key={row.symbol + row.timeframe}><td>{row.symbol}</td><td>{row.timeframe}</td><td align="right">{row.win_rate_pct.toFixed(2)}%</td><td align="right">{metric(row.resolved)}</td><td align="right">{row.wins} / {row.losses}</td></tr>)}</tbody></table></div> : <p className="muted">No resolved setup outcomes match these filters.</p>}
      {summary.resolved < 30 ? <p role="note" className="muted" style={{fontSize:12,marginTop:12}}>Small sample: only {metric(summary.resolved)} resolved outcomes in this selection. Treat the win rate as preliminary; more observations are needed before drawing conclusions.</p> : <p role="note" className="muted" style={{fontSize:12,marginTop:12}}>Sample size: {metric(summary.resolved)} resolved outcomes in this selection. Win rate is descriptive and may change as more setups resolve.</p>}\n      <p className="muted" style={{fontSize:12,marginTop:12}}>Scanned {metric(data.records_scanned)} records. {data.scope} {data.method} Stats are tracked outcome labels—not a forecast or verified profitability; execution costs are excluded.</p>
    </> : null}
  </section>
}
