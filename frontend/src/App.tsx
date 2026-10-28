import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CandlestickSeries, type IChartApi, type CandlestickData, type Time } from 'lightweight-charts'

const API = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
type TF = '5m' | '15m' | '1h' | '4h'
type Candle = CandlestickData<Time> & { volume?: number }
type Signal = { status: string; side: string; entry: number | null; stop_loss: number | null; take_profits: number[]; rr: number[] | null; confidence: number | null; confidence_label?: string; reasons: string[]; invalidation: string; signal_time: string | null; trend: string }
type Market = { symbol: string; provider_symbol?: string; provider?: string; provider_note?: string; status: 'LIVE' | 'OFFLINE'; price: number | null; bid: number | null; ask: number | null; spread: number | null; digits?: number; updated_at: string | null; timeframe: TF; candles: Candle[]; signal: Signal }
const emptySignal: Signal = { status: 'NO SETUP', side: 'NO SETUP', entry: null, stop_loss: null, take_profits: [], rr: null, confidence: null, reasons: ['Waiting for live market data.'], invalidation: 'No active setup.', signal_time: null, trend: 'UNKNOWN' }
const fmt = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const dateFmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—'

function PriceChart({ data, digits }: { data: Candle[]; digits: number }) {
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<any>(null)
  useEffect(() => {
    if (!host.current) return
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: '#10151d' }, textColor: '#9ba8ba', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: '#202936' }, horzLines: { color: '#202936' } },
      rightPriceScale: { borderColor: '#283241', entireTextOnly: true },
      timeScale: { borderColor: '#283241', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: '#718096' }, horzLine: { color: '#718096' } },
      localization: { priceFormatter: (price: number) => price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) },
    })
    const series = chart.addSeries(CandlestickSeries, { upColor: '#27d6a0', downColor: '#ff647c', borderVisible: false, wickUpColor: '#27d6a0', wickDownColor: '#ff647c', priceFormat: { type: 'price', precision: digits, minMove: 1 / (10 ** digits) } })
    chartRef.current = chart
    seriesRef.current = series
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [digits])
  useEffect(() => {
    if (!seriesRef.current || !data.length) return
    const valid = data.filter(d => Number.isFinite(Number(d.time)) && [d.open, d.high, d.low, d.close].every(Number.isFinite))
    if (valid.length) { seriesRef.current.setData(valid); chartRef.current?.timeScale().fitContent() }
  }, [data])
  return <div className="chart" ref={host} aria-label="Live candlestick chart" />
}

function SignalCard({ signal, digits, symbol, timeframe }: { signal: Signal; digits: number; symbol: string; timeframe: TF }) {
  const isTrade = signal.status === 'BUY' || signal.status === 'SELL'
  return <section className="panel signal-panel">
    <div className="panel-head"><div><p className="eyebrow">LATEST CONFIRMED SETUP</p><h2>Signal analysis</h2><p className="signal-market">{symbol} · {timeframe.toUpperCase()}</p></div><span className={`signal-badge ${isTrade ? signal.status.toLowerCase() : 'none'}`}>{signal.status || 'NO SETUP'}</span></div>
    {isTrade ? <div className="signal-levels">
      <div><span>ENTRY</span><b>{fmt(signal.entry, digits)}</b></div><div><span>STOP LOSS</span><b className="red">{fmt(signal.stop_loss, digits)}</b></div>
      {signal.take_profits.map((tp, i) => <div key={i}><span>TP{i + 1} · 1:{signal.rr?.[i] ?? i + 1}</span><b className="green">{fmt(tp, digits)}</b></div>)}
      <div><span>RULE SCORE</span><b>{signal.confidence}%</b></div>
    </div> : <div className="no-setup"><b>No valid setup right now</b><p>GoldSight will not force a trade when the conditions are incomplete.</p></div>}
    <div className="reasons"><h3>Why this decision?</h3><ul>{(signal.reasons?.length ? signal.reasons : ['Insufficient confirmed evidence.']).map((r, i) => <li key={i}>{r}</li>)}</ul></div>
    <div className="signal-meta"><span>Signal candle: {dateFmt(signal.signal_time)}</span><span>Trend: <b>{signal.trend || 'UNKNOWN'}</b></span></div>
    <p className="invalidation"><b>Invalidation:</b> {signal.invalidation}</p>
    <p className="score-note">The rule score is an internal alignment estimate, not a probability of winning or a guarantee.</p>
  </section>
}

