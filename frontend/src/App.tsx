import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries, type IChartApi, type CandlestickData, type Time } from 'lightweight-charts'
import CurrencyConverter from './CurrencyConverter'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
type TF = '5m' | '15m' | '1h' | '4h'
type Candle = CandlestickData<Time> & { volume?: number }
type Signal = { status: string; side: string; entry: number | null; stop_loss: number | null; take_profits: number[]; rr: number[] | null; confidence: number | null; confidence_label?: string; reasons: string[]; invalidation: string; signal_time: string | null; trend: string; trade_type?: string; news_context?: {title?: string; url?: string; source?: string; published_at?: string; impact?: string; minutes_before_signal?: number; causality_confirmed?: boolean} | null; news_context_status?: string; news_context_note?: string }
type Market = { symbol: string; provider_symbol?: string; provider?: string; provider_note?: string; status: 'LIVE' | 'OFFLINE'; price: number | null; bid: number | null; ask: number | null; spread: number | null; digits?: number; updated_at: string | null; timeframe: TF; candles: Candle[]; signal: Signal }
type SpotReference = { symbol: string; provider: string; status: 'LIVE' | 'OFFLINE'; price: number | null; updated_at: string | null; age_seconds?: number; data_state?: string; tradable_quote: false; candles_available: false; note?: string; detail?: string }
const emptySignal: Signal = { status: 'NO SETUP', side: 'NO SETUP', entry: null, stop_loss: null, take_profits: [], rr: null, confidence: null, reasons: ['Waiting for live market data.'], invalidation: 'No active setup.', signal_time: null, trend: 'UNKNOWN' }
const fmt = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const dateFmt = (s: string | null) => s && !Number.isNaN(new Date(s).getTime()) ? new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(s)) + ' WAT' : '—'

type SpotPoint = { time: Time; value: number }
type FundamentalItem = { id: string; title: string; summary: string; url: string; source: string; published_at: string | null; assets: string[]; impact: string; interpretation: string; country?: string; income_relevance?: string }

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
    </div> : <div className="no-setup"><b>No valid setup right now</b><p>Waiting for confirmation.</p></div>}
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
    <p className="score-note">Price distance only · Check your broker pip size.</p>
  </section>
}


