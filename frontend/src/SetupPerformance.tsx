import { useEffect, useState } from 'react'

type Metrics = { wins: number; losses: number; void: number; resolved: number; win_rate_pct: number }
type MarketMetrics = Metrics & { symbol: string; timeframe: string }
type PerformanceResponse = { records_scanned: number; overall: Metrics; by_market: MarketMetrics[]; scope: string; method: string }

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const metric = (value: number) => Number.isFinite(value) ? value.toLocaleString() : '—'

export default function SetupPerformance() {
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const response = await fetch(`${API}/api/v1/setups/performance?limit=200`)
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.detail || `Performance request failed (${response.status})`)
        }
        const payload = await response.json() as PerformanceResponse
        if (active) setData(payload)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load tracked setup performance.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  return <section className="panel" aria-live="polite">
    <div className="panel-head"><div><p className="eyebrow">RECORDED SETUPS · LAST 200 RECORDS MAX</p><h2>Setup performance</h2></div><span className="signal-badge">{loading ? 'LOADING' : error ? 'UNAVAILABLE' : 'TRACKED'}</span></div>
    {loading && !data ? <p className="muted">Loading recorded outcomes…</p> : error && !data ? <p role="alert" className="muted">{error}</p> : data ? <>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:12,marginBottom:16}}>
        <div><p className="eyebrow">WIN RATE</p><strong style={{fontSize:24}}>{data.overall.win_rate_pct.toFixed(2)}%</strong></div>
        <div><p className="eyebrow">RESOLVED</p><strong style={{fontSize:24}}>{metric(data.overall.resolved)}</strong></div>
        <div><p className="eyebrow">WINS / LOSSES</p><strong style={{fontSize:24}}>{metric(data.overall.wins)} / {metric(data.overall.losses)}</strong></div>
        <div><p className="eyebrow">VOID</p><strong style={{fontSize:24}}>{metric(data.overall.void)}</strong></div>
      </div>
      {data.by_market.length ? <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><th align="left">Market</th><th align="left">TF</th><th align="right">Win rate</th><th align="right">Resolved</th><th align="right">W / L</th></tr></thead><tbody>{data.by_market.map((row) => <tr key={row.symbol + row.timeframe}><td>{row.symbol}</td><td>{row.timeframe}</td><td align="right">{row.win_rate_pct.toFixed(2)}%</td><td align="right">{metric(row.resolved)}</td><td align="right">{row.wins} / {row.losses}</td></tr>)}</tbody></table></div> : <p className="muted">No resolved setup outcomes in the scanned records yet.</p>}
      <p className="muted" style={{fontSize:12,marginTop:12}}>Scanned {metric(data.records_scanned)} records. {data.scope} {data.method} Stats are tracked outcome labels—not a forecast or verified profitability; execution costs are excluded.</p>
    </> : null}
  </section>
}
