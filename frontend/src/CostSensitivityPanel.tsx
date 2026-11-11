import { useEffect, useState } from 'react'
import { readDataCache, writeDataCache } from './dataCache'

type Scenario = {
  cost_multiplier: number
  spread_price_units: number
  commission_r: number
  slippage_price_units_per_side: number
  trades: number
  net_r_total: number | null
  expectancy_net_r_per_trade: number | null
  profit_factor: number | string | null
  max_drawdown_r: number | null
  positive_expectancy: boolean
}
type Report = {
  cost_resilience_verdict: string
  highest_tested_positive_expectancy_cost_multiplier: number | null
  base_cost_assumptions: { spread_price_units: number; commission_r: number; slippage_price_units_per_side: number }
  scenarios: Scenario[]
  warning: string
}
const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
const fmt = (value: unknown, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—'

export default function CostSensitivityPanel({ symbol, timeframe, targetR, maxHold, limit, commission, slippage }: {
  symbol: string; timeframe: string; targetR: string; maxHold: string; limit: string; commission: string; slippage: string
}) {
  const reportKey = `goldsight-cost-sensitivity-v1:${symbol}:${timeframe}:${targetR}:${maxHold}:${limit}:${commission}:${slippage}`
  const [report, setReport] = useState<Report | null>(() => readDataCache<Report | null>(reportKey,null))
  useEffect(() => { setReport(readDataCache<Report | null>(reportKey,null)) },[reportKey])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true); setError('')
    try {
      const params = new URLSearchParams({ timeframe, target_r: targetR, max_hold_bars: maxHold, candles_limit: limit, commission_r: commission, slippage_price: slippage })
      const response = await fetch(`${API}/api/v1/backtest/${symbol}/cost-sensitivity?${params.toString()}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || `Cost sensitivity API returned ${response.status}`)
      setReport(payload)
      writeDataCache(reportKey,payload)
    } catch (e) { setError(e instanceof Error ? e.message : 'Cost sensitivity refresh failed; the last successful report is retained when available.') }
    finally { setBusy(false) }
  }
  return <section className="panel" style={{ padding: 14, marginTop: 12 }} aria-label="Backtest cost sensitivity">
    <div className="panel-head"><div><p className="eyebrow">EXECUTION COST STRESS TEST</p><h3>Cost sensitivity</h3><p className="muted">Re-run the strategy with 1× to 3× estimated spread, commission and slippage.</p></div><span className="history-count">{report ? 'RESULTS' : 'READY'}</span></div>
    <button className="refresh" type="button" onClick={() => void run()} disabled={busy}>{busy ? 'Stress testing…' : 'Run cost sensitivity'}</button>
    {error && <div className="pip-error" role="alert">{error}</div>}
    {report && <>
      <div className="metrics demo-metrics" style={{ marginTop: 12 }}>
        <article className="metric"><span>RESILIENCE VERDICT</span><strong>{report.cost_resilience_verdict}</strong><small>Hypothetical execution-cost stress</small></article>
        <article className="metric"><span>HIGHEST POSITIVE COST</span><strong>{report.highest_tested_positive_expectancy_cost_multiplier == null ? '—' : `${fmt(report.highest_tested_positive_expectancy_cost_multiplier)}×`}</strong><small>Expectancy remained above zero</small></article>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 12 }}><table className="history-table"><thead><tr><th>Costs</th><th>Spread</th><th>Commission R</th><th>Slippage/side</th><th>Trades</th><th>Net R</th><th>Expectancy</th><th>PF</th><th>Max DD R</th></tr></thead><tbody>{report.scenarios.map(row => <tr key={row.cost_multiplier}><td>{fmt(row.cost_multiplier)}×</td><td>{fmt(row.spread_price_units, 4)}</td><td>{fmt(row.commission_r, 4)}</td><td>{fmt(row.slippage_price_units_per_side, 4)}</td><td>{row.trades}</td><td className={row.net_r_total != null && row.net_r_total >= 0 ? 'green' : 'red'}>{fmt(row.net_r_total)}</td><td className={row.positive_expectancy ? 'green' : 'red'}>{fmt(row.expectancy_net_r_per_trade)}</td><td>{typeof row.profit_factor === 'number' ? fmt(row.profit_factor) : row.profit_factor ?? '—'}</td><td>{fmt(row.max_drawdown_r)}</td></tr>)}</tbody></table></div>
      <p className="chart-foot">{report.warning}</p>
    </>}
  </section>
}
