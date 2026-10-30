import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries, type IChartApi, type CandlestickData, type Time } from 'lightweight-charts'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai.onrender.com').replace(/\/$/, '')
type TF = '5m' | '15m' | '1h' | '4h'
type Candle = CandlestickData<Time> & { volume?: number }
type Signal = { status: string; side: string; entry: number | null; stop_loss: number | null; take_profits: number[]; rr: number[] | null; confidence: number | null; confidence_label?: string; reasons: string[]; invalidation: string; signal_time: string | null; trend: string; trade_type?: string; news_context?: {title?: string; url?: string; source?: string; published_at?: string; impact?: string; minutes_before_signal?: number; causality_confirmed?: boolean} | null; news_context_status?: string; news_context_note?: string }
type Market = { symbol: string; provider_symbol?: string; provider?: string; provider_note?: string; status: 'LIVE' | 'OFFLINE'; price: number | null; bid: number | null; ask: number | null; spread: number | null; digits?: number; updated_at: string | null; timeframe: TF; candles: Candle[]; signal: Signal }
type SpotReference = { symbol: string; provider: string; status: 'LIVE' | 'OFFLINE'; price: number | null; updated_at: string | null; age_seconds?: number; data_state?: string; tradable_quote: false; candles_available: false; note?: string; detail?: string }
const emptySignal: Signal = { status: 'NO SETUP', side: 'NO SETUP', entry: null, stop_loss: null, take_profits: [], rr: null, confidence: null, reasons: ['Waiting for live market data.'], invalidation: 'No active setup.', signal_time: null, trend: 'UNKNOWN' }
const fmt = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const dateFmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—'

type SpotPoint = { time: Time; value: number }
type FundamentalItem = { id: string; title: string; summary: string; url: string; source: string; published_at: string | null; assets: string[]; impact: string; interpretation: string }

function PriceChart({ data, digits, spotPoints = [], spotOnly = false }: { data: Candle[]; digits: number; spotPoints?: SpotPoint[]; spotOnly?: boolean }) {
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
    const series = spotOnly
      ? chart.addSeries(LineSeries, { color: '#27d6a0', lineWidth: 2, priceLineVisible: true, lastValueVisible: true, priceFormat: { type: 'price', precision: digits, minMove: 1 / (10 ** digits) } })
      : chart.addSeries(CandlestickSeries, { upColor: '#27d6a0', downColor: '#ff647c', borderVisible: false, wickUpColor: '#27d6a0', wickDownColor: '#ff647c', priceFormat: { type: 'price', precision: digits, minMove: 1 / (10 ** digits) } })
    chartRef.current = chart
    seriesRef.current = series
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [digits, spotOnly])
  useEffect(() => {
    if (!seriesRef.current) return
    if (spotOnly) {
      const valid = spotPoints.filter(d => Number.isFinite(Number(d.time)) && Number.isFinite(d.value))
      if (valid.length) { seriesRef.current.setData(valid); chartRef.current?.timeScale().fitContent() }
      return
    }
    const valid = data.filter(d => Number.isFinite(Number(d.time)) && [d.open, d.high, d.low, d.close].every(Number.isFinite))
    if (valid.length) { seriesRef.current.setData(valid); chartRef.current?.timeScale().fitContent() }
  }, [data, spotPoints, spotOnly])
  return <div className="chart" ref={host} aria-label={spotOnly ? 'Indicative live gold spot price chart' : 'Live candlestick chart'} />
}