function PositionSizer({ symbol }: { symbol: 'XAUUSD' | 'BTCUSD' }) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [balance, setBalance] = useState('100000')
  const [currency, setCurrency] = useState<'NGN' | 'USD'>('NGN')
  const [riskPct, setRiskPct] = useState('1')
  const [leverage, setLeverage] = useState('200')
  const [entry, setEntry] = useState('4200')
  const [stop, setStop] = useState('4195')
  const [contractSize, setContractSize] = useState('100')
  const [conversion, setConversion] = useState('')
  const [volumeStep, setVolumeStep] = useState('0.01')
  const [minVolume, setMinVolume] = useState('0.01')
  const [maxVolume, setMaxVolume] = useState('1000')
  const [marginPerLot, setMarginPerLot] = useState('398.52')
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (symbol === 'XAUUSD') { setEntry('4200'); setStop('4195'); setContractSize('100'); setVolumeStep('0.01'); setMinVolume('0.01'); setMarginPerLot('398.52'); setLeverage('200'); setMaxVolume('1000') }
    else { setEntry('100000'); setStop('99000'); setContractSize('1'); setMarginPerLot('234.54'); setLeverage('1'); setMaxVolume('1000') }
    setResult(null)
  }, [symbol])

  const calculate = async () => {
    setBusy(true); setError(''); setResult(null)
    try {
      const rate = currency === 'USD' ? 1 : Number(conversion)
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('Enter the current broker USD-to-NGN conversion rate.')
      const response = await fetch(API + '/api/v1/risk/position-size', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol, side, balance: Number(balance), risk_pct: Number(riskPct),
          entry: Number(entry), stop_loss: Number(stop), leverage: Number(leverage),
          contract_size: Number(contractSize), quote_to_account_rate: rate,
          volume_step: Number(volumeStep), min_volume: Number(minVolume), max_volume: Number(maxVolume),
          margin_per_lot_quote: marginPerLot ? Number(marginPerLot) : null,
        }),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.detail || 'Position sizing request failed.')
      setResult(json)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to calculate position size.') }
    finally { setBusy(false) }
  }

  const money = (value: number) => (currency === 'NGN' ? '₦' : '$') + Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
  return <section className="panel pip-panel">
    <div className="panel-head"><div><p className="eyebrow">RISK MANAGEMENT</p><h2>Position Size Calculator</h2><p className="muted">{symbol} · Exness broker profile</p></div><span className="history-count">BROKER SPECS</span></div>
    {symbol === 'XAUUSD' && <div className="spec-chips"><span>NGN</span><span>₦100K demo</span><span>1:200</span><span>1% risk</span><details><summary>Broker specs</summary><p>Exness XAUUSD · Contract 100 · 2 digits · Margin XAU · Profit USD · Min lot 0.01 · Step 0.01 · Max 1,000.</p></details></div>}
    <div className="pip-direction"><button className={side === 'BUY' ? 'selected buy' : ''} onClick={() => setSide('BUY')}>BUY</button><button className={side === 'SELL' ? 'selected sell' : ''} onClick={() => setSide('SELL')}>SELL</button></div>
    <div className="pip-fields">
      <label>Account balance<input inputMode="decimal" value={balance} onChange={e => setBalance(e.target.value)} /></label>
      <label>Account currency<select value={currency} onChange={e => { setCurrency(e.target.value as 'NGN' | 'USD'); setResult(null) }}><option value="NGN">NGN · Naira</option><option value="USD">USD · US dollar</option></select></label>
      <label>Risk per trade (%)<input inputMode="decimal" value={riskPct} onChange={e => setRiskPct(e.target.value)} /><small>Demo default: 1%. Maximum allowed: 5%.</small></label>
      <label>Leverage<input inputMode="numeric" value={leverage} onChange={e => setLeverage(e.target.value)} /></label>
      <label>Entry price<input inputMode="decimal" value={entry} onChange={e => setEntry(e.target.value)} /></label>
      <label>Stop-loss price<input inputMode="decimal" value={stop} onChange={e => setStop(e.target.value)} /></label>
      <label>Contract size<input inputMode="decimal" value={contractSize} onChange={e => setContractSize(e.target.value)} /></label>
      {currency === 'NGN' && <label>Broker USD/NGN conversion rate<input inputMode="decimal" placeholder="Enter current broker rate" value={conversion} onChange={e => setConversion(e.target.value)} /><small>Required for Naira accounts. Enter the broker's current conversion rate.</small></label>}
      <label>Minimum lot<input inputMode="decimal" value={minVolume} onChange={e => setMinVolume(e.target.value)} /></label>
      <label>Volume step<input inputMode="decimal" value={volumeStep} onChange={e => setVolumeStep(e.target.value)} /></label>
      <label>Maximum lot<input inputMode="decimal" value={maxVolume} onChange={e => setMaxVolume(e.target.value)} /></label>
      <label>Margin per 1.00 lot (USD)<input inputMode="decimal" value={marginPerLot} onChange={e => setMarginPerLot(e.target.value)} /><small>MT5 screenshot reference: {symbol === 'XAUUSD' ? '$398.52 buy / $398.48 sell' : '$234.54 buy / $234.36 sell'}. Indicative only; margin changes.</small></label>
    </div>
    <button className="refresh" onClick={() => void calculate()} disabled={busy}>{busy ? 'Calculating…' : 'Calculate safe lot size'}</button>
    {error && <div className="pip-error">{error}</div>}
    {result && <div className="pip-results">
      {result.status === 'OK' ? <>
        <article><span>RECOMMENDED LOT</span><strong>{result.recommended_lot}</strong></article>
        <article><span>ESTIMATED LOSS AT SL</span><strong>{money(result.estimated_loss)}</strong></article>
        <article><span>RISK BUDGET</span><strong>{money(result.risk_budget)}</strong></article>
        <article><span>ESTIMATED MARGIN</span><strong>{money(result.estimated_margin)}</strong></article>
        <article><span>STOP DISTANCE</span><strong>{fmt(result.stop_distance, 2)}</strong></article>
        <article><span>UNUSED RISK</span><strong>{money(result.unused_risk)}</strong></article>
      </> : <article><span>NO SAFE POSITION SIZE</span><strong>DO NOT FORCE THIS TRADE</strong><small>{result.note} Minimum-lot risk: {money(result.estimated_loss_at_minimum_lot)}.</small></article>}
    </div>}
    <p className="score-note">Estimate only · Confirm broker values before trading.</p>
  </section>
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'forecast' | 'alerts' | 'stocks' | 'demo' | 'tools' | 'settings'>('forecast')
  const [symbol, setSymbol] = useState<'XAUUSD' | 'BTCUSD'>('XAUUSD')
  const [timeframe, setTimeframe] = useState<TF>('15m')
  const [data, setData] = useState<Market | null>(null)
  const [allTf, setAllTf] = useState<Partial<Record<TF, Market>>>({})
  const [loading, setLoading] = useState(true)
  const [lastError, setLastError] = useState('')
  const [history, setHistory] = useState<Array<{ key: string; symbol: string; tf: TF; side: string; time: string; candleTime?: string | null; entry: number | null; stop_loss: number | null; take_profits: number[]; rr: number[] | null; confidence: number | null; trend?: string; reasons: string[]; invalidation?: string; provider?: string; trade_type?: string }>>([])
  const [selectedHistoryKey, setSelectedHistoryKey] = useState<string | null>(null)
  const [historyStatus, setHistoryStatus] = useState('Connecting to server history…')
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushStatus, setPushStatus] = useState('Push notifications not enabled')
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [fundamentalItems, setFundamentalItems] = useState<FundamentalItem[]>([])
  const [fundamentalStatus, setFundamentalStatus] = useState('Loading verified source feeds…')
  const [newsCountry, setNewsCountry] = useState('ALL')
  const [newsFocus, setNewsFocus] = useState('ALL')
  const [ngxData, setNgxData] = useState<any>(null)
  const [stockCountry, setStockCountry] = useState('NG')
  const [ngxStatus, setNgxStatus] = useState('Loading NGX market data…')
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
            // detected_at is when the recorder actually saved/dropped the alert.
            // signal_time remains the candle timestamp and is shown separately.
            time: item.detected_at || item.signal_time,
            candleTime: item.signal_time || null,
            entry: typeof item.entry === 'number' ? item.entry : null,
            stop_loss: typeof item.stop_loss === 'number' ? item.stop_loss : null,
            take_profits: Array.isArray(item.take_profits) ? item.take_profits.map(Number).filter(Number.isFinite) : [],
            rr: Array.isArray(item.rr) ? item.rr.map(Number).filter(Number.isFinite) : null,
            confidence: typeof item.confidence === 'number' ? item.confidence : null,
            trend: item.trend,
            reasons: Array.isArray(item.reasons) ? item.reasons : [],
            invalidation: item.invalidation,
            provider: item.provider,
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
    const loadNgx = async () => {
      try {
        const response = await fetch(`${API}/api/v1/stocks/intelligence?country=${stockCountry}`, { cache: 'no-store' })
        const json = await response.json()
        if (!response.ok) throw new Error(json.detail || `NGX API error ${response.status}`)
        if (!cancelled) { setNgxData(json); setNgxStatus(json.note || 'Stock data loaded') }
      } catch (error) {
        if (!cancelled) setNgxStatus(error instanceof Error ? error.message : 'Stock data unavailable.')
      }
    }
    void loadNgx()
    const id = window.setInterval(() => void loadNgx(), 300000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [stockCountry])

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
    if (!window.confirm('Reset the shared demo account to ₦100,000 and close all open demo trades?')) return
    const resetToken = window.prompt('Enter the demo reset token configured by the administrator:')
    if (!resetToken) return
    setDemoBusy(true)
    try {
      const response = await fetch(`${API}/api/v1/demo/reset`, {
        method: 'POST',
        headers: { 'X-Demo-Reset-Token': resetToken },
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.detail || 'Could not reset demo account.')
      setDemoAccount(json); setDemoStatus('Demo account reset to ₦100,000.')
    } catch (error) {
      setDemoStatus(error instanceof Error ? error.message : 'Demo reset failed.')
    } finally { setDemoBusy(false) }
  }

  const demoMarkPrices = useMemo(() => {
    const prices: Record<string, { price: number; bid: number | null; ask: number | null; updated: number; fresh: boolean; brokerQuote: boolean }> = {}
    const now = Date.now()
    for (const market of Object.values(allTf) as Market[]) {
      if (market.status !== 'LIVE' || market.price == null || !Number.isFinite(market.price)) continue
      const updated = market.updated_at ? new Date(market.updated_at).getTime() : 0
      const prior = prices[market.symbol]
      if (!prior || updated > prior.updated) {
        prices[market.symbol] = {
          price: market.price, bid: market.bid, ask: market.ask, updated,
          fresh: Number.isFinite(updated) && updated > 0 && now - updated >= -30000 && now - updated <= 60000,
          // Binance BTCUSDT is an analysis reference, not an Exness BTCUSD CFD quote.
          brokerQuote: (market.provider || '').toLowerCase().includes('exness'),
        }
      }
    }
    return prices
  }, [allTf])
  const demoOpenTrades = (demoAccount?.trades || []).filter((trade: any) => trade.status === 'OPEN')
  const getDemoMark = (trade: any) => {
    const quote = demoMarkPrices[trade.symbol]
    if (!quote) return { price: null, reason: 'NO LIVE QUOTE FOR THIS SYMBOL', pnl: null }
    if (!quote.brokerQuote) return { price: null, reason: 'ANALYSIS FEED ONLY · NO VERIFIED EXNESS CFD QUOTE', pnl: null }
    if (!quote.fresh) return { price: null, reason: 'QUOTE STALE', pnl: null }
    const closePrice = trade.side === 'BUY' ? quote.bid : quote.ask
    if (typeof closePrice !== 'number' || !Number.isFinite(closePrice) || closePrice <= 0) {
      return { price: null, reason: 'BID/ASK UNAVAILABLE', pnl: null }
    }
    const riskDistance = Math.abs(Number(trade.entry) - Number(trade.stop_loss))
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) return { price: closePrice, reason: 'INVALID RISK DISTANCE', pnl: null }
    const signedMove = trade.side === 'BUY' ? closePrice - Number(trade.entry) : Number(trade.entry) - closePrice
    return { price: closePrice, reason: 'LIVE', pnl: (signedMove / riskDistance) * Number(trade.risk_amount || 0) }
  }
  const demoMarks = demoOpenTrades.map((trade: any) => getDemoMark(trade))
  const demoPnlAvailable = demoMarks.every((mark: any) => typeof mark.pnl === 'number' && Number.isFinite(mark.pnl))
  const demoUnrealizedPnl = demoMarks.reduce((total: number, mark: any) => total + (mark.pnl ?? 0), 0)
  const demoEquity = Number(demoAccount?.balance ?? 100000) + demoUnrealizedPnl
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
  // Restore an existing browser push subscription on every app load.
  // This does not request permission; it only syncs a subscription already granted by the user.
  useEffect(() => {
    let cancelled = false
    const restorePushSubscription = async () => {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
        if (Notification.permission !== 'granted') {
          if (!cancelled) {
            setPushEnabled(false)
            setPushStatus('Notifications are not permitted by this browser.')
          }
          return
        }
        const registration = await navigator.serviceWorker.register('/sw.js')
        const subscription = await registration.pushManager.getSubscription()
        if (!subscription) {
          if (!cancelled) {
            setPushEnabled(false)
            setPushStatus('No device subscription found. Enable Android push notifications.')
          }
          return
        }
        const response = await fetch(`${API}/api/v1/push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription)
        })
        if (!response.ok) throw new Error('Could not sync the existing device subscription with GoldSight.')
        if (!cancelled) {
          setPushEnabled(true)
          setPushStatus('This Android device is subscribed to setup alerts.')
        }
      } catch (error) {
        if (!cancelled) {
          setPushEnabled(false)
          setPushStatus(error instanceof Error ? error.message : 'Could not restore push subscription.')
        }
      }
    }
    void restorePushSubscription()
    return () => { cancelled = true }
  }, [])

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
      if (!keyResponse.ok || !keyJson.enabled || !keyJson.public_key) throw new Error(keyJson.note || 'Push service is not fully configured on the server yet. Check VAPID keys, claims email, database and delivery library.')
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

  const sendPushTest = async () => {
    setPushTestBusy(true)
    setPushStatus('Sending a test notification to this Android device…')
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('This browser does not support Web Push.')
      }
      const registration = await navigator.serviceWorker.register('/sw.js')
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) throw new Error('No device subscription found. Enable Android push notifications again.')
      const response = await fetch(`${API}/api/v1/push/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.detail || 'The test notification could not be sent.')
      setPushStatus('Test notification accepted by the push provider. Check your Android notification shade.')
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : 'Could not send the test notification.')
    } finally {
      setPushTestBusy(false)
    }
  }

  const switchMarket = (s: 'XAUUSD' | 'BTCUSD') => { setSymbol(s); setData(null); setAllTf({}); setLastError('') }
  return <main className="shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">T</span><span>TradeSight<small>REAL-TIME MARKET INTELLIGENCE</small></span></a><div className={`status ${isLive ? 'is-live' : 'is-offline'}`}><span className="dot" />{isLive ? 'LIVE DATA' : 'OFFLINE'} <span className="divider">|</span> <span>{loading ? 'Connecting…' : isLive ? 'Connected' : 'Feed unavailable'}</span></div></header>
    <section className="panel history-panel" style={{display: activeTab === 'settings' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">ALERT DELIVERY</p><h2>Setup notifications</h2></div><span className="history-count">{pushEnabled ? 'PUSH ON' : 'PUSH OFF'}</span></div>
      <p className="muted">{pushStatus}. New confirmed BUY/SELL setups only; duplicate refreshes and NO SETUP states do not alert.</p><button className="refresh" onClick={() => setActiveTab('tools')}>Open pip calculator</button>
      <button className="refresh" onClick={() => void enablePushNotifications()} disabled={pushEnabled}>{pushEnabled ? 'Android notifications enabled' : 'Enable Android push notifications'}</button>
      <button className="refresh" onClick={() => void sendPushTest()} disabled={!pushEnabled || pushTestBusy}>{pushTestBusy ? 'Sending test…' : 'Send test notification'}</button>

    </section>
    <nav className="market-tabs" aria-label="Markets" style={{display: activeTab === 'forecast' ? 'flex' : 'none'}}><button className={symbol === 'XAUUSD' ? 'active' : ''} onClick={() => switchMarket('XAUUSD')}>✦ GOLD <small>XAUUSD</small></button><button className={symbol === 'BTCUSD' ? 'active' : ''} onClick={() => switchMarket('BTCUSD')}>₿ BITCOIN <small>BTCUSD</small></button><button className="refresh" onClick={() => void load(true)}>↻ Refresh</button></nav>
    <section className="intro" style={{display: activeTab === 'forecast' ? 'flex' : 'none'}}><div><p className="eyebrow">MARKET OVERVIEW / {symbol}</p><h1>Trade the evidence.<br/><em>Not the impulse.</em></h1><p className="muted">Confirmed-candle analysis with transparent entry, risk and invalidation levels.</p></div><div className={`session ${isLive ? 'live-session' : ''}`}><span className="pulse" /> {isLive ? 'LIVE MARKET FEED' : 'OFFLINE'}<small>{current?.provider || 'Waiting for provider'}</small></div></section>
    <section className="metrics" style={{display: activeTab === 'forecast' ? 'grid' : 'none'}}>
      <article className="metric"><span>LIVE PRICE · {symbol}</span><strong>{isLive ? fmt(current.price, digits) : '—'}</strong><small>{isLive && current?.bid != null && current.ask != null ? `Bid ${fmt(current.bid, digits)} · Ask ${fmt(current.ask, digits)}` : 'No verified quote available'}</small></article>
      <article className="metric"><span>MARKET TREND · {timeframe.toUpperCase()}</span><strong className={`trend ${current?.signal?.trend?.toLowerCase() || ''}`}>{isLive ? current?.signal?.trend || 'UNKNOWN' : 'UNKNOWN'}</strong><small>9/21 EMA + structure rules</small></article>
      <article className="metric"><span>SPREAD</span><strong>{isLive && current?.spread != null ? fmt(current.spread, digits) : '—'}</strong><small>{current?.provider_note || 'Provider-reported bid/ask spread'}</small></article>
      <article className="metric"><span>LAST PROVIDER UPDATE</span><strong className="time-value">{isLive ? dateFmt(updatedAt) : '—'}</strong><small>Refresh interval: 15 seconds</small></article>
    </section>
    {symbol === 'XAUUSD' && <section className="metrics spot-reference" style={{display: activeTab === 'forecast' ? 'grid' : 'none'}}><article className="metric"><span>XAUS · INDICATIVE GOLD SPOT</span><strong>{spotReference?.status === 'LIVE' && spotReference.price != null ? `${fmt(spotReference.price, 2)}` : '—'}</strong><small>{spotReference?.status === 'LIVE' ? `Source updated ${dateFmt(spotReference.updated_at)} · ${spotReference.age_seconds ?? '—'}s old` : `Spot reference unavailable${spotError ? `: ${spotError}` : ''}`}</small><small>Spot mid-price only — not a broker quote. No bid/ask, spread or signal candles.</small></article></section>}
    <section className="panel" style={{display: activeTab === 'forecast' ? 'block' : 'none'}}><div className="panel-head"><div><p className="eyebrow">PRICE ACTION</p><h2>{symbol === 'XAUUSD' && !isLive ? 'Gold indicative spot price trace' : `${symbol === 'XAUUSD' ? 'Gold' : 'Bitcoin'} candlestick chart`}</h2></div>{!(symbol === 'XAUUSD' && !isLive && spotReference?.price != null) && <div className="timeframes">{(['5m', '15m', '1h', '4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div>}</div>
      <div className="chart-label"><span><b className="legend-dot" /> {symbol} · {symbol === 'XAUUSD' && !isLive && spotReference?.price != null ? 'INDICATIVE SPOT' : timeframe.toUpperCase()}</span><span>{isLive ? `SOURCE: ${current?.provider}` : symbol === 'XAUUSD' && spotReference?.price != null ? 'SOURCE: XAUS SPOT · ~60s UPDATES' : 'NO VERIFIED MARKET DATA'}</span></div>
      {isLive && current?.candles?.length ? <PriceChart data={current.candles} digits={digits} /> : symbol === 'XAUUSD' && spotReference?.price != null ? <PriceChart data={[]} digits={2} spotPoints={spotPoints} spotOnly /> : <div className="chart-offline"><span className="offline-icon">⌁</span><b>Live candles unavailable</b><p>{lastError || 'Connect the market-data provider to display verified prices.'}</p><small>No sample candles are displayed in offline mode.</small></div>}
      <p className="chart-foot">{isLive ? `Last update: ${dateFmt(updatedAt)} · Source: ${current?.provider}` : symbol === 'XAUUSD' && spotReference?.price != null ? `Indicative spot trace · ${spotPoints.length} real provider samples collected in this browser session. Updates approximately every 60 seconds; not a broker candle chart or trade signal source.` : 'OFFLINE · The chart stays empty until genuine market data is available.'}</p>
    </section>
    {!isLive && activeTab === 'forecast' && <div className="offline-notice"><b>OFFLINE — signals disabled</b><span>{lastError || 'No live feed.'} This app will not substitute invented prices or candles.</span></div>}
    <section className="panel demo-summary" style={{display: activeTab === 'forecast' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">PAPER TRADING · NO BROKER ORDERS</p><h2>Demo account snapshot</h2></div><button className="refresh" onClick={() => setActiveTab('demo')}>Open demo account</button></div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>DEMO BALANCE</span><strong>₦{fmt(demoAccount?.balance ?? 100000, 2)}</strong><small>Starting balance ₦100,000 · Realized P/L: <b className={(demoAccount?.realized_pnl ?? 0) >= 0 ? 'green' : 'red'}>₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</b></small></article>
        <article className="metric"><span>OPEN DEMO POSITIONS</span><strong>{demoAccount?.open_count ?? 0} / 2</strong><small>Auto {demoAccount?.auto_trade ? 'ON' : 'OFF'}</small></article>
        <article className="metric"><span>RISK PER TRADE</span><strong>{demoAccount?.risk_per_trade_pct ?? 1}%</strong><small>Demo balance only</small></article>
        <article className="metric"><span>LIVE UNREALIZED P/L</span><strong className={demoUnrealizedPnl >= 0 ? 'green' : 'red'}>{demoPnlAvailable ? `₦${fmt(demoUnrealizedPnl, 2)}` : '—'}</strong><small>{demoPnlAvailable ? 'Open trades · latest live quotes' : 'Waiting for live quotes for every open trade'}</small></article><article className="metric"><span>DEMO EQUITY</span><strong>{demoPnlAvailable ? `₦${fmt(demoEquity, 2)}` : '—'}</strong><small>Balance + live floating P/L</small></article>
      </div>
    </section>
    <section className="bottom-grid" style={{display: activeTab === 'forecast' ? 'grid' : 'none'}}><SignalCard signal={signalForUi} digits={digits} symbol={symbol} timeframe={timeframe} />
      <section className="panel insight"><p className="eyebrow">MULTI-TIMEFRAME CONTEXT</p><h2>Trend alignment</h2>
        {trendRows.map(row => <div className="context-row" key={row.tf}><span>{row.tf.toUpperCase()}</span><b className={row.trend.toLowerCase()}>{row.live ? row.trend : 'OFFLINE'}</b></div>)}
        <div className="context-row"><span>Data provider</span><b>{isLive ? current?.provider : 'Unavailable'}</b></div><div className="context-row"><span>Signal method</span><b>Rule-based SMC baseline</b></div><div className="context-row"><span>Order execution</span><b>Disabled</b></div>
        <p className="score-note">Rule-based analysis · Not a verified win probability.</p>
      </section>
    </section>
    <section className="panel history-panel ngx-panel" style={{display: activeTab === 'stocks' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">GLOBAL EQUITIES · SIGNALS ONLY</p><h2>{ngxData?.flag || "🌐"} Stock Intelligence</h2></div><span className={ngxData?.status === 'LIVE' ? 'stock-live' : 'history-count'}>{ngxData?.status || 'CONNECTING'}</span></div>
      <p className="muted">Signals only · Starting research capital ₦100,000–₦500,000 · Short-term and long-term research. No orders are placed.</p>
      <div className="news-filters stock-market-filters">{[{id:"NG",label:"🇳🇬 Nigeria"},{id:"US",label:"🇺🇸 USA"},{id:"GB",label:"🇬🇧 UK"},{id:"CA",label:"🇨🇦 Canada"},{id:"ZA",label:"🇿🇦 South Africa"},{id:"IN",label:"🇮🇳 India"},{id:"DE",label:"🇩🇪 Germany"},{id:"AU",label:"🇦🇺 Australia"}].map(x=><button key={x.id} className={stockCountry===x.id?"selected":""} onClick={()=>setStockCountry(x.id)}>{x.label}</button>)}</div>
      {ngxData?.market && <div className="metrics ngx-metrics">
        <article className="metric"><span>ALL-SHARE INDEX</span><strong>{ngxData.market.asi != null ? Number(ngxData.market.asi).toLocaleString('en-NG',{maximumFractionDigits:2}) : '—'}</strong><small>{ngxData.market.pct_change != null ? `${Number(ngxData.market.pct_change).toFixed(2)}% daily` : 'Index snapshot unavailable'}</small></article>
        <article className="metric"><span>MARKET CAPITALISATION</span><strong>{ngxData.market.market_cap != null ? `₦${(Number(ngxData.market.market_cap)/1e12).toFixed(2)}T` : '—'}</strong><small>Provider snapshot</small></article>
        <article className="metric"><span>ADVANCERS / DECLINERS</span><strong>{ngxData.market.advancers ?? '—'} / {ngxData.market.decliners ?? '—'}</strong><small>Market breadth</small></article>
        <article className="metric"><span>TRADING VOLUME</span><strong>{ngxData.market.volume != null ? Number(ngxData.market.volume).toLocaleString('en-NG') : '—'}</strong><small>Shares traded</small></article>
      </div>}
      <div className="stock-capital"><b>Research capital: ₦100K–₦500K</b><span>For non-NGN markets, capital is treated as a research budget only; currency conversion, local fees and position sizing are not assumed.</span></div>
      <p className="chart-foot">{ngxStatus} · {ngxData?.provider || 'NGX provider not connected'} · Updated {ngxData?.updated_at ? dateFmt(ngxData.updated_at) : '—'}</p>
      {ngxData?.watchlist?.length ? <div className="stock-list">{ngxData.watchlist.map((stock:any) => <article className="stock-card" key={stock.ticker}>
        <div className="stock-head"><div><b>{stock.ticker}</b><small>{stock.name} · {ngxData.market}</small></div><span className={Number(stock.change20_pct) >= 0 ? 'green' : 'red'}>{stock.change20_pct == null ? '—' : `${Number(stock.change20_pct)>0?'+':''}${Number(stock.change20_pct).toFixed(2)}% / 20D`}</span></div>
        <div className="stock-numbers"><div><small>PRICE · {ngxData.currency}</small><b>{stock.price == null ? '—' : Number(stock.price).toLocaleString('en-US',{maximumFractionDigits:3})}</b></div><div><small>RSI · 14</small><b>{stock.rsi14 ?? '—'}</b></div><div><small>TECH SCORE</small><b>{stock.technical_score ?? '—'}/100</b></div></div>
        <div className="stock-verdict">{stock.signal || 'WAIT — INSUFFICIENT DATA'} · {stock.trend || 'UNKNOWN'}</div>
        <p className="score-note">{stock.reason}</p>
        <small className="score-note">{stock.fresh ? "Recent daily data" : "Stale daily data"} · {stock.history_bars} daily bars</small>
        <small className="score-note">Holding horizon: {stock.holding_horizon || 'Not assigned'} · Entry/SL/TP: not generated; fundamentals and liquidity checks are missing.</small>
      </article>)}</div> : <div className="chart-offline"><b>{ngxData?.market || "Stock data not connected"}</b><p>{ngxData?.note || ngxStatus}</p><small>The selected market price-history provider may be unavailable or may not cover every ticker. No invented quotes or stock picks are displayed.</small></div>}
      <p className="score-note">A watchlist score is a screening aid, not a forecast or a guarantee. A BUY signal requires multi-session price history, fundamentals, liquidity and a risk-defined entry. Data may be delayed.</p>
    </section>
    <section className="panel history-panel" style={{display: activeTab === 'alerts' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">GLOBAL MACRO & COMPANY INTELLIGENCE</p><h2>Market-moving news</h2></div><span className="history-count">{fundamentalItems.length} headlines</span></div>
      
      <p className="chart-foot">{fundamentalStatus}</p>
      <div className="news-filters">{[{id:'ALL',label:'All markets'},{id:'NG',label:'🇳🇬 Nigeria'},{id:'US',label:'🇺🇸 USA'},{id:'GB',label:'🇬🇧 UK'},{id:'EU',label:'🇪🇺 Europe'},{id:'GLOBAL',label:'🌍 Global'}].map(x => <button key={x.id} className={newsCountry === x.id ? 'selected' : ''} onClick={() => setNewsCountry(x.id)}>{x.label}</button>)}</div>\n       <div className="news-filters"><button className={newsFocus === "ALL" ? "selected" : ""} onClick={()=>setNewsFocus("ALL")}>All coverage</button><button className={newsFocus === "INCOME" ? "selected" : ""} onClick={()=>setNewsFocus("INCOME")}>Dividends · Earnings · Yields</button><button className={newsFocus === "HIGH" ? "selected" : ""} onClick={()=>setNewsFocus("HIGH")}>High impact</button></div>
      {fundamentalItems.length ? <div className="history-list">{fundamentalItems.filter(item => (newsCountry === 'ALL' || (item.country || 'GLOBAL') === newsCountry) && (newsFocus === 'ALL' || (newsFocus === 'INCOME' ? item.income_relevance === 'INCOME' : item.impact === 'HIGH'))).slice(0, 20).map(item => <article className="news-card" key={item.id}>
        <div className="news-meta"><span className="news-flag">{item.country === 'NG' ? '🇳🇬' : item.country === 'US' ? '🇺🇸' : item.country === 'GB' ? '🇬🇧' : item.country === 'EU' ? '🇪🇺' : '🌍'}</span><span className="news-country">{item.country === 'NG' ? 'NIGERIA' : item.country === 'US' ? 'UNITED STATES' : item.country === 'GB' ? 'UNITED KINGDOM' : item.country === 'EU' ? 'EUROPE' : 'GLOBAL'}</span><span className={`impact-${item.impact.toLowerCase()}`}>{item.impact} IMPACT</span>{item.income_relevance === "INCOME" && <span className="income-tag">DIVIDENDS / EARNINGS</span>}<span>{item.source}</span><time>{dateFmt(item.published_at)}</time></div>
        <a href={item.url} target="_blank" rel="noreferrer" className="news-title">{item.title}</a>
        {item.summary && <p className="muted">{item.summary}</p>}
        <div className="news-bottom"><span>{item.assets.join(' · ') || 'ECONOMY & POLICY'}</span><small>{item.interpretation}</small></div>
      </article>)}</div> : <div className="history-empty">No live headlines available. {fundamentalStatus}</div>}
    </section>
    <section className="panel history-panel" style={{display: activeTab === 'alerts' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">RECENT EVENTS</p><h2>Signal history</h2></div><span className="history-count">{history.length} saved</span></div>
      {history.length ? (() => {
        const sorted = [...history].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        const visible = showAllHistory ? sorted : sorted.slice(0, 5);
        const groups = visible.reduce<Record<string, typeof visible>>((acc, item) => {
          const parsed = new Date(item.time);
          const dateKey = Number.isNaN(parsed.getTime()) ? 'Unknown date' : new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
          (acc[dateKey] ||= []).push(item);
          return acc;
        }, {});
        const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(yesterday);
        return <div className="history-groups">
          {Object.entries(groups).map(([dateKey, items]) => {
            const heading = dateKey === todayKey ? 'Today' : dateKey === yesterdayKey ? 'Yesterday' : dateKey === 'Unknown date' ? dateKey : new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'full' }).format(new Date(dateKey + 'T12:00:00+01:00'));
            return <section className="history-day" key={dateKey}>
              <h3>{heading}<span>{items.length} {items.length === 1 ? 'signal' : 'signals'}</span></h3>
              {items.map(item => <div className="history-entry-wrap" key={item.key}>
                <button type="button" className="history-row history-row-button" aria-expanded={selectedHistoryKey === item.key} onClick={() => setSelectedHistoryKey(current => current === item.key ? null : item.key)}>
                  <span className={item.side.toLowerCase()}>{item.side}</span><b>{item.symbol}</b><span>{item.tf.toUpperCase()}</span>
                  <span>{item.entry == null ? '—' : fmt(item.entry, digits)}</span><span className="history-count">{item.trade_type || 'TECHNICAL TRADE'}</span>
                  <time><strong>{dateFmt(item.time)}</strong>{item.candleTime && <small>Candle: {dateFmt(item.candleTime)}</small>}</time>
                  <small className="history-expand-hint">{selectedHistoryKey === item.key ? 'Tap to hide setup' : 'Tap to view full setup'}</small>
                </button>
                {selectedHistoryKey === item.key && <div className="history-detail">
                  <div className="history-levels">
                    <article><span>ENTRY</span><strong>{item.entry == null ? '—' : fmt(item.entry, digits)}</strong></article>
                    <article><span>STOP LOSS</span><strong>{item.stop_loss == null ? '—' : fmt(item.stop_loss, digits)}</strong></article>
                    {item.take_profits.map((target, index) => <article key={index}><span>TP{index + 1}</span><strong>{fmt(target, digits)}</strong></article>)}
                  </div>
                  <div className="history-meta"><span>Trend: {item.trend || '—'}</span><span>R:R: {item.rr?.length ? item.rr.map(value => value + ':1').join(' / ') : '—'}</span><span>Rule score: {item.confidence == null ? '—' : item.confidence + '%'}</span><span>Provider: {item.provider || '—'}</span></div>
                  {item.reasons?.length > 0 && <div className="history-reasons"><b>Why this setup was detected</b><ul>{item.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
                  {item.invalidation && <p className="history-invalidation"><b>Invalidation:</b> {item.invalidation}</p>}
                  <p className="score-note">Historical signal snapshot · not a live instruction. Check current price and setup validity before considering a trade.</p>
                </div>}
              </div>)}
            </section>;
          })}
        </div>;
      })() : <div className="history-empty">No saved setups yet. {historyStatus}</div>}
      {history.length > 5 && <button className="refresh history-toggle" onClick={() => setShowAllHistory(value => !value)}>{showAllHistory ? 'Show less' : `View all ${history.length} signals`}</button>}
      <p className="chart-foot">{historyStatus} · Times shown in Africa/Lagos (WAT). Alert time is when GoldSight recorded the setup; candle time is shown separately.</p>
    </section>

    <section className="panel demo-panel" style={{display: activeTab === 'demo' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">SIMULATED ACCOUNT · NO BROKER ORDERS</p><h2>Demo trading</h2></div><span className="signal-badge buy">AUTO {demoAccount?.auto_trade ? 'ON' : 'OFF'}</span></div>
      
      <div className="demo-balance"><span>AVAILABLE BALANCE</span><strong>₦{fmt(demoAccount?.balance ?? 100000, 2)}</strong><small>Starting balance ₦100,000 · Realized P/L: ₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</small></div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>LIVE FLOATING P/L</span><strong className={demoUnrealizedPnl >= 0 ? 'green' : 'red'}>{demoPnlAvailable ? `₦${fmt(demoUnrealizedPnl, 2)}` : '—'}</strong><small>{demoPnlAvailable ? 'Open positions · live quotes' : 'Waiting for live quotes'}</small></article>
        <article className="metric"><span>TOTAL DEMO EQUITY</span><strong>{demoPnlAvailable ? `₦${fmt(demoEquity, 2)}` : '—'}</strong><small>Balance + floating P/L</small></article>
        <article className="metric"><span>REALIZED P/L</span><strong className={(demoAccount?.realized_pnl ?? 0) >= 0 ? 'green' : 'red'}>₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</strong><small>Closed positions</small></article>
      </div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>OPEN POSITIONS</span><strong>{demoAccount?.open_count ?? 0} / 2</strong></article>
        <article className="metric"><span>RISK PER TRADE</span><strong>{demoAccount?.risk_per_trade_pct ?? 1}%</strong><small>Of current balance</small></article>
      </div>
      <div className="context-row"><span>Automation</span><b>{demoAccount?.auto_trade ? 'Enabled' : 'Disabled'}</b></div>
      <div className="context-row"><span>Exness USD/NGN rate</span><b>{demoAccount?.fx_rate_configured ? 'Configured' : 'Missing · new Gold entries blocked'}</b></div>
      <div className="context-row"><span>Exit rule</span><b>Full close at TP1 or SL</b></div><div className="context-row"><span>Live demo equity</span><b className={demoUnrealizedPnl >= 0 ? 'green' : 'red'}>{demoPnlAvailable ? `₦${fmt(demoEquity, 2)}` : 'Waiting for live quotes'}</b></div>
      <p className="score-note">{demoAccount?.sizing_note || demoStatus}</p>
      <div className="panel-head demo-trades-head"><h2>Demo positions & history</h2><button className="refresh" onClick={() => void resetDemo()} disabled={demoBusy}>{demoBusy ? 'Resetting…' : 'Reset account'}</button></div>
      {demoAccount?.trades?.length ? <div className="history-list">{demoAccount.trades.map((trade: any) => {
        const mark = trade.status === 'OPEN' ? getDemoMark(trade) : null
        const pnlLabel = trade.status === 'OPEN'
          ? mark?.pnl == null ? mark?.reason || 'WAITING FOR LIVE PRICE' : `LIVE · ₦${fmt(mark.pnl, 2)}`
          : `${trade.close_reason} · ₦${fmt(trade.pnl, 2)}`
        return <div className="history-row demo-row" key={trade.id}>
          <span className={trade.side.toLowerCase()}>{trade.side}</span>
          <b>{trade.symbol}</b>
          <span>{trade.timeframe.toUpperCase()}</span>
          <span>{fmt(trade.entry, trade.symbol === 'BTCUSD' ? 2 : 3)}</span>
          <span className={trade.status === 'OPEN' ? 'history-count' : (trade.pnl >= 0 ? 'buy' : 'sell')}>{pnlLabel}</span>
          {trade.status === 'OPEN' && <small className="demo-quote-detail">Lot: {trade.lot_size ?? 'legacy R-based'} · Margin: {trade.estimated_margin == null ? '—' : `₦${fmt(trade.estimated_margin, 2)}`} · Mark: {mark?.price == null ? '—' : fmt(mark.price, trade.symbol === 'BTCUSD' ? 2 : 3)} · SL {fmt(trade.stop_loss, trade.symbol === 'BTCUSD' ? 2 : 3)} · TP1 {fmt(trade.take_profit, trade.symbol === 'BTCUSD' ? 2 : 3)}</small>}
          <time>{dateFmt(trade.opened_at)}</time>
        </div>
      })}</div> : <div className="history-empty">No demo trades yet. GoldSight will wait for a fresh, fully aligned setup.</div>}
      <p className="chart-foot">{demoStatus}. If the backend sleeps, automatic monitoring pauses too.</p>
    </section>
    <div style={{display: activeTab === 'tools' ? 'block' : 'none'}}><PositionSizer symbol={symbol} /><PipCalculator symbol={symbol} /><CurrencyConverter /></div>
    <section className="panel settings-panel" style={{display: activeTab === 'settings' ? 'block' : 'none'}}>
      <p className="eyebrow">PREFERENCES</p><h2>Settings</h2>
      <div className="settings-group"><span>Default market</span><div className="settings-actions"><button className={symbol === 'XAUUSD' ? 'selected' : ''} onClick={() => switchMarket('XAUUSD')}>Gold · XAUUSD</button><button className={symbol === 'BTCUSD' ? 'selected' : ''} onClick={() => switchMarket('BTCUSD')}>Bitcoin · BTCUSD</button></div></div>
      <div className="settings-group"><span>Analysis timeframe</span><div className="settings-actions">{(['5m','15m','1h','4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div></div>
      
      <div className="settings-group"><span>Data refresh</span><p className="muted">Market data refreshes every 15 seconds. News refreshes every 5 minutes. Live feed status is shown in the header.</p><button className="refresh" onClick={() => void load(true)}>Refresh market data now</button></div>
      
    </section>
    <nav className="app-bottom-nav" aria-label="Main navigation">
      {([{id:'forecast',label:'Forecast',icon:'⌁'},{id:'alerts',label:'News',icon:'◉'},{id:'stocks',label:'NGX Stocks',icon:'₦'},{id:'demo',label:'Demo',icon:'▣'},{id:'tools',label:'Tools',icon:'∑'},{id:'settings',label:'Settings',icon:'⚙'}] as const).map(tab => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}><span>{tab.icon}</span><small>{tab.label}</small></button>)}
    </nav>
    <footer><span>TradeSight</span><span>Analysis only · No live orders</span></footer>
  </main>
}
