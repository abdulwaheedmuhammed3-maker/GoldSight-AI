import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, type IChartApi, type CandlestickData, type Time } from 'lightweight-charts'

const API = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
const demoBars: CandlestickData<Time>[] = Array.from({ length: 48 }, (_, i) => {
  const base = 4320 + Math.sin(i / 4) * 22 + i * 0.7
  const open = base + Math.sin(i * 1.7) * 4
  const close = base + Math.cos(i * 1.3) * 5
  return { time: (Date.UTC(2026, 9, 26, 0, i * 30) / 1000) as Time, open, high: Math.max(open, close) + 3.2, low: Math.min(open, close) - 3.5, close }
})

function PriceChart() {
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    if (!host.current) return
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: '#10151d' }, textColor: '#9ba8ba', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: '#202936' }, horzLines: { color: '#202936' } },
      rightPriceScale: { borderColor: '#283241' },
      timeScale: { borderColor: '#283241', timeVisible: true },
      crosshair: { vertLine: { color: '#718096' }, horzLine: { color: '#718096' } },
    })
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#27d6a0', downColor: '#ff647c', borderVisible: false,
      wickUpColor: '#27d6a0', wickDownColor: '#ff647c',
    })
    candles.setData(demoBars)
    chart.timeScale().fitContent()
    chartRef.current = chart
    return () => { chart.remove(); chartRef.current = null }
  }, [])
  return <div className="chart" ref={host} aria-label="Demonstration candlestick chart" />
}

export default function App() {
  const [apiStatus, setApiStatus] = useState('Checking API…')
  const [forecast, setForecast] = useState<{ direction: string; note: string } | null>(null)
  useEffect(() => {
    let active = true
    fetch(`${API}/api/v1/health`).then(r => r.json()).then(d => { if (active) setApiStatus(d.status === 'ok' ? 'API online' : 'API unavailable') }).catch(() => { if (active) setApiStatus('API offline') })
    fetch(`${API}/api/v1/forecast/demo`).then(r => r.json()).then(d => { if (active) setForecast({ direction: d.direction, note: d.note }) }).catch(() => {})
    return () => { active = false }
  }, [])
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark">G</span><span>GoldSight <b>AI</b><small>GOLD MARKET INTELLIGENCE</small></span></a>
        <div className="status"><span className="dot" /> DEMO MODE <span className="divider">|</span> {apiStatus}</div>
      </header>
      <section className="intro">
        <div><p className="eyebrow">MARKET OVERVIEW / XAUUSD</p><h1>See the market.<br/><em>Think in scenarios.</em></h1><p className="muted">A market analysis workspace for gold traders. Live data is not connected yet.</p></div>
        <div className="session"><span className="pulse" /> SAMPLE DATA <small>Not a live quote</small></div>
      </section>
      <section className="metrics">
        <article className="metric"><span>INSTRUMENT</span><strong>XAUUSD</strong><small>Gold / US Dollar</small></article>
        <article className="metric"><span>DEMO PRICE</span><strong>4,35{(20 + 6).toString()}<i>.40</i></strong><small>Illustrative value only</small></article>
        <article className="metric"><span>MARKET BIAS</span><strong className="neutral">Not calculated</strong><small>Awaiting validated market feed</small></article>
        <article className="metric"><span>FORECAST SERVICE</span><strong className="neutral">{forecast?.direction ?? 'Not connected'}</strong><small>{forecast?.note ?? 'Demo endpoint status'}</small></article>
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="eyebrow">PRICE ACTION</p><h2>Gold price structure</h2></div><div className="timeframes"><button className="selected">30m</button><button disabled>1H</button><button disabled>4H</button><button disabled>1D</button></div></div>
        <div className="chart-label"><span><b className="legend-dot" /> XAUUSD · DEMONSTRATION CANDLES</span><span>SIMULATED DATA</span></div>
        <PriceChart />
        <p className="chart-foot">Synthetic candles for interface testing only. Do not use for trading decisions.</p>
      </section>
      <section className="bottom-grid">
        <article className="panel insight"><p className="eyebrow">MODEL OUTPUT</p><h2>Forecast workspace</h2><p className="muted">Forecasts will appear here once a model is implemented, evaluated, and connected to market data.</p><div className="empty-state"><span>↗</span><div><b>No validated forecast yet</b><small>Model predictions are not available in this scaffold.</small></div></div></article>
        <article className="panel insight"><p className="eyebrow">NEXT SIGNALS</p><h2>Market context</h2><div className="context-row"><span>Market data</span><b>Not connected</b></div><div className="context-row"><span>Economic calendar</span><b>Not connected</b></div><div className="context-row"><span>Key levels</span><b>Not calculated</b></div><div className="context-row"><span>Risk controls</span><b>Manual review required</b></div></article>
      </section>
      <footer><span>GoldSight AI · MVP scaffold</span><span>Forecasts are uncertain. Always manage risk independently.</span></footer>
    </main>
  )
}