function SignalCard({ signal, digits, symbol, timeframe }: { signal: Signal; digits: number; symbol: string; timeframe: TF }) {
  const isTrade = signal.status === 'BUY' || signal.status === 'SELL'
  return <section className="panel signal-panel">
    <div className="panel-head"><div><p className="eyebrow">LATEST CONFIRMED SETUP</p><h2>Signal analysis</h2><p className="signal-market">{symbol} · {timeframe.toUpperCase()}</p></div><div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',justifyContent:'flex-end'}}>{isTrade && <span className="signal-badge none">{signal.trade_type || 'TECHNICAL TRADE'}</span>}<span className={`signal-badge ${isTrade ? signal.status.toLowerCase() : 'none'}`}>{signal.status || 'NO SETUP'}</span></div></div>
    {isTrade ? <div className="signal-levels">
      <div><span>ENTRY</span><b>{fmt(signal.entry, digits)}</b></div><div><span>STOP LOSS</span><b className="red">{fmt(signal.stop_loss, digits)}</b></div>
      {signal.take_profits.map((tp, i) => <div key={i}><span>TP{i + 1} · 1:{signal.rr?.[i] ?? i + 1}</span><b className="green">{fmt(tp, digits)}</b></div>)}
      <div><span>RULE SCORE</span><b>{signal.confidence}%</b></div>
    </div> : <div className="no-setup"><b>No valid setup right now</b><p>GoldSight will not force a trade when the conditions are incomplete.</p></div>}
    {isTrade && signal.news_context && <div className="reasons"><h3>Linked news catalyst</h3><p className="muted"><a href={signal.news_context.url} target="_blank" rel="noreferrer" style={{color:'inherit'}}>{signal.news_context.title}</a></p><p className="score-note">{signal.news_context.source} · {dateFmt(signal.news_context.published_at || null)} · {signal.news_context.minutes_before_signal} min before signal. Timing is an association, not proof of causation.</p></div>}
    {isTrade && signal.news_context_note && <p className="score-note">{signal.news_context_note}</p>}
    <div className="reasons"><h3>Why this decision?</h3><ul>{(signal.reasons?.length ? signal.reasons : ['Insufficient confirmed evidence.']).map((r, i) => <li key={i}>{r}</li>)}</ul></div>
    <div className="signal-meta"><span>Signal candle: {dateFmt(signal.signal_time)}</span><span>Trend: <b>{signal.trend || 'UNKNOWN'}</b></span></div>
    <p className="invalidation"><b>Invalidation:</b> {signal.invalidation}</p>
    <p className="score-note">The rule score is an internal alignment estimate, not a probability of winning or a guarantee.</p>
  </section>
}