export default function App() {
  const [symbol, setSymbol] = useState<'XAUUSD' | 'BTCUSD'>('XAUUSD')
  const [timeframe, setTimeframe] = useState<TF>('15m')
  const [data, setData] = useState<Market | null>(null)
  const [allTf, setAllTf] = useState<Partial<Record<TF, Market>>>({})
  const [loading, setLoading] = useState(true)
  const [lastError, setLastError] = useState('')
  const [history, setHistory] = useState<Array<{ key: string; symbol: string; tf: TF; side: string; time: string; entry: number | null }>>([])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true)
    try {
      const tfs: TF[] = ['4h', '1h', '15m', '5m']
      const results = await Promise.all(tfs.map(async tf => {
        const response = await fetch(`${API}/api/v1/market/${symbol}?timeframe=${tf}`, { cache: 'no-store' })
        const json = await response.json() as Market
        if (!response.ok && response.status !== 503) throw new Error(json?.signal?.reasons?.[0] || `API error ${response.status}`)
        return [tf, json] as const
      }))
      const next = Object.fromEntries(results) as Record<TF, Market>
      setAllTf(next)
      setData(next[timeframe])
      setLastError(next[timeframe].status === 'OFFLINE' ? (next[timeframe].signal?.reasons?.[0] || 'Provider is offline.') : '')
      setUpdatedAt(next[timeframe].updated_at)
      if (next[timeframe].status === 'LIVE') {
        const s = next[timeframe].signal
        const rank: Record<TF, number> = { '5m': 0, '15m': 1, '1h': 2, '4h': 3 }
        const expectedTrend = s.status === 'BUY' ? 'BULLISH' : 'BEARISH'
        const higher = (['5m', '15m', '1h', '4h'] as TF[]).filter(tf => rank[tf] > rank[timeframe])
        const aligned = higher.every(tf => next[tf].status === 'LIVE' && next[tf].signal.trend === expectedTrend)
        if ((s.status === 'BUY' || s.status === 'SELL') && aligned && s.signal_time) {
          const key = `${symbol}:${timeframe}:${s.status}:${s.signal_time}`
          setHistory(old => old.some(x => x.key === key) ? old : [{ key, symbol, tf: timeframe, side: s.status, time: s.signal_time!, entry: s.entry }, ...old].slice(0, 20))
        }
      }
      setLastError(next[timeframe].status === 'LIVE' ? '' : (next[timeframe].signal?.reasons?.[0] || 'Live feed unavailable.'))
    } catch (e) {
      setData({ symbol, status: 'OFFLINE', price: null, bid: null, ask: null, spread: null, updated_at: null, candles: [], timeframe, signal: { ...emptySignal, reasons: [e instanceof Error ? e.message : 'API is unreachable.'] } })
      setLastError(e instanceof Error ? e.message : 'API is unreachable.')
    } finally { setLoading(false) }
  }, [symbol, timeframe])

  useEffect(() => { void load(true); const id = window.setInterval(() => void load(false), 15000); return () => window.clearInterval(id) }, [load])
  const current = data?.symbol === symbol && data?.timeframe === timeframe ? data : allTf[timeframe] ?? data
  const isLive = current?.status === 'LIVE' && current.price != null
  const digits = symbol === 'BTCUSD' ? 2 : (current?.digits ?? 2)
  const trendRows = useMemo(() => (['4h', '1h', '15m', '5m'] as TF[]).map(tf => ({ tf, trend: allTf[tf]?.signal?.trend ?? '—', live: allTf[tf]?.status === 'LIVE' })), [allTf])
  const signalForUi = useMemo<Signal>(() => {
    if (!isLive || !current) return { ...emptySignal, reasons: [lastError || 'Live market data is unavailable.'] }
    const candidate = current.signal
    if (candidate.status !== 'BUY' && candidate.status !== 'SELL') return candidate
    const rank: Record<TF, number> = { '5m': 0, '15m': 1, '1h': 2, '4h': 3 }
    const expectedTrend = candidate.status === 'BUY' ? 'BULLISH' : 'BEARISH'
    const higher = (['5m', '15m', '1h', '4h'] as TF[]).filter(tf => rank[tf] > rank[timeframe])
    const missing = higher.filter(tf => allTf[tf]?.status !== 'LIVE' || allTf[tf]?.signal?.trend !== expectedTrend)
    if (missing.length) return { ...emptySignal, trend: candidate.trend, signal_time: candidate.signal_time, reasons: [`Setup rejected: higher timeframe confirmation is missing or opposed on ${missing.map(x => x.toUpperCase()).join(', ')}.`, ...candidate.reasons], invalidation: 'No active setup; wait until all higher timeframes align.' }
    return candidate
  }, [isLive, current, allTf, timeframe, lastError])
  const switchMarket = (s: 'XAUUSD' | 'BTCUSD') => { setSymbol(s); setData(null); setAllTf({}); setLastError('') }
  return <main className="shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">G</span><span>GoldSight <b>AI</b><small>REAL-TIME MARKET INTELLIGENCE</small></span></a><div className={`status ${isLive ? 'is-live' : 'is-offline'}`}><span className="dot" />{isLive ? 'LIVE DATA' : 'OFFLINE'} <span className="divider">|</span> <span>{loading ? 'Connecting…' : isLive ? 'Connected' : 'Feed unavailable'}</span></div></header>
    <nav className="market-tabs" aria-label="Markets"><button className={symbol === 'XAUUSD' ? 'active' : ''} onClick={() => switchMarket('XAUUSD')}>✦ GOLD <small>XAUUSD</small></button><button className={symbol === 'BTCUSD' ? 'active' : ''} onClick={() => switchMarket('BTCUSD')}>₿ BITCOIN <small>BTCUSD</small></button><button className="refresh" onClick={() => void load(true)}>↻ Refresh</button></nav>
    <section className="intro"><div><p className="eyebrow">MARKET OVERVIEW / {symbol}</p><h1>Trade the evidence.<br/><em>Not the impulse.</em></h1><p className="muted">Confirmed-candle analysis with transparent entry, risk and invalidation levels.</p></div><div className={`session ${isLive ? 'live-session' : ''}`}><span className="pulse" /> {isLive ? 'LIVE MARKET FEED' : 'OFFLINE'}<small>{current?.provider || 'Waiting for provider'}</small></div></section>
    <section className="metrics">
      <article className="metric"><span>LIVE PRICE · {symbol}</span><strong>{isLive ? fmt(current.price, digits) : '—'}</strong><small>{isLive && current?.bid != null && current.ask != null ? `Bid ${fmt(current.bid, digits)} · Ask ${fmt(current.ask, digits)}` : 'No verified quote available'}</small></article>
      <article className="metric"><span>MARKET TREND · {timeframe.toUpperCase()}</span><strong className={`trend ${current?.signal?.trend?.toLowerCase() || ''}`}>{isLive ? current?.signal?.trend || 'UNKNOWN' : 'UNKNOWN'}</strong><small>9/21 EMA + structure rules</small></article>
      <article className="metric"><span>SPREAD</span><strong>{isLive && current?.spread != null ? fmt(current.spread, digits) : '—'}</strong><small>{current?.provider_note || 'Provider-reported bid/ask spread'}</small></article>
      <article className="metric"><span>LAST PROVIDER UPDATE</span><strong className="time-value">{isLive ? dateFmt(updatedAt) : '—'}</strong><small>Refresh interval: 15 seconds</small></article>
    </section>
    <section className="panel"><div className="panel-head"><div><p className="eyebrow">PRICE ACTION</p><h2>{symbol === 'XAUUSD' ? 'Gold' : 'Bitcoin'} candlestick chart</h2></div><div className="timeframes">{(['5m', '15m', '1h', '4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div></div>
      <div className="chart-label"><span><b className="legend-dot" /> {symbol} · {timeframe.toUpperCase()}</span><span>{isLive ? `SOURCE: ${current?.provider}` : 'NO VERIFIED MARKET DATA'}</span></div>
      {isLive && current?.candles?.length ? <PriceChart data={current.candles} digits={digits} /> : <div className="chart-offline"><span className="offline-icon">⌁</span><b>Live candles unavailable</b><p>{lastError || 'Connect the market-data provider to display verified prices.'}</p><small>No sample candles are displayed in offline mode.</small></div>}
      <p className="chart-foot">{isLive ? `Last update: ${dateFmt(updatedAt)} · Source: ${current?.provider}` : 'OFFLINE · The chart stays empty until genuine market data is available.'}</p>
    </section>
    {!isLive && <div className="offline-notice"><b>OFFLINE — signals disabled</b><span>{lastError || 'No live feed.'} This app will not substitute invented prices or candles.</span></div>}
    <section className="bottom-grid"><SignalCard signal={signalForUi} digits={digits} symbol={symbol} timeframe={timeframe} />
      <section className="panel insight"><p className="eyebrow">MULTI-TIMEFRAME CONTEXT</p><h2>Trend alignment</h2><p className="muted">Each timeframe is fetched from the same live provider; only completed candles are used for signal calculations.</p>
        {trendRows.map(row => <div className="context-row" key={row.tf}><span>{row.tf.toUpperCase()}</span><b className={row.trend.toLowerCase()}>{row.live ? row.trend : 'OFFLINE'}</b></div>)}
        <div className="context-row"><span>Data provider</span><b>{isLive ? current?.provider : 'Unavailable'}</b></div><div className="context-row"><span>Signal method</span><b>Rule-based SMC baseline</b></div><div className="context-row"><span>Order execution</span><b>Disabled</b></div>
        <p className="score-note">This MVP detects structure breaks and liquidity sweeps; it is not a trained AI model and has not been proven profitable.</p>
      </section>
    </section>
    <section className="panel history-panel"><div className="panel-head"><div><p className="eyebrow">RECENT EVENTS</p><h2>Signal history</h2></div><span className="history-count">{history.length} recorded</span></div>
      {history.length ? <div className="history-list">{history.map(item => <div className="history-row" key={item.key}><span className={item.side.toLowerCase()}>{item.side}</span><b>{item.symbol}</b><span>{item.tf.toUpperCase()}</span><span>{item.entry == null ? '—' : fmt(item.entry, digits)}</span><time>{dateFmt(item.time)}</time></div>)}</div> : <div className="history-empty">No valid signals recorded in this session. NO SETUP is a valid outcome.</div>}
    </section>
    <footer><span>GoldSight AI · Live-data MVP</span><span>Decision support only. Signals are estimates, not financial advice. No trades are executed.</span></footer>
  </main>
}