function PipCalculator({ symbol }: { symbol: 'XAUUSD' | 'BTCUSD' }) {
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY')
  const [entry, setEntry] = useState('4000')
  const [stop, setStop] = useState('3990')
  const [target, setTarget] = useState('4020')
  const [pipSize, setPipSize] = useState('0.01')
  useEffect(() => {
    if (symbol === 'XAUUSD') { setEntry('4000'); setStop('3990'); setTarget('4020'); setPipSize('0.01') }
    else { setEntry('100000'); setStop('99000'); setTarget('102000'); setPipSize('1') }
  }, [symbol])
  const result = useMemo(() => {
    const e = Number(entry), sl = Number(stop), tp = Number(target), pip = Number(pipSize)
    if (![e, sl, tp, pip].every(Number.isFinite) || e <= 0 || sl <= 0 || tp <= 0 || pip <= 0) return { error: 'Enter positive prices and a valid pip size.' }
    const risk = direction === 'BUY' ? e - sl : sl - e
    const reward = direction === 'BUY' ? tp - e : e - tp
    if (risk <= 0 || reward <= 0) return { error: direction === 'BUY' ? 'For a BUY, stop-loss must be below entry and take-profit above entry.' : 'For a SELL, stop-loss must be above entry and take-profit below entry.' }
    return { stopPips: risk / pip, targetPips: reward / pip, rr: reward / risk, error: '' }
  }, [direction, entry, stop, target, pipSize])
  return <section className="panel pip-panel">
    <div className="panel-head"><div><p className="eyebrow">TRADE PLANNING TOOL</p><h2>Pip Calculator</h2><p className="muted">{symbol} · Price-distance calculator</p></div><span className="history-count">MANUAL INPUT</span></div>
    <div className="pip-direction"><button className={direction === 'BUY' ? 'selected buy' : ''} onClick={() => setDirection('BUY')}>BUY</button><button className={direction === 'SELL' ? 'selected sell' : ''} onClick={() => setDirection('SELL')}>SELL</button></div>
    <div className="pip-fields">
      <label>Entry price<input inputMode="decimal" value={entry} onChange={e => setEntry(e.target.value)} /></label>
      <label>Stop-loss price<input inputMode="decimal" value={stop} onChange={e => setStop(e.target.value)} /></label>
      <label>Take-profit price<input inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} /></label>
      <label>Pip size<input inputMode="decimal" value={pipSize} onChange={e => setPipSize(e.target.value)} /><small>Confirm your broker's pip convention.</small></label>
    </div>
    {result.error ? <div className="pip-error">{result.error}</div> : <div className="pip-results">
      <article><span>STOP-LOSS DISTANCE</span><strong>{fmt(result.stopPips, 1)} pips</strong></article>
      <article><span>TAKE-PROFIT DISTANCE</span><strong>{fmt(result.targetPips, 1)} pips</strong></article>
      <article><span>RISK : REWARD</span><strong>1 : {fmt(result.rr, 2)}</strong></article>
    </div>}
    <p className="score-note">Price-distance calculation only. It does not calculate cash profit, lot size, commission or swap. Pip definitions vary by broker and instrument; verify pip size in your trading platform.</p>
  </section>
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'forecast' | 'alerts' | 'history' | 'demo' | 'pips' | 'settings'>('overview')
  const [symbol, setSymbol] = useState<'XAUUSD' | 'BTCUSD'>('XAUUSD')
  const [timeframe, setTimeframe] = useState<TF>('15m')
  const [data, setData] = useState<Market | null>(null)
  const [allTf, setAllTf] = useState<Partial<Record<TF, Market>>>({})
  const [loading, setLoading] = useState(true)
  const [lastError, setLastError] = useState('')
  const [history, setHistory] = useState<Array<{ key: string; symbol: string; tf: TF; side: string; time: string; entry: number | null; trade_type?: string }>>([])
  const [historyStatus, setHistoryStatus] = useState('Connecting to server history…')
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushStatus, setPushStatus] = useState('Push notifications not enabled')
  const [fundamentalItems, setFundamentalItems] = useState<FundamentalItem[]>([])
  const [fundamentalStatus, setFundamentalStatus] = useState('Loading verified source feeds…')
  const [fundamentalUpdated, setFundamentalUpdated] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [spotReference, setSpotReference] = useState<SpotReference | null>(null)
  const [spotPoints, setSpotPoints] = useState<SpotPoint[]>([])
  const [spotError, setSpotError] = useState('')
  const [demoAccount, setDemoAccount] = useState<any>(null)
  const [demoStatus, setDemoStatus] = useState('Loading demo account…')
  const [demoBusy, setDemoBusy] = useState(false)


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
      setLastError(next[timeframe].status === 'LIVE' ? '' : (next[timeframe].signal?.reasons?.[0] || 'Live feed unavailable.'))
    } catch (e) {
      setData({ symbol, status: 'OFFLINE', price: null, bid: null, ask: null, spread: null, updated_at: null, candles: [], timeframe, signal: { ...emptySignal, reasons: [e instanceof Error ? e.message : 'API is unreachable.'] } })
      setLastError(e instanceof Error ? e.message : 'API is unreachable.')
    } finally { setLoading(false) }
  }, [symbol, timeframe])

  useEffect(() => { void load(true); const id = window.setInterval(() => void load(false), 15000); return () => window.clearInterval(id) }, [load])

  useEffect(() => {
    let cancelled = false
    const loadHistory = async () => {
      try {
        const response = await fetch(`${API}/api/v1/setups/history?limit=50`, { cache: 'no-store' })
        const json = await response.json()
        if (!response.ok) throw new Error(json.detail || `History API error ${response.status}`)
        const items = Array.isArray(json.items) ? json.items : []
        if (!cancelled) {
          setHistory(items.map((item: any) => ({
            key: String(item.id ?? `${item.symbol}:${item.timeframe}:${item.side}:${item.signal_time}`),
            symbol: item.symbol,
            tf: item.timeframe as TF,
            side: item.side,
            time: item.signal_time,
            entry: typeof item.entry === 'number' ? item.entry : null,
            trade_type: typeof item.trade_type === 'string' ? item.trade_type : 'TECHNICAL TRADE',
          })))
          setHistoryStatus('Saved on the server · survives browser closure')
        }
      } catch (e) {
        if (!cancelled) {
          setHistoryStatus(e instanceof Error ? e.message : 'Server history is unavailable.')
        }
      }
    }
    void loadHistory()
    const id = window.setInterval(() => void loadHistory(), 60000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadFundamentals = async () => {
      try {
        const response = await fetch(`${API}/api/v1/fundamentals/news?limit=30`, { cache: 'no-store' })
        const json = await response.json() as { status: string; updated_at: string; items: FundamentalItem[]; feeds: Array<{source: string; status: string; count: number; error?: string | null}>; note?: string }
        if (!response.ok) throw new Error(`Fundamental feed error ${response.status}`)
        if (!cancelled) {
          setFundamentalItems(Array.isArray(json.items) ? json.items : [])
          setFundamentalUpdated(json.updated_at || null)
          const liveFeeds = (json.feeds || []).filter(feed => feed.status === 'LIVE').length
          setFundamentalStatus(json.items?.length ? `${json.items.length} headlines · ${liveFeeds}/${json.feeds?.length || 0} sources live` : 'No headlines returned; sources may be temporarily unavailable.')
        }
      } catch (error) {
        if (!cancelled) setFundamentalStatus(error instanceof Error ? error.message : 'Fundamental news is unavailable.')
      }
    }
    void loadFundamentals()
    const id = window.setInterval(() => void loadFundamentals(), 300000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadSpot = async () => {
      try {
        const response = await fetch(`${API}/api/v1/spot/XAUUSD`, { cache: 'no-store' })
        const json = await response.json() as SpotReference
        if (!response.ok || json.status !== 'LIVE' || json.price == null || !Number.isFinite(json.price)) {
          throw new Error(json.detail || 'XAUS spot reference is unavailable.')
        }
        if (!cancelled) {
          setSpotReference(json)
          setSpotError('')
          if (json.updated_at) {
            const time = Math.floor(new Date(json.updated_at).getTime() / 1000) as Time
            setSpotPoints(old => {
              if (old.some(point => Number(point.time) === Number(time))) return old
              return [...old, { time, value: json.price! }].slice(-240)
            })
          }
        }
      } catch (e) {
        if (!cancelled) setSpotError(e instanceof Error ? e.message : 'XAUS spot reference is unavailable.')
      }
    }
    void loadSpot()
    const id = window.setInterval(() => void loadSpot(), 60000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadDemo = async () => {
      try {
        const response = await fetch(`${API}/api/v1/demo/account`, { cache: 'no-store' })
        const json = await response.json()
        if (!response.ok) throw new Error(json.detail || 'Demo account unavailable.')
        if (!cancelled) { setDemoAccount(json); setDemoStatus('Persistent demo account · server-side trade management') }
      } catch (error) {
        if (!cancelled) setDemoStatus(error instanceof Error ? error.message : 'Demo account unavailable.')
      }
    }
    void loadDemo()
    const id = window.setInterval(() => void loadDemo(), 15000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  const resetDemo = async () => {
    if (!window.confirm('Reset the demo account to ₦100,000 and close all open demo trades?')) return
    setDemoBusy(true)
    try {
      const response = await fetch(`${API}/api/v1/demo/reset`, { method: 'POST' })
      const json = await response.json()
      if (!response.ok) throw new Error(json.detail || 'Could not reset demo account.')
      setDemoAccount(json); setDemoStatus('Demo account reset to ₦100,000.')
    } catch (error) {
      setDemoStatus(error instanceof Error ? error.message : 'Demo reset failed.')
    } finally { setDemoBusy(false) }
  }

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
  const enablePushNotifications = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setPushStatus('This browser does not support web push. Install/open GoldSight in Chrome on Android.')
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setPushStatus('Notification permission was not granted.')
        return
      }
      const keyResponse = await fetch(`${API}/api/v1/push/public-key`, { cache: 'no-store' })
      const keyJson = await keyResponse.json()
      if (!keyResponse.ok || !keyJson.public_key) throw new Error('Push service is not configured on the server yet.')
      const decodeKey = (value: string) => {
        const padding = '='.repeat((4 - value.length % 4) % 4)
        const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
        return Uint8Array.from(raw, char => char.charCodeAt(0))
      }
      const registration = await navigator.serviceWorker.register('/sw.js')
      const existingSubscription = await registration.pushManager.getSubscription()
      const subscription = existingSubscription || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(keyJson.public_key)
      })
      const saveResponse = await fetch(`${API}/api/v1/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      })
      if (!saveResponse.ok) {
        const error = await saveResponse.json().catch(() => ({}))
        throw new Error(error.detail || 'Could not save this device subscription. Check database configuration.')
      }
      setPushEnabled(true)
      setPushStatus('This Android device is subscribed to setup alerts.')
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : 'Could not enable push notifications.')
    }
  }

  const switchMarket = (s: 'XAUUSD' | 'BTCUSD') => { setSymbol(s); setData(null); setAllTf({}); setLastError('') }
  return <main className="shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">G</span><span>GoldSight <b>AI</b><small>REAL-TIME MARKET INTELLIGENCE</small></span></a><div className={`status ${isLive ? 'is-live' : 'is-offline'}`}><span className="dot" />{isLive ? 'LIVE DATA' : 'OFFLINE'} <span className="divider">|</span> <span>{loading ? 'Connecting…' : isLive ? 'Connected' : 'Feed unavailable'}</span></div></header>
    <section className="panel history-panel" style={{display: activeTab === 'alerts' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">ALERT DELIVERY</p><h2>Setup notifications</h2></div><span className="history-count">{pushEnabled ? 'PUSH ON' : 'PUSH OFF'}</span></div>
      <p className="muted">{pushStatus}. New confirmed BUY/SELL setups only; duplicate refreshes and NO SETUP states do not alert.</p>
      <button className="refresh" onClick={() => void enablePushNotifications()} disabled={pushEnabled}>{pushEnabled ? 'Android notifications enabled' : 'Enable Android push notifications'}</button>

    </section>
    <nav className="market-tabs" aria-label="Markets" style={{display: activeTab === 'overview' || activeTab === 'forecast' ? 'flex' : 'none'}}><button className={symbol === 'XAUUSD' ? 'active' : ''} onClick={() => switchMarket('XAUUSD')}>✦ GOLD <small>XAUUSD</small></button><button className={symbol === 'BTCUSD' ? 'active' : ''} onClick={() => switchMarket('BTCUSD')}>₿ BITCOIN <small>BTCUSD</small></button><button className="refresh" onClick={() => void load(true)}>↻ Refresh</button></nav>
    <section className="intro" style={{display: activeTab === 'overview' ? 'flex' : 'none'}}><div><p className="eyebrow">MARKET OVERVIEW / {symbol}</p><h1>Trade the evidence.<br/><em>Not the impulse.</em></h1><p className="muted">Confirmed-candle analysis with transparent entry, risk and invalidation levels.</p></div><div className={`session ${isLive ? 'live-session' : ''}`}><span className="pulse" /> {isLive ? 'LIVE MARKET FEED' : 'OFFLINE'}<small>{current?.provider || 'Waiting for provider'}</small></div></section>
    <section className="metrics" style={{display: activeTab === 'overview' ? 'grid' : 'none'}}>
      <article className="metric"><span>LIVE PRICE · {symbol}</span><strong>{isLive ? fmt(current.price, digits) : '—'}</strong><small>{isLive && current?.bid != null && current.ask != null ? `Bid ${fmt(current.bid, digits)} · Ask ${fmt(current.ask, digits)}` : 'No verified quote available'}</small></article>
      <article className="metric"><span>MARKET TREND · {timeframe.toUpperCase()}</span><strong className={`trend ${current?.signal?.trend?.toLowerCase() || ''}`}>{isLive ? current?.signal?.trend || 'UNKNOWN' : 'UNKNOWN'}</strong><small>9/21 EMA + structure rules</small></article>
      <article className="metric"><span>SPREAD</span><strong>{isLive && current?.spread != null ? fmt(current.spread, digits) : '—'}</strong><small>{current?.provider_note || 'Provider-reported bid/ask spread'}</small></article>
      <article className="metric"><span>LAST PROVIDER UPDATE</span><strong className="time-value">{isLive ? dateFmt(updatedAt) : '—'}</strong><small>Refresh interval: 15 seconds</small></article>
    </section>
    {symbol === 'XAUUSD' && <section className="metrics spot-reference" style={{display: activeTab === 'overview' ? 'grid' : 'none'}}><article className="metric"><span>XAUS · INDICATIVE GOLD SPOT</span><strong>{spotReference?.status === 'LIVE' && spotReference.price != null ? `${fmt(spotReference.price, 2)}` : '—'}</strong><small>{spotReference?.status === 'LIVE' ? `Source updated ${dateFmt(spotReference.updated_at)} · ${spotReference.age_seconds ?? '—'}s old` : `Spot reference unavailable${spotError ? `: ${spotError}` : ''}`}</small><small>Spot mid-price only — not a broker quote. No bid/ask, spread or signal candles.</small></article></section>}
    <section className="panel" style={{display: activeTab === 'overview' ? 'block' : 'none'}}><div className="panel-head"><div><p className="eyebrow">PRICE ACTION</p><h2>{symbol === 'XAUUSD' && !isLive ? 'Gold indicative spot price trace' : `${symbol === 'XAUUSD' ? 'Gold' : 'Bitcoin'} candlestick chart`}</h2></div>{!(symbol === 'XAUUSD' && !isLive && spotReference?.price != null) && <div className="timeframes">{(['5m', '15m', '1h', '4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div>}</div>
      <div className="chart-label"><span><b className="legend-dot" /> {symbol} · {symbol === 'XAUUSD' && !isLive && spotReference?.price != null ? 'INDICATIVE SPOT' : timeframe.toUpperCase()}</span><span>{isLive ? `SOURCE: ${current?.provider}` : symbol === 'XAUUSD' && spotReference?.price != null ? 'SOURCE: XAUS SPOT · ~60s UPDATES' : 'NO VERIFIED MARKET DATA'}</span></div>
      {isLive && current?.candles?.length ? <PriceChart data={current.candles} digits={digits} /> : symbol === 'XAUUSD' && spotReference?.price != null ? <PriceChart data={[]} digits={2} spotPoints={spotPoints} spotOnly /> : <div className="chart-offline"><span className="offline-icon">⌁</span><b>Live candles unavailable</b><p>{lastError || 'Connect the market-data provider to display verified prices.'}</p><small>No sample candles are displayed in offline mode.</small></div>}
      <p className="chart-foot">{isLive ? `Last update: ${dateFmt(updatedAt)} · Source: ${current?.provider}` : symbol === 'XAUUSD' && spotReference?.price != null ? `Indicative spot trace · ${spotPoints.length} real provider samples collected in this browser session. Updates approximately every 60 seconds; not a broker candle chart or trade signal source.` : 'OFFLINE · The chart stays empty until genuine market data is available.'}</p>
    </section>
    {!isLive && activeTab === 'overview' && <div className="offline-notice"><b>OFFLINE — signals disabled</b><span>{lastError || 'No live feed.'} This app will not substitute invented prices or candles.</span></div>}
    <section className="bottom-grid" style={{display: activeTab === 'forecast' ? 'grid' : 'none'}}><SignalCard signal={signalForUi} digits={digits} symbol={symbol} timeframe={timeframe} />
      <section className="panel insight"><p className="eyebrow">MULTI-TIMEFRAME CONTEXT</p><h2>Trend alignment</h2><p className="muted">Each timeframe is fetched from the same live provider; only completed candles are used for signal calculations.</p>
        {trendRows.map(row => <div className="context-row" key={row.tf}><span>{row.tf.toUpperCase()}</span><b className={row.trend.toLowerCase()}>{row.live ? row.trend : 'OFFLINE'}</b></div>)}
        <div className="context-row"><span>Data provider</span><b>{isLive ? current?.provider : 'Unavailable'}</b></div><div className="context-row"><span>Signal method</span><b>Rule-based SMC baseline</b></div><div className="context-row"><span>Order execution</span><b>Disabled</b></div>
        <p className="score-note">This MVP detects structure breaks and liquidity sweeps; it is not a trained AI model and has not been proven profitable.</p>
      </section>
    </section>
    <section className="panel history-panel" style={{display: activeTab === 'alerts' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">FUNDAMENTAL INTELLIGENCE</p><h2>Core market news</h2></div><span className="history-count">{fundamentalItems.length} headlines</span></div>
      <p className="muted">Federal Reserve, US labour data and crypto-industry headlines. Relevance and impact are triage labels, not predictions. {fundamentalUpdated ? `Feed checked ${dateFmt(fundamentalUpdated)}.` : ''}</p>
      <p className="chart-foot">{fundamentalStatus}</p>
      {fundamentalItems.length ? <div className="history-list">{fundamentalItems.filter(item => !item.assets.length || item.assets.includes(symbol)).slice(0, 12).map(item => <article className="context-row" key={item.id} style={{display:'block',padding:'12px 0'}}>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:6}}><span className="history-count">{item.impact} IMPACT</span><span>{item.source}</span><span>{item.assets.join(' · ') || 'MACRO'}</span><time>{dateFmt(item.published_at)}</time></div>
        <a href={item.url} target="_blank" rel="noreferrer" style={{fontWeight:700,color:'inherit',textDecoration:'none'}}>{item.title}</a>
        {item.summary && <p className="muted">{item.summary}</p>}
        <small className="score-note">{item.interpretation}</small>
      </article>)}</div> : <div className="history-empty">No live headlines available. {fundamentalStatus}</div>}
    </section>
    <section className="panel history-panel" style={{display: activeTab === 'history' ? 'block' : 'none'}}><div className="panel-head"><div><p className="eyebrow">RECENT EVENTS</p><h2>Signal history</h2></div><span className="history-count">{history.length} saved</span></div>
      {history.length ? <div className="history-list">{history.map(item => <div className="history-row" key={item.key}><span className={item.side.toLowerCase()}>{item.side}</span><b>{item.symbol}</b><span>{item.tf.toUpperCase()}</span><span>{item.entry == null ? '—' : fmt(item.entry, digits)}</span><span className="history-count">{item.trade_type || 'TECHNICAL TRADE'}</span><time>{dateFmt(item.time)}</time></div>)}</div> : <div className="history-empty">No saved setups yet. {historyStatus}</div>}
      <p className="chart-foot">{historyStatus}</p>
    </section>

    <section className="panel demo-panel" style={{display: activeTab === 'demo' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">SIMULATED ACCOUNT · NO BROKER ORDERS</p><h2>Demo trading</h2></div><span className="signal-badge buy">AUTO {demoAccount?.auto_trade ? 'ON' : 'OFF'}</span></div>
      <p className="muted">GoldSight automatically takes eligible confirmed setups when a slot is free. Maximum two open trades across Gold and Bitcoin. Each new position risks 5% of the current demo balance.</p>
      <div className="demo-balance"><span>AVAILABLE BALANCE</span><strong>₦{fmt(demoAccount?.balance ?? 100000, 2)}</strong><small>Starting balance ₦100,000 · Realized P/L: ₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</small></div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>OPEN POSITIONS</span><strong>{demoAccount?.open_count ?? 0} / 2</strong></article>
        <article className="metric"><span>RISK PER TRADE</span><strong>{demoAccount?.risk_per_trade_pct ?? 1}%</strong><small>Of current balance</small></article>
      </div>
      <div className="context-row"><span>Automation</span><b>{demoAccount?.auto_trade ? 'Enabled' : 'Disabled'}</b></div>
      <div className="context-row"><span>Exit rule</span><b>Full close at TP1 or SL</b></div>
      <p className="score-note">{demoAccount?.sizing_note || demoStatus}</p>
      <div className="panel-head demo-trades-head"><h2>Demo positions & history</h2><button className="refresh" onClick={() => void resetDemo()} disabled={demoBusy}>{demoBusy ? 'Resetting…' : 'Reset account'}</button></div>
      {demoAccount?.trades?.length ? <div className="history-list">{demoAccount.trades.map((trade:any) => <div className="history-row demo-row" key={trade.id}><span className={trade.side.toLowerCase()}>{trade.side}</span><b>{trade.symbol}</b><span>{trade.timeframe.toUpperCase()}</span><span>{fmt(trade.entry, trade.symbol === 'BTCUSD' ? 2 : 3)}</span><span className={trade.status === 'OPEN' ? 'history-count' : (trade.pnl >= 0 ? 'buy' : 'sell')}>{trade.status === 'OPEN' ? 'OPEN' : `${trade.close_reason} · ₦${fmt(trade.pnl,2)}`}</span><time>{dateFmt(trade.opened_at)}</time></div>)}</div> : <div className="history-empty">No demo trades yet. GoldSight will wait for a fresh, fully aligned setup.</div>}
      <p className="chart-foot">{demoStatus}. If the backend sleeps, automatic monitoring pauses too.</p>
    </section>
    <div style={{display: activeTab === 'pips' ? 'block' : 'none'}}><PipCalculator symbol={symbol} /></div>
    <section className="panel settings-panel" style={{display: activeTab === 'settings' ? 'block' : 'none'}}>
      <p className="eyebrow">PREFERENCES</p><h2>Settings</h2>
      <div className="settings-group"><span>Default market</span><div className="settings-actions"><button className={symbol === 'XAUUSD' ? 'selected' : ''} onClick={() => switchMarket('XAUUSD')}>Gold · XAUUSD</button><button className={symbol === 'BTCUSD' ? 'selected' : ''} onClick={() => switchMarket('BTCUSD')}>Bitcoin · BTCUSD</button></div></div>
      <div className="settings-group"><span>Analysis timeframe</span><div className="settings-actions">{(['5m','15m','1h','4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div></div>
      <div className="settings-group"><span>Push notifications</span><p className="muted">{pushStatus}</p><button className="refresh" onClick={() => void enablePushNotifications()} disabled={pushEnabled}>{pushEnabled ? 'Notifications enabled' : 'Enable Android notifications'}</button></div>
      <div className="settings-group"><span>Data refresh</span><p className="muted">Market data refreshes every 15 seconds. News refreshes every 5 minutes. Live feed status is shown in the header.</p><button className="refresh" onClick={() => void load(true)}>Refresh market data now</button></div>
      <p className="score-note">GoldSight is decision-support software. Rule-alignment scores are not win probabilities. Signals are estimates, not financial advice. No orders are executed.</p>
    </section>
    <nav className="app-bottom-nav" aria-label="Main navigation">
      {([{id:'overview',label:'Overview',icon:'◫'},{id:'forecast',label:'Forecast',icon:'⌁'},{id:'alerts',label:'Alerts',icon:'♧'},{id:'history',label:'Forecast history',icon:'◷'},{id:'demo',label:'Demo trading',icon:'▣'},{id:'pips',label:'Pip calculator',icon:'∑'},{id:'settings',label:'Settings',icon:'⚙'}] as const).map(tab => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}><span>{tab.icon}</span><small>{tab.label}</small></button>)}
    </nav>
    <footer><span>GoldSight AI · Live-data MVP</span><span>Decision support only. Signals are estimates, not financial advice. No trades are executed.</span></footer>
  </main>
}
