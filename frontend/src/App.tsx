import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { PushNotifications, type Token } from '@capacitor/push-notifications'
import { LocalNotifications } from '@capacitor/local-notifications'
import { registerPlugin } from '@capacitor/core'
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { createChart, CandlestickSeries, LineSeries, type IChartApi, type CandlestickData, type Time } from 'lightweight-charts'
import CurrencyConverter from './CurrencyConverter'
import StockPortfolio from './StockPortfolio'
import BrokerBridge from './BrokerBridge'
import BrokerConnection from './BrokerConnection'
import WorkspaceManager from './WorkspaceManager'

type OverlayPlugin = {
  checkPermission(): Promise<{ granted: boolean }>
  requestPermission(): Promise<void>
  start(options: { symbol: string; price: string; signal: string }): Promise<void>
  update(options: { symbol: string; price: string; signal: string }): Promise<void>
  stop(): Promise<void>
}
const TradeSightOverlay = registerPlugin<OverlayPlugin>('TradeSightOverlay')

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
type TF = '5m' | '15m' | '1h' | '4h'
type Symbol = 'XAUUSD' | 'BTCUSD' | 'EURUSD' | 'GBPUSD'
type Candle = CandlestickData<Time> & { volume?: number }
type Signal = { status: string; side: string; entry: number | null; stop_loss: number | null; take_profits: number[]; rr: number[] | null; confidence: number | null; confidence_label?: string; reasons: string[]; invalidation: string; signal_time: string | null; trend: string; trade_type?: string; entry_style?: string; news_context?: {title?: string; url?: string; source?: string; published_at?: string; impact?: string; minutes_before_signal?: number; causality_confirmed?: boolean} | null; news_context_status?: string; news_context_note?: string }
type Market = { symbol: string; provider_symbol?: string; provider?: string; provider_note?: string; status: 'LIVE' | 'OFFLINE' | 'MARKET_CLOSED'; market_status?: 'OPEN' | 'MARKET_CLOSED' | 'OFFLINE'; market_phase?: string | null; next_open_at?: string | null; schedule_timezone?: string | null; price: number | null; bid: number | null; ask: number | null; spread: number | null; digits?: number; updated_at: string | null; timeframe: TF; candles: Candle[]; signal: Signal }
type SpotReference = { symbol: string; provider: string; status: 'LIVE' | 'OFFLINE'; price: number | null; updated_at: string | null; age_seconds?: number; data_state?: string; tradable_quote: false; candles_available: false; note?: string; detail?: string }
const emptySignal: Signal = { status: 'NO SETUP', side: 'NO SETUP', entry: null, stop_loss: null, take_profits: [], rr: null, confidence: null, reasons: ['Waiting for live market data.'], invalidation: 'No active setup.', signal_time: null, trend: 'UNKNOWN' }
const decodeHtmlEntities = (value: string) => { const node = document.createElement('textarea'); let decoded = value; for (let i = 0; i < 2; i++) { node.innerHTML = decoded; if (node.value === decoded) break; decoded = node.value } return decoded }
const fmt = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const dateFmt = (s: string | null) => s && !Number.isNaN(new Date(s).getTime()) ? new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(s)) + ' WAT' : '—'

const exnessGoldSession = (date = new Date()) => {
  const utcWeekday = date.getUTCDay()
  const seconds = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds()
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value || 'EST'
  const summer = zoneName === 'EDT'
  const sundayOpen = (summer ? 21 : 22) * 3600 + 5 * 60
  const dailyClose = (summer ? 20 : 21) * 3600 + 58 * 60
  const dailyReopen = (summer ? 22 : 23) * 3600 + 2 * 60
  if (utcWeekday === 6) return { open: false, phase: 'WEEKEND' }
  if (utcWeekday === 0) {
    if (seconds < sundayOpen - 210) return { open: false, phase: 'WEEKEND' }
    if (seconds < sundayOpen) return { open: false, phase: 'CLOSE_ONLY' }
    return { open: true, phase: 'TRADING' }
  }
  if (utcWeekday === 5) return seconds < dailyClose ? { open: true, phase: 'TRADING' } : { open: false, phase: 'WEEKEND' }
  if (seconds < dailyClose || seconds >= dailyReopen) return { open: true, phase: 'TRADING' }
  return { open: false, phase: seconds >= dailyReopen - 90 ? 'CLOSE_ONLY' : 'DAILY_BREAK' }
}
const isStandardFxSessionClosed = (symbol: Symbol, date = new Date()) => symbol === 'BTCUSD' ? false : !exnessGoldSession(date).open
const nextMarketOpenAt = (symbol: Symbol, now: Date) => {
  if (symbol === 'BTCUSD' || !isStandardFxSessionClosed(symbol, now)) return null
  const candidate = new Date(now)
  candidate.setUTCSeconds(0, 0)
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  for (let i = 0; i < 8 * 24 * 60; i++, candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)) {
    if (!isStandardFxSessionClosed(symbol, candidate)) return new Date(candidate)
  }
  return null
}

function MarketOpensCountdown({ symbol }: { symbol: Symbol }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const target = nextMarketOpenAt(symbol, now)
  if (!target) return null
  const seconds = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  const timerText = days > 0
    ? `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`
    : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return <small className="market-opens-countdown">Market opens in <strong>{timerText}</strong></small>
}

const isWeekendMarketClosed = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value
    return acc
  }, {})
  const hour = Number(parts.hour)
  return parts.weekday === 'Sat' || (parts.weekday === 'Fri' && hour >= 17) || (parts.weekday === 'Sun' && hour < 18)
}
const chartCacheKey = (symbol: string, timeframe: TF) => `tradesight-chart:${symbol}:${timeframe}`
const quoteCacheKey = (symbol: Symbol) => `tradesight-last-quote:${symbol}`
type CachedQuote = { price: number; updated_at: string | null; provider?: string | null }
const readCachedQuote = (marketSymbol: Symbol): CachedQuote | null => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(quoteCacheKey(marketSymbol)) || 'null') as CachedQuote | null
    return saved && Number.isFinite(saved.price) ? saved : null
  } catch { return null }
}

type SpotPoint = { time: Time; value: number }
type FundamentalItem = { id: string; title: string; summary: string; url: string; source: string; image_url?: string | null; source_image_url?: string | null; published_at: string | null; assets: string[]; impact: string; interpretation: string; country?: string; income_relevance?: string }
type OpportunityItem = { id: string; title: string; summary: string; url: string; source: string; image_url?: string | null; source_image_url?: string | null; published_at: string | null; category: 'TECH' | 'WEB' | 'JOBS'; eligibility?: string | null; interpretation: string }

function MarketSessionClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const session = exnessGoldSession(now)
  const nextOpen = session.open ? null : nextMarketOpenAt('XAUUSD', now)
  const remaining = nextOpen ? Math.max(0, Math.floor((nextOpen.getTime() - now.getTime()) / 1000)) : 0
  const countdown = [Math.floor(remaining / 3600), Math.floor((remaining % 3600) / 60), remaining % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
  const lagosTime = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(now)
  const lagosEventTime = nextOpen ? new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos', weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(nextOpen) : null
  return <div className="market-session-clock" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap',padding:'14px 16px',margin:'12px 0',borderRadius:12,background:'var(--card-soft, #171f2b)',border:'1px solid var(--border, #283241)'}}>
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <span style={{width:10,height:10,borderRadius:'50%',background:session.open?'#18b890':'#ff647c',boxShadow:session.open?'0 0 0 5px rgba(24,184,144,.13)':'0 0 0 5px rgba(255,100,124,.13)'}} />
      <div><div style={{fontWeight:800,color:session.open?'#18b890':'#ff647c',letterSpacing:'.04em'}}>{session.open ? 'MARKET OPEN' : 'MARKET CLOSED'}</div><div style={{fontSize:12,opacity:.72}}>XAUUSD · Exness schedule · {session.phase.replace('_',' ')}</div></div>
    </div>
    <div style={{textAlign:'right',marginLeft:'auto'}}>
      {nextOpen ? <><div style={{fontSize:19,fontWeight:800,fontVariantNumeric:'tabular-nums'}}>Opens in {countdown}</div><div style={{fontSize:12,opacity:.72}}>Next opening: {lagosEventTime} WAT</div></> : <div style={{fontSize:13,fontWeight:700}}>Trading session active</div>}
    </div>
    <div style={{width:'100%',borderTop:'1px solid var(--border, #283241)',paddingTop:9,display:'flex',justifyContent:'space-between',gap:8,flexWrap:'wrap',fontSize:12,opacity:.8}}>
      <span>Nigerian time (WAT · UTC+1)</span><strong style={{fontVariantNumeric:'tabular-nums'}}>{lagosTime}</strong>
    </div>
  </div>
}

function PriceChart({ data, digits, spotPoints = [], spotOnly = false }: { data: Candle[]; digits: number; spotPoints?: SpotPoint[]; spotOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<any>(null)
  useEffect(() => {
    if (!host.current) return
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: '#10151d' }, textColor: '#9ba8ba', fontFamily: 'Inter, system-ui, sans-serif' },      grid: { vertLines: { color: '#202936' }, horzLines: { color: '#202936' } },
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
  const priceDigits = digits
  const isTrade = signal.status === 'BUY' || signal.status === 'SELL'
  return <section className="panel signal-panel">
    <div className="panel-head"><div><p className="eyebrow">LATEST SETUP</p><h2>Signal</h2><p className="signal-market">{symbol} · {timeframe.toUpperCase()}</p></div><div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',justifyContent:'flex-end'}}>{isTrade && <><span className="signal-badge none">{signal.trade_type || 'TECHNICAL TRADE'}</span>{signal.entry_style === 'SNIPER' && <span className="signal-badge buy">SNIPER ENTRY</span>}</>}<span className={`signal-badge ${isTrade ? signal.status.toLowerCase() : 'none'}`}>{signal.status || 'NO SETUP'}</span></div></div>
    {isTrade ? <div className="signal-levels">
      <div><span>ENTRY</span><b>{fmt(signal.entry, priceDigits)}</b></div><div><span>STOP LOSS</span><b className="red">{fmt(signal.stop_loss, priceDigits)}</b></div>
      {signal.take_profits.map((tp, i) => <div key={i}><span>TP{i + 1} · 1:{signal.rr?.[i] ?? i + 1}</span><b className="green">{fmt(tp, priceDigits)}</b></div>)}
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


function PipCalculator({ symbol }: { symbol: Symbol }) {
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY')
  const [entry, setEntry] = useState('4000')
  const [stop, setStop] = useState('3990')
  const [target, setTarget] = useState('4020')
  const [pipSize, setPipSize] = useState('0.01')
  useEffect(() => {
    if (symbol === 'XAUUSD') { setEntry('4000'); setStop('3990'); setTarget('4020'); setPipSize('0.01') }
    else if (symbol === 'EURUSD') { setEntry('1.08000'); setStop('1.07800'); setTarget('1.08400'); setPipSize('0.0001') }
    else if (symbol === 'GBPUSD') { setEntry('1.27000'); setStop('1.26700'); setTarget('1.27600'); setPipSize('0.0001') }
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


function PositionSizer({ symbol }: { symbol: Symbol }) {
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
  if (symbol === 'EURUSD' || symbol === 'GBPUSD') return <section className="panel pip-panel"><div className="panel-head"><div><p className="eyebrow">RISK MANAGEMENT</p><h2>Position Size Calculator</h2><p className="muted">{symbol} · Broker contract profile required</p></div></div><div className="chart-offline"><b>Position sizing not enabled for this pair yet</b><p>Live price analysis and pip calculation are available, but contract size, margin, minimum lot, volume step and account-currency conversion must be verified from your broker before calculating a safe lot size.</p></div></section>
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
    </div>    <button className="refresh" onClick={() => void calculate()} disabled={busy}>{busy ? 'Calculating…' : 'Calculate safe lot size'}</button>
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

type StockSectionErrorBoundaryProps = { children: ReactNode; country: string }
type StockSectionErrorBoundaryState = { hasError: boolean; errorMessage: string }

class StockSectionErrorBoundary extends Component<StockSectionErrorBoundaryProps, StockSectionErrorBoundaryState> {
  state: StockSectionErrorBoundaryState = { hasError: false, errorMessage: '' }
  static getDerivedStateFromError(error: Error): StockSectionErrorBoundaryState {
    return { hasError: true, errorMessage: error?.message || 'Unknown rendering error.' }
  }
  componentDidUpdate(previousProps: StockSectionErrorBoundaryProps) {
    if (previousProps.country !== this.props.country && this.state.hasError) {
      this.setState({ hasError: false, errorMessage: '' })
    }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TradeSight] Stock Intelligence section failed to render', { country: this.props.country, error, componentStack: info.componentStack })
  }
  render() {
    if (this.state.hasError) return <section className="panel history-panel ngx-panel" role="alert">
      <div className="panel-head"><div><p className="eyebrow">GLOBAL EQUITIES · {this.props.country}</p><h2>Stock Intelligence temporarily unavailable</h2></div><span className="history-count">RECOVERABLE ERROR</span></div>
      <p className="muted">The selected market caused this section to fail. TradeSight and the rest of the Market screen are still available.</p>
      <button type="button" onClick={() => this.setState({ hasError: false })}>Retry Stock Intelligence</button>
    </section>
    return this.props.children
  }
}
function CollapsibleSection({ title, children, defaultOpen = false, visible = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean; visible?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return <section className={`compact-expand-card ${open ? 'is-open' : ''}`} style={{ display: visible ? 'block' : 'none' }}>
    <button type="button" className="compact-expand-tab" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="compact-expand-title">{title}</span><span className="compact-expand-action">{open ? 'Collapse' : 'Expand'}</span>
    </button>
    {open && <div className="compact-expand-content">{children}</div>}
  </section>
}

function WeeklyOutlook() {
  const symbols: Symbol[] = ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD']
  const [outlooks, setOutlooks] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const loadWeekly = async () => {
      setLoading(true); setError('')
      const results = await Promise.all(symbols.map(async marketSymbol => {
        try {
          const response = await fetch(API + '/api/v1/market/' + marketSymbol + '/batch', { cache: 'no-store' })
          const json = await response.json()
          if (!response.ok) throw new Error(json.detail || ('Unable to load ' + marketSymbol))
          return [marketSymbol, json] as const
        } catch (e) { return [marketSymbol, { error: e instanceof Error ? e.message : 'Market data unavailable' }] as const }
      }))
      if (cancelled) return
      const next: Record<string, any> = {}
      for (const [marketSymbol, value] of results) next[marketSymbol] = value
      setOutlooks(next); setUpdatedAt(new Date().toISOString())
      if (results.every(([, value]) => value.error)) setError('Weekly outlook is unavailable because no market feeds responded.')
      setLoading(false)
    }
    void loadWeekly()
    return () => { cancelled = true }
  }, [])
  const label = (value: string) => value === 'BULLISH' ? 'Bullish' : value === 'BEARISH' ? 'Bearish' : value === 'SIDEWAYS' ? 'Sideways' : 'Unclear'
  const biasClass = (value: string) => value === 'BULLISH' ? 'green' : value === 'BEARISH' ? 'red' : ''
  return <section className="panel weekly-outlook" style={{marginTop:16}}>
    <div className="panel-head"><div><p className="eyebrow">MULTI-MARKET · 4H / 1H CONTEXT</p><h2>Weekly Outlook</h2><p className="muted">Possible direction for the coming trading week · not a live entry signal</p></div><span className="history-count">{loading ? 'ANALYSING' : 'OUTLOOK'}</span></div>
    {loading ? <div className="chart-offline">Checking fresh market structure across all four markets…</div> : error ? <div className="chart-offline">{error}</div> : <div className="weekly-outlook-grid">
      {symbols.map(marketSymbol => {
        const frames = outlooks[marketSymbol]?.timeframes || {}
        const h4 = frames['4h'], h1 = frames['1h']
        const trend4h = h4?.status === 'LIVE' ? h4.signal?.trend || 'UNKNOWN' : 'UNKNOWN'
        const trend1h = h1?.status === 'LIVE' ? h1.signal?.trend || 'UNKNOWN' : 'UNKNOWN'
        const aligned = trend4h === trend1h && ['BULLISH', 'BEARISH'].includes(trend4h)
        const bias = aligned ? trend4h : (trend4h === 'SIDEWAYS' && trend1h === 'SIDEWAYS' ? 'SIDEWAYS' : 'MIXED')
        const candidate = h4?.signal
        const tradable = h4?.status === 'LIVE' && candidate && ['BUY', 'SELL'].includes(candidate.status) && candidate.signal_fresh !== false
        const digits = marketSymbol === 'EURUSD' || marketSymbol === 'GBPUSD' ? 5 : 2
        return <article className="weekly-outlook-card" key={marketSymbol}>
          <div className="weekly-outlook-card-head"><strong>{marketSymbol}</strong><span className={'signal-badge ' + (bias === 'BULLISH' ? 'buy' : bias === 'BEARISH' ? 'sell' : 'none')}>{bias === 'MIXED' ? 'MIXED BIAS' : label(bias).toUpperCase()}</span></div>
          <div className="weekly-outlook-trends"><span>4H <b className={biasClass(trend4h)}>{label(trend4h)}</b></span><span>1H <b className={biasClass(trend1h)}>{label(trend1h)}</b></span></div>
          {tradable ? <div className="weekly-levels"><span>Current 4H setup: <b>{candidate.status}</b></span><span>Entry area: <b>{fmt(candidate.entry, digits)}</b></span><span>Invalidation / SL: <b>{fmt(candidate.stop_loss, digits)}</b></span><span>Targets: <b>{(candidate.take_profits || []).map((v: number) => fmt(v, digits)).join(' · ') || 'Not defined'}</b></span></div> : <p className="score-note">{h4?.status === 'LIVE' && h1?.status === 'LIVE' ? (aligned ? 'Directional bias only. Wait for a fresh lower-timeframe confirmation before considering an entry.' : 'No aligned weekly direction yet. Watch for a clear 4H structure break and 1H confirmation.') : 'Fresh data unavailable. No outlook issued from stale or cached candles.'}</p>}
          <p className="score-note">4H feed: {h4?.status || 'OFFLINE'} · 1H feed: {h1?.status || 'OFFLINE'}</p>
        </article>
      })}
    </div>}
    <p className="score-note">Rolling technical outlook based on latest completed-candle structure, not a prediction guarantee. Weekly direction can change as new candles form. Cached/offline data is never treated as current.</p>
    {updatedAt && !loading && <p className="chart-foot">Outlook scan: {dateFmt(updatedAt)}</p>}
  </section>
}
function TradeSetupChart({ setup, onClose }: { setup: any; onClose: () => void }) {
 const host=useRef<HTMLDivElement>(null)
 const [candles,setCandles]=useState<Candle[]>([])
 const [note,setNote]=useState('Loading historical candles…')
 const [chartTf,setChartTf]=useState<TF>(setup.tf)
 const [busy,setBusy]=useState(false)
 const digits=['EURUSD','GBPUSD'].includes(setup.symbol)?5:2
 useEffect(()=>{let cancelled=false;setBusy(true);setCandles([]);(async()=>{try{
   const rawTime=setup.candleTime||setup.signal_time||setup.time
   const signalSeconds=typeof rawTime==='number'?Math.floor(rawTime>1e12?rawTime/1000:rawTime):Math.floor(new Date(rawTime).getTime()/1000)
   if(!Number.isFinite(signalSeconds)||signalSeconds<=0)throw Error('Saved signal timestamp is missing; historical movement cannot be verified.')
   const outcomeTime=setup.outcomeAt?Math.floor(new Date(setup.outcomeAt).getTime()/1000):null
   const query=new URLSearchParams({timeframe:chartTf,start:String(signalSeconds)})
   if(outcomeTime&&Number.isFinite(outcomeTime))query.set('end',String(outcomeTime))
   const response=await fetch(API+'/api/v1/market/'+setup.symbol+'/history?'+query.toString(),{cache:'no-store'})
   const payload=await response.json()
   if(!response.ok)throw Error(payload.detail||'Verified historical chart unavailable')
   if(cancelled)return
   if(payload.status==='LIVE'&&Array.isArray(payload.candles)&&payload.candles.length){
     setCandles(payload.candles)
     const sl=Number(setup.stop_loss)
     const touched=payload.candles.some((bar:Candle)=>setup.side==='SELL'?Number(bar.high)>=sl:Number(bar.low)<=sl)
     const targetTouch=(setup.take_profits||[]).some((target:number)=>payload.candles.some((bar:Candle)=>setup.side==='SELL'?Number(bar.low)<=target:Number(bar.high)>=target))
     const outcomeAudit=outcomeTime&&setup.status==='SL_HIT'&&!touched
       ? 'WARNING: the final displayed candle does not touch the saved stop-loss. The recorded outcome needs investigation.'
       : outcomeTime&&setup.status?.startsWith('TP')&&!targetTouch
       ? 'WARNING: the final displayed candle does not touch a saved take-profit. The recorded outcome needs investigation.'
       : ''
     setNote((payload.history_truncated?'History is limited by provider retention. ':'')+(outcomeTime?'Showing candles through the recorded outcome candle.':'Showing candles from signal time to latest provider data.')+(outcomeAudit?' '+outcomeAudit:''))
   }else throw Error('Provider returned no verified candles for this setup.')
 }catch(error){if(!cancelled){setCandles([]);setNote(error instanceof Error?error.message:'Historical chart unavailable')}}finally{if(!cancelled)setBusy(false)}})()
 return()=>{cancelled=true}},[setup.symbol,setup.side,setup.tf,setup.candleTime,setup.signal_time,setup.time,setup.outcomeAt,setup.status,setup.stop_loss,setup.take_profits,chartTf])
 useEffect(()=>{if(!host.current||!candles.length)return
   const chart=createChart(host.current,{autoSize:true,layout:{background:{color:'#10151d'},textColor:'#aab6c8'},grid:{vertLines:{color:'#202936'},horzLines:{color:'#202936'}},rightPriceScale:{borderColor:'#283241'},timeScale:{borderColor:'#283241',timeVisible:true},localization:{priceFormatter:(price:number)=>fmt(price,digits)}})
   const series=chart.addSeries(CandlestickSeries,{upColor:'#22c995',downColor:'#ef6478',borderUpColor:'#22c995',borderDownColor:'#ef6478',wickUpColor:'#22c995',wickDownColor:'#ef6478'})
   series.setData(candles as CandlestickData<Time>[])
   if(setup.entry!=null)series.createPriceLine({price:setup.entry,color:'#e6bd62',lineWidth:2,axisLabelVisible:true,title:'ENTRY'})
   if(setup.stop_loss!=null)series.createPriceLine({price:setup.stop_loss,color:'#ff526b',lineWidth:2,axisLabelVisible:true,title:'STOP LOSS'})
   ;(setup.take_profits||[]).forEach((value:number,index:number)=>series.createPriceLine({price:value,color:'#20d49b',lineWidth:2,axisLabelVisible:true,title:'TP'+(index+1)}))
   if(setup.outcomePrice!=null)series.createPriceLine({price:setup.outcomePrice,color:'#a78bfa',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:'RECORDED EXIT'})
   chart.timeScale().fitContent()
   return()=>chart.remove()
 },[candles,setup,digits])
 return <div className="setup-chart-backdrop" role="dialog" aria-modal="true" aria-label="Trade setup chart"><section className="setup-chart-modal">
   <div className="panel-head"><div><p className="eyebrow">SAVED TRADE SETUP</p><h2>{setup.symbol} · {setup.side} · {String(setup.tf).toUpperCase()}</h2><p className="muted">{dateFmt(setup.time)}</p></div><button className="refresh" onClick={onClose}>Close ✕</button></div>
   <div className="setup-chart-timeframes" role="group" aria-label="Chart timeframe">{(['5m','15m','1h','4h'] as TF[]).map(tf=><button key={tf} className={chartTf===tf?'selected':''} onClick={()=>setChartTf(tf)} disabled={busy}>{tf.toUpperCase()}</button>)}</div>
   <div className="setup-chart-legend"><span className="entry-key">ENTRY</span><span className="sl-key">STOP LOSS</span>{(setup.take_profits||[]).map((_:number,index:number)=><span className="tp-key" key={index}>TP{index+1}</span>)}{setup.outcomePrice!=null&&<span style={{color:'#a78bfa'}}>RECORDED EXIT</span>}</div>
   {candles.length?<div ref={host} className="setup-chart-canvas"/>:<div className="setup-chart-canvas setup-chart-empty">{busy?'Loading verified historical candles…':note}</div>}
   <p className="score-note">{note} Original saved levels are shown, not new recommendations.</p>
   <div className="setup-chart-levels"><article><small>ENTRY</small><b>{fmt(setup.entry,digits)}</b></article><article className="sl-level"><small>STOP LOSS</small><b>{fmt(setup.stop_loss,digits)}</b></article>{(setup.take_profits||[]).map((value:number,index:number)=><article className="tp-level" key={index}><small>TP{index+1}</small><b>{fmt(value,digits)}</b></article>)}</div>
   <p className="score-note">Recorded status: {setup.status||'DETECTED'}{setup.outcomePrice!=null?' · Exit: '+fmt(setup.outcomePrice,digits):''}</p>
 </section></div>
}
export default function App() {
  const [showLaunchScreen, setShowLaunchScreen] = useState(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setShowLaunchScreen(false), 2400)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    // Reveal the React eagle splash only after it has mounted over Android's
    // transparent system launch transition.
    if (Capacitor.isNativePlatform()) {
      void SplashScreen.hide().catch((error) => {
        console.warn('TradeSight native splash could not be dismissed:', error)
      })
    }
  }, [])
  const [activeTab, setActiveTab] = useState<'home' | 'market' | 'forecast' | 'education' | 'trade' | 'settings'>('home')
  type NavTab = 'home' | 'market' | 'forecast' | 'education' | 'trade'
  const [unreadTabs, setUnreadTabs] = useState<NavTab[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('tradesight-unread-tabs-v1') || '[]')
      return Array.isArray(saved) ? saved.filter((tab: string) => ['home','market','forecast','education','trade'].includes(tab)) as NavTab[] : []
    } catch { return [] }
  })
  const markTabViewed = (tab: NavTab) => {
    setUnreadTabs(current => {
      const next = current.filter(item => item !== tab)
      window.localStorage.setItem('tradesight-unread-tabs-v1', JSON.stringify(next))
      return next
    })
    setActiveTab(tab)
  }
  const markNotificationUnread = (type: unknown) => {
    const normalized = String(type || '').toUpperCase()
    const tab: NavTab = normalized === 'SETUP' || normalized === 'SIGNAL' ? 'forecast'
      : normalized === 'STOCK' || normalized === 'MARKET' ? 'market'
      : normalized === 'CAREER' || normalized === 'TECH' || normalized === 'WEB' ? 'education'
      : 'home'
    setUnreadTabs(current => {
      const next = current.includes(tab) ? current : [...current, tab]
      window.localStorage.setItem('tradesight-unread-tabs-v1', JSON.stringify(next))
      return next
    })
  }

  // Notification payloads may target an in-app route or a trusted HTTPS article.
  // Reject other schemes so a notification cannot invoke javascript:/intent: URLs.
  const openNotificationTarget = (value: unknown) => {
    if (typeof value !== 'string') return
    if (value.startsWith('/')) {
      window.location.assign(value)
      return
    }
    try {
      const target = new URL(value)
      if (target.protocol === 'https:') window.location.assign(target.href)
    } catch {
      // Ignore malformed notification destinations.
    }
  }

  const [pageActive, setPageActive] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const syncPageActivity = () => setPageActive(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', syncPageActivity)
    window.addEventListener('focus', syncPageActivity)
    window.addEventListener('blur', syncPageActivity)
    syncPageActivity()
    return () => {
      document.removeEventListener('visibilitychange', syncPageActivity)
      window.removeEventListener('focus', syncPageActivity)
      window.removeEventListener('blur', syncPageActivity)
    }
  }, [])
  const [theme, setTheme] = useState<'light'|'dark'>(() => window.localStorage.getItem('tradesight-theme-v2') === 'light' ? 'light' : 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('tradesight-theme-v2', theme)
  }, [theme])
  const [symbol, setSymbol] = useState<Symbol>('XAUUSD')
  const [timeframe, setTimeframe] = useState<TF>('15m')
  const [data, setData] = useState<Market | null>(null)
  const [homeMarkets, setHomeMarkets] = useState<Record<string, any>>(() => Object.fromEntries((['XAUUSD','BTCUSD','EURUSD','GBPUSD'] as Symbol[]).map(marketSymbol => {
    const saved = readCachedQuote(marketSymbol)
    return [marketSymbol, saved ? { ...saved, status: 'OFFLINE', signal: { trend: 'UNKNOWN' } } : { status: 'OFFLINE', price: null, signal: { trend: 'UNKNOWN' } }]
  })))
  const [allTf, setAllTf] = useState<Partial<Record<TF, Market>>>({})
  const [, setLoading] = useState(true)
  const [lastError, setLastError] = useState('')
  const [history, setHistory] = useState<Array<{ key: string; symbol: string; tf: TF; side: string; time: string; candleTime?: string | null; entry: number | null; stop_loss: number | null; take_profits: number[]; rr: number[] | null; confidence: number | null; trend?: string; reasons: string[]; invalidation?: string; provider?: string; trade_type?: string; entry_style?: string; status?: string; outcomeAt?: string | null; outcomePrice?: number | null; enteredAt?: string | null; reachedTarget?: number | null; targetsHit?: number[] }>>([])
  const [selectedHistoryKey, setSelectedHistoryKey] = useState<string | null>(null)
  const [selectedSetup, setSelectedSetup] = useState<any>(null)
  const [historyStatus, setHistoryStatus] = useState('Connecting to server history…')
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [historyFilter, setHistoryFilter] = useState<'ALL'|'ACTIVE'|'VOID'|'SL_HIT'|'TP_HIT'>('ALL')
  const [overlayEnabled, setOverlayEnabled] = useState(false)
  const [overlayStatus, setOverlayStatus] = useState('Floating panel is off')
  const [pushEnabled, setPushEnabled] = useState(false)
  const fcmTokenRef = useRef<string | null>(null)
  const [pushPreferences, setPushPreferences] = useState<{ news: { nigeria: boolean; africa: boolean; usa: boolean; uk: boolean; global: boolean; economic: boolean; football: boolean }; setups: boolean; stocks: boolean; tech_careers: boolean }>(() => {
    const emptyNews = { nigeria: false, africa: false, usa: false, uk: false, global: false, economic: false, football: false }
    try {
      const saved = JSON.parse(window.localStorage.getItem('tradesight-push-preferences') || '{}')
      return { news: { ...emptyNews, ...(typeof saved.news === 'object' && saved.news ? saved.news : {}) }, setups: saved.setups === true, stocks: saved.stocks === true, tech_careers: saved.tech_careers === true }
    } catch { return { news: emptyNews, setups: false, stocks: false, tech_careers: false } }
  })
  const [pushStatus, setPushStatus] = useState('Push notifications not enabled')
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [fundamentalItems, setFundamentalItems] = useState<FundamentalItem[]>([])
  const [fundamentalStatus, setFundamentalStatus] = useState('Loading verified source feeds…')
  const [fundamentalRefreshing, setFundamentalRefreshing] = useState(false)
  const opportunityRequestInFlight = useRef(false)
  const fundamentalRequestInFlight = useRef(false)
  const [newsRefreshKey, setNewsRefreshKey] = useState(0)
  const [newsCountry, setNewsCountry] = useState('ALL')
  const [newsFocus, setNewsFocus] = useState('ALL')
  const [opportunityItems, setOpportunityItems] = useState<OpportunityItem[]>([])
  const [opportunityStatus, setOpportunityStatus] = useState('Loading technology and career feeds…')
  const [opportunityFilter, setOpportunityFilter] = useState<'ALL' | 'TECH' | 'WEB' | 'JOBS'>('ALL')
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
  const marketRequestId = useRef(0)



  const load = useCallback(async (initial = false) => {
    const requestId = ++marketRequestId.current
    const tfs: TF[] = ['4h', '1h', '15m', '5m']
    // Paint the last verified candles immediately while the free Render service wakes.
    const cachedMarkets: Partial<Record<TF, Market>> = {}
    for (const tf of tfs) {
      try {
        const cached = JSON.parse(window.localStorage.getItem(chartCacheKey(symbol, tf)) || 'null') as { candles?: Candle[]; updated_at?: string | null; provider?: string | null } | null
        if (cached?.candles?.length) cachedMarkets[tf] = {
          symbol, status: 'OFFLINE', price: readCachedQuote(symbol)?.price ?? null, bid: null, ask: null, spread: null,
          updated_at: readCachedQuote(symbol)?.updated_at || cached.updated_at || null, timeframe: tf, candles: cached.candles,
          signal: { ...emptySignal, reasons: ['Showing the last saved chart while fresh data loads.'] },
          provider: cached.provider || undefined,
        }
      } catch {}
    }
    const hasCache = Object.keys(cachedMarkets).length > 0
    if (hasCache) {
      setAllTf(cachedMarkets)
      setData(cachedMarkets[timeframe] || cachedMarkets['15m'] || null)
    }
    if (initial && !hasCache) setLoading(true)
    try {
      // Wake Render in the background; do not make market data wait for the health round trip.
      // The first market request also wakes the service, so all four analysis requests can start immediately.
      void fetch(`${API}/api/v1/health`, { cache: 'no-store' }).catch(() => {})
      const response = await fetch(`${API}/api/v1/market/${symbol}/batch`, { cache: 'no-store' })
      const batch = await response.json() as { timeframes?: Record<TF, Market>; provider_errors?: Record<string, string> }
      if (!response.ok && response.status !== 503) throw new Error((batch as any)?.detail || `API error ${response.status}`)
      if (requestId !== marketRequestId.current) return
      const next = batch.timeframes as Record<TF, Market>
      if (!next || !tfs.every(tf => next[tf])) throw new Error('Batch market response is incomplete.')
      for (const tf of tfs) {
        const market = next[tf]
        const key = chartCacheKey(symbol, tf)
        if (market.status === 'LIVE' && market.candles?.length) {
          try { window.localStorage.setItem(key, JSON.stringify({ candles: market.candles, savedAt: new Date().toISOString(), updated_at: market.updated_at, provider: market.provider || null })) } catch {}
        } else if (!market.candles?.length) {
          const cached = cachedMarkets[tf]
          if (cached?.candles?.length) {
            market.candles = cached.candles
            market.updated_at = cached.updated_at || null
            market.provider = cached.provider || market.provider
          }
        }
      }
      const savedQuote = readCachedQuote(symbol)
      for (const tf of tfs) {
        const market = next[tf]
        if (market.status !== 'LIVE' || market.price == null) {
          market.price = savedQuote?.price ?? (typeof market.price === 'number' ? market.price : null)
          if (savedQuote?.updated_at) market.updated_at = savedQuote.updated_at
        }
      }
      const primaryQuote = next['15m']
      if (primaryQuote?.status === 'LIVE' && typeof primaryQuote.price === 'number' && Number.isFinite(primaryQuote.price)) {
        try { window.localStorage.setItem(quoteCacheKey(symbol), JSON.stringify({ price: primaryQuote.price, updated_at: primaryQuote.updated_at || new Date().toISOString(), provider: primaryQuote.provider || null })) } catch {}
      }
      setAllTf(next)
      setData(next[timeframe])
      setUpdatedAt(next[timeframe].updated_at)
      setLastError(next[timeframe].status === 'LIVE' ? '' : (next[timeframe].signal?.reasons?.[0] || 'Live feed unavailable.'))
    } catch (e) {
      if (requestId !== marketRequestId.current) return
      if (!hasCache) {
        setData({ symbol, status: 'OFFLINE', price: null, bid: null, ask: null, spread: null, updated_at: null, candles: [], timeframe, signal: { ...emptySignal, reasons: [e instanceof Error ? e.message : 'API is unreachable.'] } })
      }
      setLastError(e instanceof Error ? e.message : 'API is unreachable.')
    } finally {
      if (requestId === marketRequestId.current) setLoading(false)
    }
  }, [symbol, timeframe])

  useEffect(() => { if (activeTab !== 'forecast' && activeTab !== 'home') return; void load(true); const id = window.setInterval(() => void load(false), 30000); return () => window.clearInterval(id) }, [load, activeTab])

  useEffect(() => {
    if (activeTab !== 'home') return
    let cancelled = false
    const refreshHomeMarkets = async () => {
      const symbols: Symbol[] = ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD']
      const results = await Promise.all(symbols.map(async marketSymbol => {
        try {
          const response = await fetch(`${API}/api/v1/market/${marketSymbol}/batch`, { cache: 'no-store' })
          const json = await response.json()
          if (!response.ok) throw new Error(json.detail || 'Market feed unavailable')
          const market = json.timeframes?.['15m'] || json.market || json
          if (market.status === 'LIVE' && typeof market.price === 'number' && Number.isFinite(market.price)) {
            try { window.localStorage.setItem(quoteCacheKey(marketSymbol), JSON.stringify({ price: market.price, updated_at: market.updated_at || new Date().toISOString(), provider: market.provider || null })) } catch {}
            return [marketSymbol, market] as const
          }          const saved = readCachedQuote(marketSymbol)
          return [marketSymbol, { ...market, status: market.status === 'MARKET_CLOSED' ? 'MARKET_CLOSED' : 'OFFLINE', price: saved?.price ?? (typeof market.price === 'number' ? market.price : null), updated_at: saved?.updated_at || market.updated_at || null, last_known: Boolean(saved) }] as const
        } catch (error) {
          const saved = readCachedQuote(marketSymbol)
          return [marketSymbol, { status: 'OFFLINE', price: saved?.price ?? null, updated_at: saved?.updated_at || null, last_known: Boolean(saved), error: error instanceof Error ? error.message : 'Feed unavailable' }] as const
        }
      }))
      if (!cancelled) setHomeMarkets(Object.fromEntries(results))
    }
    void refreshHomeMarkets()
    const id = window.setInterval(() => void refreshHomeMarkets(), 30000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [activeTab])

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
            entry_style: typeof item.entry_style === 'string' ? item.entry_style : 'STANDARD',
            status: typeof item.status === 'string' ? item.status : 'DETECTED',
            outcomeAt: item.outcome_at || null,
            outcomePrice: typeof item.outcome_price === 'number' ? item.outcome_price : null,
            enteredAt: item.entered_at || null,
            reachedTarget: typeof item.reached_target === 'number' ? item.reached_target : null,
            targetsHit: Array.isArray(item.targets_hit) ? item.targets_hit.map(Number).filter(Number.isInteger) : [],
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
    const loadOpportunities = async () => {
      if (opportunityRequestInFlight.current) return
      opportunityRequestInFlight.current = true
      try {
        const response = await fetch(API + '/api/v1/opportunities/news?limit=80', { cache: 'no-store' })
        const json = await response.json() as { status: string; updated_at?: string; items: OpportunityItem[]; feeds: Array<{source: string; status: string}> }
        if (!response.ok) throw new Error('Tech and careers feed error ' + response.status)
        if (!cancelled) {
          setOpportunityItems(Array.isArray(json.items) ? json.items : [])
          const live = (json.feeds || []).filter(feed => feed.status === 'LIVE').length
          setOpportunityStatus(json.items?.length ? json.items.length + ' updates · ' + live + '/' + (json.feeds?.length || 0) + ' sources live' : 'No updates returned; feeds may be temporarily unavailable.')
        }
      } catch (error) {
        if (!cancelled) setOpportunityStatus(error instanceof Error ? error.message : 'Tech and careers feed unavailable.')
      } finally {
        opportunityRequestInFlight.current = false
      }
    }
    void loadOpportunities()
    const id = window.setInterval(() => void loadOpportunities(), 60000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadFundamentals = async (forceRefresh = false) => {
      if (fundamentalRequestInFlight.current) return
      fundamentalRequestInFlight.current = true
      if (!cancelled) setFundamentalRefreshing(true)
      try {
        const refreshQuery = forceRefresh ? '&refresh=true' : ''
        const response = await fetch(`${API}/api/v1/fundamentals/news?limit=30${refreshQuery}`, { cache: 'no-store' })
        const json = await response.json() as { status: string; updated_at: string; items: FundamentalItem[]; feeds: Array<{source: string; status: string; count: number; error?: string | null}>; note?: string }
        if (!response.ok) throw new Error(`Fundamental feed error ${response.status}`)
        if (!cancelled) {
          setFundamentalItems(Array.isArray(json.items) ? json.items : [])
          const liveFeeds = (json.feeds || []).filter(feed => feed.status === 'LIVE').length
          setFundamentalStatus(json.items?.length ? `${json.items.length} headlines · ${liveFeeds}/${json.feeds?.length || 0} sources live` : 'No headlines returned; sources may be temporarily unavailable.')
        }
      } catch (error) {
        if (!cancelled) setFundamentalStatus(error instanceof Error ? error.message : 'Fundamental news is unavailable.')
      } finally {
        fundamentalRequestInFlight.current = false
        if (!cancelled) setFundamentalRefreshing(false)
      }
    }
    void loadFundamentals(newsRefreshKey > 0)
    const id = window.setInterval(() => void loadFundamentals(false), 60000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [newsRefreshKey])

  useEffect(() => {
    let cancelled = false
    const loadNgx = async () => {
      setNgxStatus(`Loading ${stockCountry} market data…`)
      try {
        // Nigeria has a dedicated NGX provider; other markets use the multi-country screener.
        const endpoint = stockCountry === 'NG'
          ? '/api/v1/ngx/intelligence'
          : `/api/v1/stocks/intelligence?country=${encodeURIComponent(stockCountry)}`
        const response = await fetch(`${API}${endpoint}`, { cache: 'no-store' })
        const raw = await response.text()
        let json: any
        try { json = raw ? JSON.parse(raw) : {} } catch { throw new Error(`Stock service returned an invalid response (${response.status}).`) }
        if (!response.ok) throw new Error(json?.detail || `Stock API error ${response.status}`)
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Stock service returned an unexpected data format.')
        const normalized = stockCountry === 'NG' ? {
          ...json,
          currency: 'NGN',
          market: json.market && typeof json.market === 'object' ? json.market : null,
          watchlist: Array.isArray(json.watchlist) ? json.watchlist.map((stock: any) => ({
            ...stock,
            ticker: stock.symbol || stock.ticker,
            change20_pct: stock.change_percent ?? stock.change20_pct,
            technical_score: stock.analysis?.score ?? stock.technical_score,
            signal: stock.analysis?.status || stock.signal || 'WAIT — INSUFFICIENT DATA',
            trend: stock.analysis?.status || stock.trend || 'UNKNOWN',
            reason: stock.analysis?.reason || stock.reason || 'NGX provider snapshot; no verified multi-session technical history.',
            fresh: false,
            history_bars: 0,
            holding_horizon: stock.analysis?.suggested_horizon || stock.holding_horizon || 'Not assigned',
          })) : [],
        } : {
          ...json,
          market: typeof json.market === 'string' ? json.market : (typeof json.market?.name === 'string' ? json.market.name : 'International market'),
          watchlist: Array.isArray(json.watchlist) ? json.watchlist : [],
        }
        // Treat provider payloads as untrusted display data. A malformed row must not
        // crash the entire Stock Intelligence section during React rendering.
        normalized.watchlist = normalized.watchlist
          .filter((stock: any) => stock && typeof stock === 'object' && !Array.isArray(stock))
          .map((stock: any) => {
            const finiteNumber = (value: unknown): number | null => {
              const number = typeof value === 'number' ? value : Number(value)
              return Number.isFinite(number) ? number : null
            }
            const textValue = (value: unknown, fallback: string): string =>
              typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
            return {
              ...stock,
              ticker: textValue(stock.ticker ?? stock.symbol, 'UNKNOWN'),
              name: textValue(stock.name, textValue(stock.ticker ?? stock.symbol, 'Unknown company')),
              price: finiteNumber(stock.price),
              change20_pct: finiteNumber(stock.change20_pct),
              rsi14: finiteNumber(stock.rsi14),
              technical_score: finiteNumber(stock.technical_score),
              history_bars: finiteNumber(stock.history_bars) ?? 0,
              signal: textValue(stock.signal, 'WAIT — INSUFFICIENT DATA'),
              trend: textValue(stock.trend, 'UNKNOWN'),
              reason: textValue(stock.reason, 'No additional research notes supplied.'),
              holding_horizon: textValue(stock.holding_horizon, 'Not assigned'),
            }
          })
        if (!cancelled) {
          setNgxData(normalized)
          setNgxStatus(normalized.note || (normalized.watchlist.length ? 'Stock data loaded' : 'No usable stock data returned for this market.'))
        }
      } catch (error) {
        if (!cancelled) {
          setNgxData({ status: 'OFFLINE', country: stockCountry, market: stockCountry === 'NG' ? 'NGX' : 'International market', watchlist: [], currency: stockCountry === 'NG' ? 'NGN' : '—', note: error instanceof Error ? error.message : 'Stock data unavailable.' })
          setNgxStatus(error instanceof Error ? error.message : 'Stock data unavailable.')
        }
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
  const demoEquity = Number(demoAccount?.balance ?? 300000) + demoUnrealizedPnl
  const current = data?.symbol === symbol && data?.timeframe === timeframe ? data : allTf[timeframe] ?? data
  const isLive = current?.status === 'LIVE' && current.price != null
  const digits = symbol === 'EURUSD' || symbol === 'GBPUSD' ? 5 : symbol === 'BTCUSD' ? 2 : Math.min(current?.digits ?? 2, 2)
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
  // Native Android uses Firebase Cloud Messaging; browser/PWA keeps Web Push.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
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
              setPushStatus('No device subscription found. Enable browser push notifications.')
            }
            return
          }
          const response = await fetch(`${API}/api/v1/push/subscribe`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...subscription.toJSON(), preferences: pushPreferences })
          })
          if (!response.ok) throw new Error('Could not sync the existing device subscription with TradeSight.')
          if (!cancelled) {
            setPushEnabled(true)
            setPushStatus('This device is connected. Category approvals are controlled separately below.')
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
    }

    let active = true
    let handles: Array<{ remove: () => Promise<void> }> = []
    const saveNativeToken = async (token: Token) => {
      fcmTokenRef.current = token.value
      try {
        const response = await fetch(`${API}/api/v1/push/fcm/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.value, preferences: pushPreferences })
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.detail || 'Could not register this Android device with TradeSight.')
        if (active) {
          setPushEnabled(true)
          setPushStatus('This Android device is connected to Firebase notifications.')
        }      } catch (error) {
        if (active) {
          setPushEnabled(false)
          setPushStatus(error instanceof Error ? error.message : 'Could not register the Firebase device token.')
        }
      }
    }
    void (async () => {
      try {
        await LocalNotifications.createChannel({
          id: 'tradesight-alerts-v2',
          name: 'TradeSight priority alerts',
          description: 'High-priority trading setups, breaking market news and career updates',
          importance: 5,
          visibility: 1,
          sound: 'default',
          vibration: true,
          lights: true,
          lightColor: '#27d6a0',
        })
      } catch (error) {
        console.warn('Could not create TradeSight notification channel', error)
      }
      handles = await Promise.all([
        PushNotifications.addListener('registration', saveNativeToken),
        PushNotifications.addListener('registrationError', error => {
          if (active) setPushStatus(`Firebase registration failed: ${error.error || 'Unknown error'}`)
        }),
        PushNotifications.addListener('pushNotificationReceived', notification => {
          if (!active) return
          setPushStatus(`Notification received: ${notification.title || 'TradeSight alert'}`)
          markNotificationUnread(notification.data?.type)
          // Android does not automatically show FCM notification payloads while the
          // app is foregrounded. Re-present them through the native notification API.
          void LocalNotifications.schedule({
            notifications: [{
              id: Math.floor(Date.now() % 2147483000),
              title: notification.title || 'TradeSight alert',
              body: notification.body || 'You have a new TradeSight update.',
              channelId: 'tradesight-alerts-v2',
              schedule: { at: new Date(Date.now() + 250) },
              sound: 'default',
              smallIcon: 'ic_stat_icon_config_sample',
              extra: notification.data || {},
            }]
          }).catch(error => setPushStatus(`Notification arrived, but Android could not display it: ${String(error)}`))
        }),
        PushNotifications.addListener('pushNotificationActionPerformed', action => {
          openNotificationTarget(action.notification.data?.url)
        }),
        // Foreground FCM messages are re-presented as local notifications above;
        // their taps arrive through LocalNotifications, not the FCM action listener.
        LocalNotifications.addListener('localNotificationActionPerformed', action => {
          const extra = action.notification.extra as Record<string, unknown> | undefined
          openNotificationTarget(extra?.url)        }),
      ])
    })()
    return () => {
      active = false
      handles.forEach(handle => { void handle.remove() })
    }
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !overlayEnabled) return
    void TradeSightOverlay.update({
      symbol,
      price: data?.price == null ? 'Price unavailable' : fmt(data.price, symbol === 'BTCUSD' ? 2 : 3),
      signal: data?.signal?.status || 'NO SETUP',
    }).catch(error => setOverlayStatus(error instanceof Error ? error.message : 'Could not update floating panel.'))
  }, [overlayEnabled, symbol, data?.price, data?.signal?.status])

  const toggleFloatingOverlay = async () => {
    if (!Capacitor.isNativePlatform()) {
      setOverlayStatus('Floating panel is available in the Android app only.')
      return
    }
    try {
      if (overlayEnabled) {
        await TradeSightOverlay.stop()
        setOverlayEnabled(false)
        setOverlayStatus('Floating panel stopped.')
        return
      }
      const permission = await TradeSightOverlay.checkPermission()
      if (!permission.granted) {
        await TradeSightOverlay.requestPermission()
        setOverlayStatus('Allow TradeSight in Android Display over other apps, then return and tap Enable floating panel again.')
        return
      }
      await TradeSightOverlay.start({
        symbol,
        price: data?.price == null ? 'Price unavailable' : fmt(data.price, symbol === 'BTCUSD' ? 2 : 3),
        signal: data?.signal?.status || 'NO SETUP',
      })
      setOverlayEnabled(true)
      setOverlayStatus('Floating panel is active. Drag it to move; tap × to close.')
    } catch (error) {
      setOverlayStatus(error instanceof Error ? error.message : 'Could not start floating panel.')
    }
  }

  const updatePushPreference = async (category: 'setups' | 'stocks' | 'news' | 'tech_careers', enabled: boolean, newsKey?: keyof typeof pushPreferences.news) => {
    let next = pushPreferences
    if (category === 'news') {
      if (!newsKey) return
      next = { ...pushPreferences, news: { ...pushPreferences.news, [newsKey]: enabled } }
    } else if (category === 'setups') {
      next = { ...pushPreferences, setups: enabled }
    } else if (category === 'stocks') {
      next = { ...pushPreferences, stocks: enabled }
    } else {
      next = { ...pushPreferences, tech_careers: enabled }
    }
    setPushPreferences(next)
    window.localStorage.setItem('tradesight-push-preferences', JSON.stringify(next))
    try {
      if (Capacitor.isNativePlatform()) {
        if (!fcmTokenRef.current) return
        const response = await fetch(`${API}/api/v1/push/fcm/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: fcmTokenRef.current, preferences: next })
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.detail || 'Could not sync notification preferences.')
        setPushStatus('Your notification choices have been saved for this Android device.')
        return
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
      const registration = await navigator.serviceWorker.register('/sw.js')
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) return
      const response = await fetch(`${API}/api/v1/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subscription.toJSON(), preferences: next })
      })
      if (!response.ok) throw new Error('Could not sync notification preferences with the server.')
      setPushStatus('Your notification choices have been saved for this device.')
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : 'Could not save notification preferences.')
    }
  }

  const enablePushNotifications = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        let permission = await PushNotifications.checkPermissions()
        if (permission.receive !== 'granted') permission = await PushNotifications.requestPermissions()
        let localPermission = await LocalNotifications.checkPermissions()
        if (localPermission.display !== 'granted') localPermission = await LocalNotifications.requestPermissions()
        if (permission.receive !== 'granted' || localPermission.display !== 'granted') {
          setPushStatus('Android notification permission was not granted. Enable it in Android Settings to continue.')
          return
        }
        setPushStatus('Connecting this Android device to Firebase…')
        await PushNotifications.register()
        return
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setPushStatus('This browser does not support web push. Install/open TradeSight in Chrome on Android.')
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setPushStatus('Notification permission was not granted.')
        return
      }
      const keyResponse = await fetch(`${API}/api/v1/push/public-key`, { cache: 'no-store' })
      const keyJson = await keyResponse.json()
      if (!keyResponse.ok || !keyJson.enabled || !keyJson.public_key) throw new Error(keyJson.note || 'Web Push is not fully configured on the server yet.')
      const decodeKey = (value: string) => {
        const padding = '='.repeat((4 - value.length % 4) % 4)
        const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
        return Uint8Array.from(raw, char => char.charCodeAt(0))
      }
      const registration = await navigator.serviceWorker.register('/sw.js')
      const existingSubscription = await registration.pushManager.getSubscription()
      const subscription = existingSubscription || await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: decodeKey(keyJson.public_key)
      })
      const saveResponse = await fetch(`${API}/api/v1/push/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subscription.toJSON(), preferences: pushPreferences })
      })
      if (!saveResponse.ok) {
        const error = await saveResponse.json().catch(() => ({}))
        throw new Error(error.detail || 'Could not save this device subscription.')
      }
      setPushEnabled(true)
      setPushStatus('This device is subscribed to trading setup and news alerts.')
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : 'Could not enable push notifications.')
    }
  }

  const sendPushTest = async () => {
    setPushTestBusy(true)
    setPushStatus('Sending a test notification to this device…')
    try {
      if (Capacitor.isNativePlatform()) {
        if (!fcmTokenRef.current) throw new Error('This Android device has not registered with Firebase yet. Tap Connect notifications first.')
        const response = await fetch(`${API}/api/v1/push/fcm/test`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: fcmTokenRef.current })
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.detail || 'Firebase test notification failed.')
        setPushStatus('Firebase accepted the test message. If TradeSight is open, it should now appear as a foreground notification; otherwise check Android notification history.')
      } else {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support Web Push.')
        const registration = await navigator.serviceWorker.register('/sw.js')
        const subscription = await registration.pushManager.getSubscription()
        if (!subscription) throw new Error('No device subscription found. Enable browser notifications again.')
        const response = await fetch(`${API}/api/v1/push/test`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription)
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.detail || 'The test notification could not be sent.')
        setPushStatus('Test notification accepted by the push provider. Check your notification shade.')
      }
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : 'Could not send the test notification.')
    } finally {
      setPushTestBusy(false)
    }
  }

  const latestSavedSetup = [...history].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0] || null
  const latestNews = [...fundamentalItems].sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime()).slice(0, 3)

  useEffect(() => {
    const attachCollapseControls = () => {
      document.querySelectorAll<HTMLElement>('section.panel').forEach((panel, index) => {
        const header = panel.querySelector<HTMLElement>('.panel-head')
        if (!header || header.querySelector('.collapse-toggle')) return
        const title = header.querySelector('h2')?.textContent?.trim() || header.querySelector('.eyebrow')?.textContent?.trim() || `section-${index}`
        const key = `tradesight-section-collapsed:${title}`
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'collapse-toggle'
        button.textContent = localStorage.getItem(key) === '1' ? 'Expand' : 'Collapse'
        button.setAttribute('aria-expanded', localStorage.getItem(key) === '1' ? 'false' : 'true')
        if (localStorage.getItem(key) === '1') panel.classList.add('is-collapsed')
        button.addEventListener('click', () => {
          const collapsed = panel.classList.toggle('is-collapsed')
          button.textContent = collapsed ? 'Expand' : 'Collapse'
          button.setAttribute('aria-expanded', String(!collapsed))
          localStorage.setItem(key, collapsed ? '1' : '0')
        })
        header.appendChild(button)
      })
    }
    attachCollapseControls()
    const observer = new MutationObserver(attachCollapseControls)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestedSymbol = params.get('setup')
    const requestedTf = params.get('tf')
    const requestedTime = params.get('signal_time')
    if (!requestedSymbol || !requestedTf || !requestedTime || !history.length) return
    const match = history.find(item => item.symbol === requestedSymbol && item.tf === requestedTf && item.candleTime === requestedTime)
    if (match) { setActiveTab('forecast'); setSelectedSetup(match); setSelectedHistoryKey(match.key); window.history.replaceState({}, '', window.location.pathname) }
  }, [history])

  const switchMarket = (s: Symbol) => {
    setSymbol(s)
    setLastError('')
    const cached: Partial<Record<TF, Market>> = {}
    for (const tf of ['4h', '1h', '15m', '5m'] as TF[]) {
      try {
        const saved = JSON.parse(window.localStorage.getItem(chartCacheKey(s, tf)) || 'null') as { candles?: Candle[]; updated_at?: string | null; provider?: string | null } | null
        if (saved?.candles?.length) cached[tf] = {
          symbol: s, status: 'OFFLINE', price: readCachedQuote(s)?.price ?? null, bid: null, ask: null, spread: null,
          updated_at: readCachedQuote(s)?.updated_at || saved.updated_at || null, timeframe: tf, candles: saved.candles,
          signal: { ...emptySignal, reasons: ['Showing the last saved chart while fresh data loads.'] },
          provider: saved.provider || undefined,
        }
      } catch {}
    }
    setAllTf(cached)
    setData(cached[timeframe] || cached['15m'] || null)
    setLoading(!Object.keys(cached).length)
  }
  const marketOrder: Symbol[] = isStandardFxSessionClosed('XAUUSD')
    ? ['BTCUSD', 'XAUUSD', 'EURUSD', 'GBPUSD']
    : ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD']
  const marketLabels: Record<Symbol, string> = { XAUUSD: '✦ GOLD', BTCUSD: '₿ BITCOIN', EURUSD: '🇪🇺 EUR/USD', GBPUSD: '🇬🇧 GBP/USD' }
  const stockOverview = stockCountry === 'NG'
    ? {
        benchmark: { name: 'NGX All-Share Index', value: ngxData?.market?.asi ?? null, change1d_pct: ngxData?.market?.pct_change ?? null },
        market_cap: ngxData?.market?.market_cap ?? null,
        advancers: ngxData?.market?.advancers ?? null,
        decliners: ngxData?.market?.decliners ?? null,
        breadth_basis: 'Full NGX market snapshot',
        volume: ngxData?.market?.volume ?? null,
        volume_basis: 'Full NGX market snapshot',
      }
    : (ngxData?.overview || {})
  const stockCurrency = ngxData?.currency || (stockCountry === 'NG' ? 'NGN' : '')
  const formatStockNumber = (value: unknown, digits = 2) => typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: digits })
    : '—'
  return <main className="shell">
    {showLaunchScreen && <div className="tradesight-launch-screen" role="status" aria-label="Launching TradeSight"><img src="/tradesight-splash.png" alt="TradeSight — Markets Beyond Borders" /><span className="tradesight-launch-spinner" /><span className="tradesight-launch-label">Loading TradeSight...</span></div>}
    {selectedSetup && <TradeSetupChart setup={selectedSetup} onClose={() => setSelectedSetup(null)} />}
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark"><img src="/tradesight-header-logo.png" alt="TradeSight — Markets Beyond Borders" /></span><span>TradeSight<small>REAL-TIME MARKET INTELLIGENCE</small></span></a><div className="topbar-actions"><div className={`status ${pageActive ? 'is-live' : 'is-offline'}`}><span className="dot" />{pageActive ? 'ONLINE' : 'AWAY'} <span className="divider">|</span> <span>{pageActive ? 'App active' : 'App in background'}</span></div><button type="button" className={`header-settings-button ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab(activeTab === 'settings' ? 'home' : 'settings')} aria-label="Open settings" title="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="m19.4 13.8 1.1.9-1.5 2.6-1.4-.6a7.8 7.8 0 0 1-1.5.9l-.3 1.5h-3l-.3-1.5a7.8 7.8 0 0 1-1.5-.9l-1.4.6-1.5-2.6 1.1-.9a7.7 7.7 0 0 1 0-1.8l-1.1-.9 1.5-2.6 1.4.6a7.8 7.8 0 0 1 1.5-.9l.3-1.5h3l.3 1.5a7.8 7.8 0 0 1 1.5.9l1.4-.6 1.5 2.6-1.1.9a7.7 7.7 0 0 1 0 1.8Z"/></svg></button></div></header>
    <section className="home-dashboard" style={{display: activeTab === 'home' ? 'block' : 'none'}}>
      <div className="tab-hero home-hero-art"><img src="/tradesight-home-hero.jpg" alt="TradeSight overview: Market at a glance. Four markets. One clear view. Fresh data only." /></div>
      <section className="home-market-board">
        <div className="home-board-heading"><div><p className="eyebrow">LIVE MARKET WATCH</p><h2>Markets</h2></div><button className="refresh" onClick={() => void load(true)}>↻ Refresh</button></div>
        <div className="home-market-grid">
          {(['XAUUSD','BTCUSD','EURUSD','GBPUSD'] as Symbol[]).map(marketSymbol => {
            const quote = homeMarkets[marketSymbol]
            const live = quote?.status === 'LIVE' && quote?.price != null
            const marketDigits = marketSymbol === 'EURUSD' || marketSymbol === 'GBPUSD' ? 5 : 2
            const trend = quote?.signal?.trend || 'UNKNOWN'
            return <button type="button" key={marketSymbol} className={'home-market-tile ' + (symbol === marketSymbol ? 'selected' : '')} onClick={() => { switchMarket(marketSymbol); setActiveTab('forecast') }}>
              <span className="home-market-tile-top"><b>{marketSymbol}</b><i className={live ? 'quote-live' : 'quote-offline'}>{live ? 'LIVE' : quote?.status === 'MARKET_CLOSED' ? 'MARKET CLOSED' : 'OFFLINE'}</i></span>
              <strong className={live ? 'live-price-value' : !live && typeof quote?.price !== 'number' && isStandardFxSessionClosed(marketSymbol) ? 'market-closed-value' : ''}>{typeof quote?.price === 'number' ? fmt(quote.price, marketDigits) : isStandardFxSessionClosed(marketSymbol) ? 'MARKET CLOSED' : 'OFFLINE'}</strong>{!live && typeof quote?.price !== 'number' && isStandardFxSessionClosed(marketSymbol) && <MarketOpensCountdown symbol={marketSymbol} />}
              <span className="home-market-tile-bottom"><small>{marketSymbol === 'XAUUSD' ? 'GOLD' : marketSymbol === 'BTCUSD' ? 'BITCOIN' : marketSymbol === 'EURUSD' ? 'EURO / USD' : 'GBP / USD'}</small><small>{!live && typeof quote?.price === 'number' ? 'Last: ' + dateFmt(quote.updated_at || null) : trend === 'UNKNOWN' ? 'Trend unavailable' : trend}</small></span>
            </button>
          })}
        </div>
      </section>
      <section className="panel home-chart-panel">
        <div className="panel-head"><div><p className="eyebrow">PRICE ACTION · {symbol}</p><h2>{symbol === 'XAUUSD' ? 'Gold' : symbol === 'BTCUSD' ? 'Bitcoin' : symbol === 'EURUSD' ? 'Euro / US Dollar' : 'British Pound / US Dollar'} chart</h2><p className="muted">{isLive ? 'Live provider candles' : 'Live feed unavailable · showing saved candles only'}</p></div><button className="refresh" onClick={() => setActiveTab('forecast')}>Full analysis ↗</button></div>
        <div className="home-chart-controls"><div className="home-symbol-picker">{(['XAUUSD','BTCUSD','EURUSD','GBPUSD'] as Symbol[]).map(marketSymbol => <button key={marketSymbol} className={symbol === marketSymbol ? 'selected' : ''} onClick={() => switchMarket(marketSymbol)}>{marketSymbol}</button>)}</div><div className="timeframes">{(['5m','15m','1h','4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div></div>
        <div className="home-chart-price"><strong>{isLive ? fmt(current?.price, digits) : typeof current?.price === 'number' ? fmt(current.price, digits) : 'OFFLINE'}</strong><span className={isLive ? 'quote-live' : 'quote-offline'}>{isLive ? 'LIVE PRICE' : typeof current?.price === 'number' ? 'OFFLINE · LAST KNOWN PRICE' : isStandardFxSessionClosed(symbol) ? 'MARKET CLOSED' : 'FEED OFFLINE'}</span></div>
        {current?.candles?.length ? <PriceChart data={current.candles} digits={digits} /> : <div className="chart-offline">{isWeekendMarketClosed() && symbol !== 'BTCUSD' ? <><b>Enjoy your weekend!</b><p>The market is closed for the weekend. Take a break — we'll be here when trading resumes.</p><MarketOpensCountdown symbol={symbol} /></> : <><b>No verified candles available</b><p>{lastError || 'The chart will appear when the provider returns fresh candles.'}</p>{isStandardFxSessionClosed(symbol) && <MarketOpensCountdown symbol={symbol} />}</>}</div>}
        <p className="chart-foot">{isLive ? 'Last update: ' + dateFmt(updatedAt) : 'No live quote or new signal is being inferred from cached data.'}</p>
      </section>
      <div className="home-glance-grid">
        <article className="panel home-glance-card"><span className="eyebrow">MOST RECENT FORECAST SENT</span>
          {latestSavedSetup ? <><div className="home-signal-row"><b className={latestSavedSetup.side === 'BUY' ? 'green' : 'red'}>{latestSavedSetup.side}</b><small>{latestSavedSetup.symbol} · {latestSavedSetup.tf.toUpperCase()}</small></div>
            <div className="home-levels"><span>ENTRY <b>{fmt(latestSavedSetup.entry, 2)}</b></span><span>STOP <b>{fmt(latestSavedSetup.stop_loss, 2)}</b></span>{latestSavedSetup.take_profits.slice(0,3).map((tp,i)=><span key={i}>TP{i+1} <b>{fmt(tp,2)}</b></span>)}</div>
            <p>Recorded: {dateFmt(latestSavedSetup.time)} · Signal candle: {dateFmt(latestSavedSetup.candleTime || null)}</p>
          </> : <><b>NO RECORDED SETUP</b><p>No confirmed BUY/SELL forecast has been recorded yet. The live forecast is available in the Forecast tab.</p></>}
          <small>Historical alert snapshot · Check the current market before acting.</small>
          <button className="refresh" onClick={() => setActiveTab('forecast')}>Open current forecast</button>
        </article>
        <article className="panel home-glance-card"><span className="eyebrow">DEMO ACCOUNT · PAPER TRADING</span><strong className="home-balance">{demoAccount ? `₦${fmt(demoAccount.balance,2)}` : 'Loading balance…'}</strong><p>Starting balance ₦300,000 · Realized P/L: ₦{fmt(demoAccount?.realized_pnl ?? 0,2)}</p><small>Open positions: {demoAccount?.open_count ?? '—'} / 3 · Risk: {demoAccount?.risk_per_trade_pct ?? 1}%</small><button className="refresh" onClick={() => setActiveTab('trade')}>Open demo account</button></article>
      </div>
      <section className="panel history-panel home-signal-history">
        <div className="panel-head"><div><p className="eyebrow">RECENT SETUPS · PRICE-TRACKED</p><h2>Signal history</h2></div><span className="history-count">{history.length} saved</span></div>
        {history.length ? <div className="home-history-list">{[...history].sort((a,b)=>new Date(b.time).getTime()-new Date(a.time).getTime()).slice(0,5).map(item => <button type="button" className="home-history-row" key={item.key} onClick={() => { setSelectedHistoryKey(item.key); setSelectedSetup(item) }}>
          <span className={item.side === 'BUY' ? 'buy' : 'sell'}>{item.side}</span>
          <b className="home-history-symbol" style={{color:theme === 'light' ? '#26364d' : '#e8eef7',fontWeight:800}}>{item.symbol}</b>
          <span className="home-history-entry" style={{color:theme === 'light' ? '#26364d' : '#dce6f1',fontWeight:650}}>{item.entry == null ? '—' : fmt(item.entry, ['EURUSD','GBPUSD'].includes(item.symbol) ? 5 : 2)}</span>
          <span className={`history-outcome outcome-${(item.status || 'DETECTED').toLowerCase()}`}>{item.status === 'DETECTED' ? 'WAITING ENTRY' : (item.status === 'ACTIVE' && item.reachedTarget ? `ACTIVE · TP${item.reachedTarget} HIT` : (item.status || 'UNKNOWN').replace('_',' '))}</span>
          <span className="home-history-meta">{item.tf.toUpperCase()} · {dateFmt(item.time)} <span>View chart ↗</span></span>
        </button>)}</div> : <div className="history-empty">No saved setups yet. {historyStatus}</div>}
        {history.length > 5 && <button className="refresh history-toggle" onClick={() => setActiveTab('forecast')}>View more</button>}
      </section>
      <div className="panel home-news"><div className="panel-head"><div><p className="eyebrow">LATEST UPDATES</p><h2>Market news</h2></div><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}><span className="history-count">{fundamentalItems.length} headlines</span><button type="button" className="refresh news-refresh-button" onClick={() => setNewsRefreshKey(value => value + 1)} disabled={fundamentalRefreshing} aria-label="Refresh market news" title="Refresh market news" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6,minWidth:38,minHeight:34,padding:"6px 10px"}}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{animation:fundamentalRefreshing ? "spin 1s linear infinite" : "none"}}><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></svg>{fundamentalRefreshing ? "Refreshing" : "Refresh"}</button></div></div>
        <p className="chart-foot" style={{textAlign:'right',marginTop:-8}}>News automatically refreshes every minute.</p>
        {latestNews.length ? latestNews.map(item => <article className="home-news-item" key={item.id}><img className="home-news-image" src={item.image_url || item.source_image_url || ''} onError={event => { if (item.source_image_url && event.currentTarget.src !== item.source_image_url) event.currentTarget.src = item.source_image_url }} alt="" loading="lazy" /><div className="news-meta"><span>{item.country === 'NG' ? '🇳🇬' : item.country === 'US' ? '🇺🇸' : item.country === 'GB' ? '🇬🇧' : item.country === 'EU' ? '🇪🇺' : item.country === 'AF' ? '🌍' : '🌍'}</span><b>{item.source}</b><time>{dateFmt(item.published_at)}</time></div><a href={item.url} target="_blank" rel="noreferrer" className="news-title">{item.title}</a><p className="muted">{decodeHtmlEntities(item.summary)}</p></article>) : <p className="muted">{fundamentalStatus}</p>}
        <button className="refresh" onClick={() => setActiveTab('forecast')}>See all news & forecasts</button>
      </div>
    <WeeklyOutlook />
     </section>
    <nav className="market-tabs" aria-label="Markets" style={{display: activeTab === 'forecast' ? 'flex' : 'none'}}>{marketOrder.map(market => <button key={market} className={symbol === market ? 'active' : ''} onClick={() => switchMarket(market)}>{marketLabels[market]} <small>{market}</small></button>)}<button className="refresh" onClick={() => void load(true)}>↻ Refresh</button></nav>
    <section className="intro" style={{display: activeTab === 'forecast' ? 'flex' : 'none'}}><div><p className="eyebrow">MARKET OVERVIEW / {symbol}</p><h1>Trade the evidence.<br/><em>Not the impulse.</em></h1><p className="muted">Confirmed-candle analysis with transparent entry, risk and invalidation levels.</p></div><div className={`session ${isLive ? 'live-session' : ''}`}><span className="pulse" /> {isLive ? 'LIVE MARKET FEED' : current?.status === 'MARKET_CLOSED' ? 'MARKET CLOSED' : 'OFFLINE'}<small>{current?.provider || 'Waiting for provider'}</small></div></section>
    <section className="metrics" style={{display: activeTab === 'forecast' ? 'grid' : 'none'}}>
      <article className="metric"><span>LIVE PRICE · {symbol}</span><strong>{isLive ? fmt(current.price, digits) : '—'}</strong><small>{isLive && current?.bid != null && current.ask != null ? `Bid ${fmt(current.bid, digits)} · Ask ${fmt(current.ask, digits)}` : 'No verified quote available'}</small></article>
      <article className="metric"><span>MARKET TREND · {timeframe.toUpperCase()}</span><strong className={`trend ${current?.signal?.trend?.toLowerCase() || ''}`}>{isLive ? current?.signal?.trend || 'UNKNOWN' : 'UNKNOWN'}</strong><small>9/21 EMA + structure rules</small></article>
      <article className="metric"><span>SPREAD</span><strong>{isLive && current?.spread != null ? fmt(current.spread, digits) : '—'}</strong><small>{current?.provider_note || 'Provider-reported bid/ask spread'}</small></article>
      <article className="metric"><span>LAST PROVIDER UPDATE</span><strong className="time-value">{isLive ? dateFmt(updatedAt) : '—'}</strong><small>Refresh interval: 30 seconds</small></article>
    </section>
    {symbol === 'XAUUSD' && <section className="metrics spot-reference" style={{display: activeTab === 'forecast' ? 'grid' : 'none'}}><article className="metric"><span>XAUS · INDICATIVE GOLD SPOT</span><strong>{spotReference?.status === 'LIVE' && spotReference.price != null ? `${fmt(spotReference.price, 2)}` : '—'}</strong><small>{spotReference?.status === 'LIVE' ? `Source updated ${dateFmt(spotReference.updated_at)} · ${spotReference.age_seconds ?? '—'}s old` : `Spot reference unavailable${spotError ? `: ${spotError}` : ''}`}</small><small>Spot mid-price only — not a broker quote. No bid/ask, spread or signal candles.</small></article></section>}
    <section className="panel" style={{display: activeTab === 'forecast' ? 'block' : 'none'}}><div className="panel-head"><div><p className="eyebrow">PRICE ACTION</p><h2>{symbol === 'XAUUSD' && !isLive ? 'Gold indicative spot price trace' : `${symbol === 'XAUUSD' ? 'Gold' : symbol === 'BTCUSD' ? 'Bitcoin' : symbol === 'EURUSD' ? 'Euro / US Dollar' : 'British Pound / US Dollar'} candlestick chart`}</h2></div>{!(symbol === 'XAUUSD' && !isLive && spotReference?.price != null) && <div className="timeframes">{(['5m', '15m', '1h', '4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div>}</div>
      {symbol === 'XAUUSD' && <MarketSessionClock />}
      <div className="chart-label"><span><b className="legend-dot" /> {symbol} · {symbol === 'XAUUSD' && !isLive && spotReference?.price != null ? 'INDICATIVE SPOT' : timeframe.toUpperCase()}</span><span>{isLive ? `SOURCE: ${current?.provider}` : symbol === 'XAUUSD' && spotReference?.price != null ? 'SOURCE: XAUS SPOT · ~60s UPDATES' : 'NO VERIFIED MARKET DATA'}</span></div>
      {current?.candles?.length ? <><PriceChart data={current.candles} digits={digits} /><div className="chart-paused-note">{isLive ? 'LIVE CHART' : isStandardFxSessionClosed(symbol) ? <>MARKET CLOSED · CHART PAUSED <MarketOpensCountdown symbol={symbol} /></> : 'FEED DISCONNECTED · LAST SAVED CHART'} · Historical candles only while offline; live price and new signals are disabled.</div></> : symbol === 'XAUUSD' && spotReference?.price != null ? <PriceChart data={[]} digits={2} spotPoints={spotPoints} spotOnly /> : <div className="chart-offline"><span className="offline-icon">⌁</span><b>{isStandardFxSessionClosed(symbol) ? 'Market closed' : 'Market data unavailable'}</b>{isStandardFxSessionClosed(symbol) && <MarketOpensCountdown symbol={symbol} />}<p>{isStandardFxSessionClosed(symbol) ? 'The market is outside its standard trading session. The chart will appear when saved or historical candles are available.' : (lastError || 'The data provider is not connected.')}</p></div>}
      <p className="chart-foot">{isLive ? `Last update: ${dateFmt(updatedAt)} · Source: ${current?.provider}` : current?.candles?.length ? `Paused chart · Last verified candles retained on this device. Last market update: ${dateFmt(current.updated_at)}.` : symbol === 'XAUUSD' && spotReference?.price != null ? `Indicative spot trace · ${spotPoints.length} real provider samples collected in this browser session.` : 'No saved candles are available for this market yet.'}</p>
    </section>
    {!isLive && activeTab === 'forecast' && <div className="offline-notice"><b>{current?.status === 'MARKET_CLOSED' || isStandardFxSessionClosed(symbol) ? 'MARKET CLOSED' : 'LIVE DATA UNAVAILABLE'} · SIGNALS PAUSED</b><span>{current?.status === 'MARKET_CLOSED' || isStandardFxSessionClosed(symbol) ? <>Trading is outside Exness XAUUSD trading hours. The last saved chart remains visible when available. <MarketOpensCountdown symbol={symbol} /></> : (lastError || 'The provider is not returning a fresh quote.')} No new trade signals are generated without fresh market data.</span></div>}
    <section className="panel demo-summary" style={{display: activeTab === 'forecast' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">PAPER TRADING · NO BROKER ORDERS</p><h2>Demo account snapshot</h2></div><button className="refresh" onClick={() => setActiveTab('trade')}>Open demo account</button></div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>DEMO BALANCE</span><strong>₦{fmt(demoAccount?.balance ?? 300000, 2)}</strong><small>Starting balance ₦300,000 · Realized P/L: <b className={(demoAccount?.realized_pnl ?? 0) >= 0 ? 'green' : 'red'}>₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</b></small></article>
        <article className="metric"><span>OPEN DEMO POSITIONS</span><strong>{demoAccount?.open_count ?? 0} / 3</strong><small>Auto {demoAccount?.auto_trade ? 'ON' : 'OFF'}</small></article>
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
    <CollapsibleSection title="Portfolio wallet" defaultOpen={true} visible={activeTab === 'market'}><div className="stocks-portfolio-first" style={{display: activeTab === 'market' ? 'block' : 'none'}}><StockPortfolio /></div></CollapsibleSection>
    <StockSectionErrorBoundary country={stockCountry}><CollapsibleSection title="Stock market intelligence" visible={activeTab === 'market'}><section className="panel history-panel ngx-panel" style={{display: activeTab === 'market' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">GLOBAL EQUITIES · SIGNALS ONLY</p><h2>{ngxData?.flag || "🌐"} Stock Intelligence</h2></div><span className={ngxData?.status === 'LIVE' ? 'stock-live' : 'history-count'}>{ngxData?.status || 'CONNECTING'}</span></div>
      <p className="muted">Signals only · Starting research capital ₦100,000–₦500,000 · Short-term and long-term research. No orders are placed.</p>
      <div className="news-filters stock-market-filters">{[{id:"NG",label:"🇳🇬 Nigeria"},{id:"US",label:"🇺🇸 USA"},{id:"GB",label:"🇬🇧 UK"},{id:"CA",label:"🇨🇦 Canada"},{id:"ZA",label:"🇿🇦 South Africa"},{id:"IN",label:"🇮🇳 India"},{id:"DE",label:"🇩🇪 Germany"},{id:"AU",label:"🇦🇺 Australia"}].map(x=><button key={x.id} className={stockCountry===x.id?"selected":""} type="button" onClick={()=>setStockCountry(x.id)}>{x.label}</button>)}</div>
      <div className="metrics ngx-metrics">
        <article className="metric"><span>{stockOverview.benchmark?.name || 'BENCHMARK INDEX'}</span><strong>{formatStockNumber(stockOverview.benchmark?.value)}</strong><small>{stockOverview.benchmark?.change1d_pct != null ? `${Number(stockOverview.benchmark.change1d_pct).toFixed(2)}% daily` : 'Index value unavailable'}</small></article>
        <article className="metric"><span>MARKET CAPITALISATION</span><strong>{stockOverview.market_cap != null ? `${stockOverview.market_cap_currency || stockCurrency} ${formatStockNumber(stockOverview.market_cap / (stockCountry === 'NG' ? 1e12 : 1e9))}${stockCountry === 'NG' ? 'T' : 'B'}` : '—'}</strong><small>{stockOverview.market_cap != null ? `${stockOverview.market_cap_source || 'Provider snapshot'} · ${stockOverview.market_cap_as_of || 'Latest snapshot'}${stockOverview.market_cap_exchanges ? ` · ${stockOverview.market_cap_exchanges}` : ''}` : (stockOverview.market_cap_status || 'Comparable exchange-wide figure unavailable')}</small></article>
        <article className="metric"><span>ADVANCERS / DECLINERS</span><strong>{stockOverview.advancers ?? '—'} / {stockOverview.decliners ?? '—'}</strong><small>{stockOverview.breadth_basis || 'Market breadth unavailable'}</small></article>
        <article className="metric"><span>TRADING VOLUME</span><strong>{formatStockNumber(stockOverview.volume, 0)}</strong><small>{stockOverview.volume_basis || 'Volume unavailable'}</small></article>
      </div>
      <div className="stock-capital"><b>Research budget: ₦100K–₦500K</b><span>Non-NGN markets use their local currency. Position sizing is not calculated.</span></div>
      <p className="chart-foot">{ngxStatus} · {ngxData?.provider || 'NGX provider not connected'} · Updated {ngxData?.updated_at ? dateFmt(ngxData.updated_at) : '—'}</p>
      {ngxData?.watchlist?.length ? <div className="stock-list">{ngxData.watchlist.map((stock:any) => <article className="stock-card" key={stock.ticker}>
        {(() => { const ticker = String(stock.ticker || '').toUpperCase(); const brand = ticker.startsWith('GTCO') ? ['Financial services','Banking · payments · financial services'] : ticker.startsWith('ZENITH') ? ['Banking','Commercial banking · corporate and retail finance'] : ticker.startsWith('UBA') ? ['Banking','Retail · corporate · pan-African banking'] : ticker.startsWith('DANGCEM') ? ['Building materials','Cement manufacturing and distribution'] : ticker.startsWith('MTNN') || ticker.startsWith('MTN') ? ['Telecommunications','Mobile network · data · digital services'] : ticker.startsWith('SEPLAT') || ticker.startsWith('SHEL') || ticker.startsWith('BP') ? ['Energy','Oil · gas · energy production'] : ticker.startsWith('PRESCO') ? ['Agriculture','Palm oil production and agro-industrial processing'] : ticker.startsWith('AAPL') ? ['Consumer technology','Devices · software · digital services'] : ticker.startsWith('MSFT') ? ['Software & cloud','Software · cloud computing · enterprise services'] : ticker.startsWith('NVDA') ? ['Semiconductors','AI computing · GPUs · data-centre chips'] : ticker.startsWith('AMZN') ? ['E-commerce & cloud','Online retail · logistics · cloud computing'] : ticker.startsWith('GOOGL') ? ['Internet & technology','Search · advertising · cloud · AI'] : ticker.startsWith('JPM') || ticker.startsWith('HSB') || ticker.startsWith('RY') || ticker.startsWith('TD') || ticker.startsWith('HDFCBANK') || ticker.startsWith('SBK') || ticker.startsWith('CBA') || ticker.startsWith('WBC') ? ['Banking','Consumer · business · investment banking'] : ticker.startsWith('SHOP') ? ['E-commerce software','Merchant tools · online commerce platform'] : ticker.startsWith('ENB') ? ['Energy infrastructure','Pipelines · gas utilities · energy transport'] : ticker.startsWith('BHP') || ticker.startsWith('AGL') ? ['Mining & resources','Minerals · metals · natural resources'] : ticker.startsWith('AZN') || ticker.startsWith('CSL') ? ['Healthcare','Biopharmaceuticals · healthcare products'] : ticker.startsWith('ULVR') ? ['Consumer goods','Food · personal care · household brands'] : ticker.startsWith('SAP') || ticker.startsWith('TCS') || ticker.startsWith('INFY') ? ['Enterprise technology','Business software · IT consulting'] : ticker.startsWith('SIE') ? ['Industrial technology','Automation · electrification · engineering'] : ticker.startsWith('ALV') ? ['Insurance','Insurance · asset management'] : ticker.startsWith('DTE') ? ['Telecommunications','Telecom networks · connectivity'] : ticker.startsWith('RELIANCE') ? ['Energy & retail','Energy · retail · digital services'] : ticker.startsWith('NPN') ? ['Technology investment','Digital platforms · internet businesses'] : ['Public company','Listed equity · company profile']; return <div className="stock-brand-panel" style={{display:'flex',alignItems:'center',gap:14,minHeight:104,padding:'18px 20px',borderRadius:16,background:'linear-gradient(120deg, rgba(39,214,160,.16), rgba(31,54,82,.72))',border:'1px solid rgba(125,170,190,.22)'}}><div aria-hidden="true" style={{width:58,height:58,flex:'0 0 58px',borderRadius:14,display:'grid',placeItems:'center',background:'rgba(7,17,29,.78)',border:'1px solid rgba(39,214,160,.35)',fontSize:22,fontWeight:800,color:'#65e0b8'}}>{String(stock.name || stock.ticker || 'S').trim().charAt(0).toUpperCase()}</div><div style={{minWidth:0,flex:1}}><small style={{display:'block',fontSize:10,letterSpacing:1.4,color:'#70dabb',fontWeight:700,marginBottom:5}}>{brand[0].toUpperCase()}</small><b style={{display:'block',fontSize:17,color:'var(--text-primary, #f4f7fb)'}}>{stock.name}</b><span style={{display:'block',fontSize:12,color:'var(--text-secondary, #aab7c8)',marginTop:4,lineHeight:1.45}}>{brand[1]}</span></div><span style={{fontSize:12,color:'#aab7c8',fontWeight:700}}>{stockCountry}</span></div>; })()}<div className="stock-head"><div><b>{stock.ticker}</b><small>{stock.name} · {stockCountry === 'NG' ? 'NGX' : ngxData.market}</small></div><span className={Number(stock.change20_pct) >= 0 ? 'green' : 'red'}>{stock.change20_pct == null ? '—' : `${Number(stock.change20_pct)>0?'+':''}${Number(stock.change20_pct).toFixed(2)}% / 20D`}</span></div>
        <div className="stock-numbers"><div><small>PRICE · {ngxData.currency}</small><b>{stock.price == null ? '—' : Number(stock.price).toLocaleString('en-US',{maximumFractionDigits:3})}</b></div><div><small>RSI · 14</small><b>{stock.rsi14 ?? '—'}</b></div><div><small>TECH SCORE</small><b>{stock.technical_score ?? '—'}/100</b></div></div>
        <div className="stock-verdict">{stock.signal || 'WAIT — INSUFFICIENT DATA'} · {stock.trend || 'UNKNOWN'}</div>        <p className="score-note">{stock.reason}</p>
        <small className="score-note">{stock.fresh ? "Recent daily data" : "Stale daily data"} · {stock.history_bars} daily bars</small>
        <small className="score-note">Holding horizon: {stock.holding_horizon || 'Not assigned'} · Entry/SL/TP: not generated; fundamentals and liquidity checks are missing.</small>
      </article>)}</div> : <div className="chart-offline"><b>{typeof ngxData?.market === 'string' ? ngxData.market : (ngxData?.market?.name || (stockCountry === 'NG' ? 'NGX market snapshot' : 'Stock data not connected'))}</b><p>{ngxData?.note || ngxStatus}</p><small>Market data unavailable for this selection.</small></div>}
      <p className="score-note">Research screening only · data may be delayed · not a buy recommendation.</p>
    </section></CollapsibleSection></StockSectionErrorBoundary>
    <CollapsibleSection title="Market-moving news" visible={activeTab === 'forecast'}><section className="panel history-panel news-panel" style={{display: activeTab === 'forecast' ? 'block' : 'none'}}>      <div className="panel-head"><div><p className="eyebrow">GLOBAL MACRO & COMPANY INTELLIGENCE</p><h2>Market-moving news</h2></div><span className="history-count">{fundamentalItems.length} headlines</span></div>
      
      <p className="chart-foot">{fundamentalStatus}</p>
      <div className="news-filters">{[{id:'ALL',label:'All markets'},{id:'NG',label:'🇳🇬 Nigeria'},{id:'US',label:'🇺🇸 USA'},{id:'GB',label:'🇬🇧 UK'},{id:'EU',label:'🇪🇺 Europe'},{id:'AF',label:'🌍 Africa'},{id:'GLOBAL',label:'🌍 Global'}].map(x => <button key={x.id} className={newsCountry === x.id ? 'selected' : ''} onClick={() => setNewsCountry(x.id)}>{x.label}</button>)}</div>
       <div className="news-filters"><button className={newsFocus === "ALL" ? "selected" : ""} onClick={()=>setNewsFocus("ALL")}>All coverage</button><button className={newsFocus === "INCOME" ? "selected" : ""} onClick={()=>setNewsFocus("INCOME")}>Dividends · Earnings · Yields</button><button className={newsFocus === "HIGH" ? "selected" : ""} onClick={()=>setNewsFocus("HIGH")}>High impact</button></div>
      {fundamentalItems.length ? <div className="history-list">{fundamentalItems.filter(item => (newsCountry === 'ALL' || (item.country || 'GLOBAL') === newsCountry) && (newsFocus === 'ALL' || (newsFocus === 'INCOME' ? item.income_relevance === 'INCOME' : item.impact === 'HIGH'))).slice(0, 20).map(item => <article className="news-card" key={item.id}>
        <img className="news-card-image" src={item.image_url || item.source_image_url || ''} onError={event => { if (item.source_image_url && event.currentTarget.src !== item.source_image_url) event.currentTarget.src = item.source_image_url }} alt="" loading="lazy" />
        <div className="news-meta"><span className="news-flag">{item.country === 'NG' ? '🇳🇬' : item.country === 'US' ? '🇺🇸' : item.country === 'GB' ? '🇬🇧' : item.country === 'EU' ? '🇪🇺' : item.country === 'AF' ? '🌍' : '🌍'}</span><span className="news-country">{item.country === 'NG' ? 'NIGERIA' : item.country === 'US' ? 'UNITED STATES' : item.country === 'GB' ? 'UNITED KINGDOM' : item.country === 'EU' ? 'EUROPE' : item.country === 'AF' ? 'AFRICA' : 'GLOBAL'}</span><span className={`impact-${item.impact.toLowerCase()}`}>{item.impact} IMPACT</span>{item.income_relevance === "INCOME" && <span className="income-tag">DIVIDENDS / EARNINGS</span>}<span>{item.source}</span><time>{dateFmt(item.published_at)}</time></div>
        <a href={item.url} target="_blank" rel="noreferrer" className="news-title">{item.title}</a>
        {item.summary && <p className="muted">{decodeHtmlEntities(item.summary)}</p>}
        <div className="news-bottom"><span>{item.assets.join(' · ') || 'ECONOMY & POLICY'}</span><small>{item.interpretation}</small></div>
      </article>)}</div> : <div className="history-empty">No live headlines available. {fundamentalStatus}</div>}
    </section></CollapsibleSection>
    <CollapsibleSection title="Tech, web & remote careers" visible={activeTab === 'education'}><section className="panel history-panel opportunity-panel" style={{display: activeTab === 'education' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">TECHNOLOGY · DEVELOPER ECOSYSTEM · CAREER OPPORTUNITIES</p><h2>Tech & Careers</h2></div><span className="history-count">{opportunityItems.length} updates</span></div>
      <p className="chart-foot">{opportunityStatus} · Refreshes every minute</p>
      <div className="news-filters opportunity-filters">{[{id:'ALL',label:'All updates'},{id:'TECH',label:'Technology'},{id:'WEB',label:'Web & Development'},{id:'JOBS',label:'Remote jobs'}].map(option => <button key={option.id} className={opportunityFilter === option.id ? 'selected' : ''} onClick={() => setOpportunityFilter(option.id as typeof opportunityFilter)}>{option.label}</button>)}</div>
      <div className="opportunity-note"><b>For applicants in Nigeria:</b> We welcome roles with overnight, rotating, US/UK or other time-zone schedules—Nigerian applicants can work across time zones. Do not treat night hours alone as a restriction. “Potentially open to Nigeria” is not a guarantee: location, legal work-authorization and payment requirements must still be checked on the employer’s official listing. Never pay to apply.</div>
      {opportunityItems.filter(item => opportunityFilter === 'ALL' || item.category === opportunityFilter).length ? <div className="history-list">{opportunityItems.filter(item => opportunityFilter === 'ALL' || item.category === opportunityFilter).slice(0, 50).map(item => <article className="news-card opportunity-card" key={item.id}>
        <img className="news-card-image" src={item.image_url || item.source_image_url || ''} onError={event => { if (item.source_image_url && event.currentTarget.src !== item.source_image_url) event.currentTarget.src = item.source_image_url; else event.currentTarget.style.display = 'none' }} alt="" loading="lazy" />
        <div className="news-meta"><span className="opportunity-category">{item.category === 'JOBS' ? 'REMOTE JOB' : item.category === 'WEB' ? 'WEB & DEVELOPMENT' : 'TECHNOLOGY'}</span><span>{item.source}</span><time>{dateFmt(item.published_at)}</time></div>
        <a href={item.url} target="_blank" rel="noreferrer" className="news-title">{item.title}</a>
        {item.category === 'JOBS' && <div className={item.eligibility === 'Potentially open to Nigeria' ? 'job-eligibility likely' : 'job-eligibility'}>{item.eligibility === 'Potentially open to Nigeria' ? <><span aria-hidden="true">✓ </span>Potentially available for Nigerians</> : item.eligibility || 'Not confirmed · check employer policy'}</div>}
        {item.summary && <p className="muted">{decodeHtmlEntities(item.summary)}</p>}
        <div className="news-bottom"><span>{item.category === 'JOBS' ? 'Check role requirements & location rules' : item.category === 'WEB' ? 'Developer ecosystem' : 'Technology industry'}</span><small>{item.interpretation}</small></div>
      </article>)}</div> : <div className="history-empty">No items in this category right now. {opportunityStatus}</div>}
    </section></CollapsibleSection>
    <CollapsibleSection title="Signal history" visible={activeTab === 'trade'}><section className="panel history-panel" style={{display: activeTab === 'trade' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">PRICE-TRACKED OUTCOMES</p><h2>Signal history</h2></div><span className="history-count">{history.length} saved</span></div>
      <div className="news-filters history-status-filters">{[{id:'ALL',label:'All'},{id:'ACTIVE',label:'Active'},{id:'VOID',label:'Void'},{id:'SL_HIT',label:'SL hit'},{id:'TP_HIT',label:'TP hit'}].map(filter => <button key={filter.id} className={historyFilter===filter.id?'selected':''} onClick={()=>{setHistoryFilter(filter.id as typeof historyFilter);setShowAllHistory(false)}}>{filter.label}</button>)}</div>
      {history.length ? (() => {
        const matchesFilter = (item: typeof history[number]) => historyFilter === 'ALL' || (historyFilter === 'ACTIVE' ? ['DETECTED','ACTIVE'].includes(item.status || 'DETECTED') : historyFilter === 'TP_HIT' ? ((item.targetsHit?.length || 0) > 0 || (item.status || '').startsWith('TP')) : item.status === historyFilter);
        const sorted = [...history].filter(matchesFilter).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
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
                <button type="button" className="history-row history-row-button" aria-expanded={selectedHistoryKey === item.key} onClick={() => { setSelectedHistoryKey(item.key); setSelectedSetup(item) }}>
                  <span className={item.side.toLowerCase()}>{item.side}</span>{item.entry_style === 'SNIPER' && <span className="signal-badge buy">SNIPER</span>}<b>{item.symbol}</b><span>{item.tf.toUpperCase()}</span>
                  <span>{item.entry == null ? '—' : fmt(item.entry, ['EURUSD','GBPUSD'].includes(item.symbol) ? 5 : 2)}</span><span className={`history-outcome outcome-${(item.status || 'DETECTED').toLowerCase()}`}>{item.status === 'DETECTED' ? 'WAITING ENTRY' : (item.status === 'ACTIVE' && item.reachedTarget ? `ACTIVE · TP${item.reachedTarget} HIT` : (item.status || 'UNKNOWN').replace('_',' '))}</span>
                  <time><strong>{dateFmt(item.time)}</strong>{item.candleTime && <small>Candle: {dateFmt(item.candleTime)}</small>}</time>
                  <small className="history-expand-hint">{selectedHistoryKey === item.key ? 'Tap to hide setup' : 'Tap to view full setup'}</small>
                </button>
                {selectedHistoryKey === item.key && <div className="history-detail">
                  <div className="history-levels">
                    <article><span>ENTRY</span><strong>{item.entry == null ? '—' : fmt(item.entry, ['EURUSD','GBPUSD'].includes(item.symbol) ? 5 : 2)}</strong></article>
                    <article><span>STOP LOSS</span><strong>{item.stop_loss == null ? '—' : fmt(item.stop_loss, ['EURUSD','GBPUSD'].includes(item.symbol) ? 5 : 2)}</strong></article>
                    {item.take_profits.map((target, index) => <article key={index}><span>TP{index + 1} {(item.targetsHit || []).includes(index) ? '· HIT' : '· PENDING'}</span><strong className={(item.targetsHit || []).includes(index) ? 'green' : ''}>{fmt(target, ['EURUSD','GBPUSD'].includes(item.symbol) ? 5 : 2)}</strong></article>)}
                  </div>
                  <div className="history-meta"><span>Trend: {item.trend || '—'}</span><span>R:R: {item.rr?.length ? item.rr.map(value => value + ':1').join(' / ') : '—'}</span><span>Rule score: {item.confidence == null ? '—' : item.confidence + '%'}</span><span>Provider: {item.provider || '—'}</span></div>
                  {item.reasons?.length > 0 && <div className="history-reasons"><b>Why this setup was detected</b><ul>{item.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
                  {item.invalidation && <p className="history-invalidation"><b>Invalidation:</b> {item.invalidation}</p>}
                  {item.targetsHit?.length ? <p className="history-invalidation"><b>Targets reached:</b> {item.targetsHit.map(index => `TP${index + 1}`).join(' · ')}</p> : null}
                  {item.outcomeAt && <p className="history-invalidation"><b>Final outcome:</b> {item.status?.replace('_',' ')} at {item.outcomePrice == null ? '—' : fmt(item.outcomePrice, ['EURUSD','GBPUSD'].includes(item.symbol) ? 5 : 2)} · {dateFmt(item.outcomeAt)}</p>}
                  <p className="score-note">Status is determined from recorded market candles. Same-candle SL/TP ambiguity is resolved conservatively as SL first.</p>
                </div>}
              </div>)}
            </section>;
          })}
        </div>;
      })() : <div className="history-empty">No saved setups yet. {historyStatus}</div>}
      {history.length > 5 && <button className="refresh history-toggle" onClick={() => setShowAllHistory(value => !value)}>{showAllHistory ? 'Show less' : 'View more'}</button>}
      <p className="chart-foot">{historyStatus} · Times shown in Africa/Lagos (WAT). Alert time is when GoldSight recorded the setup; candle time is shown separately.</p>
    </section></CollapsibleSection>

    <CollapsibleSection title="MT5 connection" visible={activeTab === 'trade'}><section className="connect-dashboard" style={{display: activeTab === 'trade' ? 'block' : 'none'}}>
      <div className="tab-hero connect-hero"><p className="eyebrow">LIVE TERMINAL LINK</p><h2>MT5 Connection</h2><p className="muted">Pair your MetaTrader 5 terminal with TradeSight and monitor its connection securely.</p></div>
      <BrokerConnection />
    </section></CollapsibleSection>
    <CollapsibleSection title="Demo trading account" defaultOpen={true} visible={activeTab === 'trade'}><section className="panel demo-panel" style={{display: activeTab === 'trade' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">SIMULATED ACCOUNT · NO BROKER ORDERS</p><h2>Demo trading</h2></div><span className="signal-badge buy">AUTO {demoAccount?.auto_trade ? 'ON' : 'OFF'}</span></div>
      
      <div className="demo-balance"><span>AVAILABLE BALANCE</span><strong>₦{fmt(demoAccount?.balance ?? 300000, 2)}</strong><small>Starting balance ₦300,000 · Realized P/L: ₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</small></div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>LIVE FLOATING P/L</span><strong className={demoUnrealizedPnl >= 0 ? 'green' : 'red'}>{demoPnlAvailable ? `₦${fmt(demoUnrealizedPnl, 2)}` : '—'}</strong><small>{demoPnlAvailable ? 'Open positions · live quotes' : 'Waiting for live quotes'}</small></article>
        <article className="metric"><span>TOTAL DEMO EQUITY</span><strong>{demoPnlAvailable ? `₦${fmt(demoEquity, 2)}` : '—'}</strong><small>Balance + floating P/L</small></article>
        <article className="metric"><span>REALIZED P/L</span><strong className={(demoAccount?.realized_pnl ?? 0) >= 0 ? 'green' : 'red'}>₦{fmt(demoAccount?.realized_pnl ?? 0, 2)}</strong><small>Closed positions</small></article>
      </div>
      <div className="metrics demo-metrics">
        <article className="metric"><span>OPEN POSITIONS</span><strong>{demoAccount?.open_count ?? 0} / 3</strong></article>
        <article className="metric"><span>RISK PER TRADE</span><strong>{demoAccount?.risk_per_trade_pct ?? 1}%</strong><small>Of current balance</small></article>
      </div>
      <div className="context-row"><span>Automation</span><b>{demoAccount?.auto_trade ? 'Enabled' : 'Disabled'}</b></div>
      <div className="context-row"><span>USD/NGN sizing rate</span><b>{demoAccount?.fx_rate_source === 'BROKER_CONFIGURED' ? 'Broker rate' : demoAccount?.fx_rate_source === 'PUBLIC_REFERENCE_ESTIMATE' ? 'Public reference estimate' : 'Unavailable · entries paused'}</b></div>
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
    </section></CollapsibleSection>
    <CollapsibleSection title="Trading tools" visible={activeTab === 'trade'}><div className="tools-tab" style={{display: activeTab === 'trade' ? 'block' : 'none'}}><div className="tab-hero tools-hero"><p className="eyebrow">PLAN BEFORE YOU TRADE</p><h2>Trading tools</h2></div><BrokerBridge symbol={symbol} timeframe={timeframe} signal={signalForUi} livePrice={isLive ? current?.price : null} /><PositionSizer symbol={symbol} /><PipCalculator symbol={symbol} /><CurrencyConverter /></div></CollapsibleSection>
    <section className="education-dashboard" style={{display: activeTab === 'education' ? 'block' : 'none'}}>
      <div className="tab-hero education-hero"><p className="eyebrow">TRADE SMARTER · BUILD SKILL</p><h2>Trading Education</h2><p className="muted">Practical lessons on market structure, risk and execution. Learn the process before risking capital.</p></div>
      <div className="education-grid">
        <article className="panel education-card"><span className="education-step">01 · FOUNDATIONS</span><h3>Understand market structure</h3><p>Start with swing highs and lows. A bullish structure forms higher highs and higher lows; a bearish structure forms lower lows and lower highs.</p><ul><li>Mark meaningful swing points on 4H and 1H.</li><li>Use BOS to identify a confirmed structure break.</li><li>Treat CHoCH as an early warning, not automatic entry confirmation.</li></ul></article>
        <article className="panel education-card"><span className="education-step">02 · LIQUIDITY</span><h3>Learn where liquidity rests</h3><p>Equal highs, equal lows and obvious swing points can attract stops. A sweep alone is not a reversal signal.</p><ul><li>Wait for price to take liquidity.</li><li>Look for displacement and a structure shift.</li><li>Require a clear invalidation level.</li></ul></article>
        <article className="panel education-card"><span className="education-step">03 · RISK MANAGEMENT</span><h3>Protect the account first</h3><p>Position size should come from the distance between entry and stop-loss—not from the profit target you hope to make.</p><ul><li>Define risk before entering.</li><li>Keep risk per trade small and consistent.</li><li>Never widen a stop just to avoid taking a loss.</li></ul></article>
        <article className="panel education-card"><span className="education-step">04 · EXECUTION</span><h3>Build a repeatable setup</h3><p>Use higher timeframes for directional context and lower timeframes for entry confirmation. Avoid forcing trades when conditions are unclear.</p><ul><li>Set a directional bias on 4H / 1H.</li><li>Wait for a 15M / 5M setup to align.</li><li>Record the reason, entry, stop and outcome.</li></ul></article>
        <article className="panel education-card"><span className="education-step">05 · GOLD (XAUUSD)</span><h3>Respect gold's volatility</h3><p>Gold can move sharply around US economic releases, yields and the US dollar. Spreads and slippage can widen during fast markets.</p><ul><li>Check the economic calendar before trading.</li><li>Avoid chasing large impulse candles.</li><li>Use a stop that reflects structure and current volatility.</li></ul></article>
        <article className="panel education-card"><span className="education-step">06 · TRADING JOURNAL</span><h3>Review the process, not one trade</h3><p>A good setup can lose and a poor setup can win. Judge your decisions across a meaningful sample of trades.</p><ul><li>Save screenshots before and after each trade.</li><li>Track rule-following, risk and execution errors.</li><li>Review results weekly and adjust one thing at a time.</li></ul></article>
      </div>
      <p className="score-note">Educational material only. It is not a promise of returns or a recommendation to trade.</p>
    </section>
    <CollapsibleSection title="Settings & preferences" defaultOpen={true} visible={activeTab === 'settings'}><section className="panel settings-panel" style={{display: activeTab === 'settings' ? 'block' : 'none'}}><div className="tab-hero settings-hero"><p className="eyebrow">YOUR WORKSPACE</p><h2>Settings & notifications</h2></div>
      <p className="eyebrow">PREFERENCES</p><h2>Settings</h2>
      <WorkspaceManager />
      <div className="settings-group"><span>Appearance</span><div className="settings-actions"><button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}>☀️ Light mode</button><button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}>🌙 Dark mode</button></div><p className="muted">Your choice is saved on this device and applied across every tab.</p></div>
      <div className="settings-group"><span>Default market</span><div className="settings-actions"><button className={symbol === 'XAUUSD' ? 'selected' : ''} onClick={() => switchMarket('XAUUSD')}>Gold · XAUUSD</button><button className={symbol === 'BTCUSD' ? 'selected' : ''} onClick={() => switchMarket('BTCUSD')}>Bitcoin · BTCUSD</button><button className={symbol === 'EURUSD' ? 'selected' : ''} onClick={() => switchMarket('EURUSD')}>EUR/USD</button><button className={symbol === 'GBPUSD' ? 'selected' : ''} onClick={() => switchMarket('GBPUSD')}>GBP/USD</button></div></div>
      <div className="settings-group"><span>Analysis timeframe</span><div className="settings-actions">{(['5m','15m','1h','4h'] as TF[]).map(tf => <button key={tf} className={timeframe === tf ? 'selected' : ''} onClick={() => setTimeframe(tf)}>{tf.toUpperCase()}</button>)}</div></div>
      
      <div className="settings-group">
        <span>Floating trading panel</span>
        <p className="muted">Keep your selected market price and latest signal visible over other apps. Android will ask you to grant Display over other apps permission.</p>
        <button className="refresh" onClick={() => void toggleFloatingOverlay()}>{overlayEnabled ? 'Turn off floating panel' : 'Enable floating panel'}</button>
        <p className="muted">{overlayStatus}</p>
      </div>
      <div className="settings-group"><span>Data refresh</span><p className="muted">Market data refreshes every 30 seconds. Market news, technology and remote-job feeds refresh every minute. Live feed status is shown in the header.</p><button className="refresh" onClick={() => void load(true)}>Refresh market data now</button></div>
      
    </section></CollapsibleSection>
    <CollapsibleSection title="Notifications" visible={activeTab === 'settings'}>
    <section className="panel history-panel settings-notifications" style={{display: activeTab === 'settings' ? 'block' : 'none'}}>
      <div className="panel-head"><div><p className="eyebrow">ALERT DELIVERY</p><h2>Market notifications</h2></div><span className="history-count">{pushEnabled ? 'PUSH ON' : 'PUSH OFF'}</span></div>
      <p className="muted">{pushStatus}. Choose exactly which categories may send push alerts to this device. Each category is off until you approve it.</p>
      <div className="settings-group">
        <span>News regions</span>
        <div className="settings-actions">
          {([{key:'nigeria',label:'🇳🇬 Nigeria'},{key:'africa',label:'🌍 Other African countries'},{key:'usa',label:'🇺🇸 USA'},{key:'uk',label:'🇬🇧 UK'},{key:'global',label:'🌐 Global'}] as const).map(option => <button key={option.key} className={pushPreferences.news[option.key] ? 'selected' : ''} aria-pressed={pushPreferences.news[option.key]} onClick={() => void updatePushPreference('news', !pushPreferences.news[option.key], option.key)}>{option.label} · {pushPreferences.news[option.key] ? 'Approved' : 'Off'}</button>)}
        </div>
      </div>
      <div className="settings-group">
        <span>News topics</span>
        <div className="settings-actions">
          {([{key:'economic',label:'📊 Economic news'},{key:'football',label:'⚽ Football news'}] as const).map(option => <button key={option.key} className={pushPreferences.news[option.key] ? 'selected' : ''} aria-pressed={pushPreferences.news[option.key]} onClick={() => void updatePushPreference('news', !pushPreferences.news[option.key], option.key)}>{option.label} · {pushPreferences.news[option.key] ? 'Approved' : 'Off'}</button>)}
        </div>
      </div>
      <div className="settings-group">
        <span>Technology & careers</span>
        <div className="settings-actions">
          <button className={pushPreferences.tech_careers ? 'selected' : ''} aria-pressed={pushPreferences.tech_careers} onClick={() => void updatePushPreference('tech_careers', !pushPreferences.tech_careers)}>💻 Tech, web & remote jobs · {pushPreferences.tech_careers ? 'Approved' : 'Off'}</button>
        </div>
        <p className="muted">Alerts for newly published technology, web-development and remote-career updates. Job eligibility in Nigeria must still be confirmed with the employer.</p>
      </div>
      <div className="settings-group">
        <span>Other notifications</span>
        <div className="settings-actions">
          <button className={pushPreferences.setups ? 'selected' : ''} aria-pressed={pushPreferences.setups} onClick={() => void updatePushPreference('setups', !pushPreferences.setups)}>📈 Trading setups · {pushPreferences.setups ? 'Approved' : 'Off'}</button>
          <button className={pushPreferences.stocks ? 'selected' : ''} aria-pressed={pushPreferences.stocks} onClick={() => void updatePushPreference('stocks', !pushPreferences.stocks)}>🏦 Stock suggestions · {pushPreferences.stocks ? 'Approved' : 'Off'}</button>
        </div>
        <p className="muted">Every option starts OFF. Africa means African countries outside Nigeria. Android/browser permission is separate from these approvals.</p>
      </div>
      <button className="refresh" onClick={() => void enablePushNotifications()} disabled={pushEnabled}>{pushEnabled ? 'Android push connected' : 'Connect this device for push notifications'}</button>
      <button className="refresh" onClick={() => void sendPushTest()} disabled={!pushEnabled || pushTestBusy}>{pushTestBusy ? 'Sending test…' : 'Send test notification'}</button>

    </section>
    </CollapsibleSection>
    <nav className="app-bottom-nav" aria-label="Main navigation">
      {([
        {id:'home',label:'Home',icon:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></svg>},
        {id:'market',label:'Market',icon:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 5-7"/></svg>},
        {id:'forecast',label:'Forecast',icon:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.5 8.5 12l3.5 3.5L21 6.5"/><path d="M15 6.5h6v6"/></svg>},
        {id:'education',label:'Education',icon:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2.5 9 9.5-5 9.5 5-9.5 5-9.5-5Z"/><path d="M6 11v5c3.5 3 8.5 3 12 0v-5M21.5 9v6"/></svg>},
        {id:'trade',label:'Trade',icon:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v13H3zM7 7V4h10v3M7 12h4M7 16h10"/></svg>},
      ] as const).map(tab => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => markTabViewed(tab.id)} aria-label={tab.label}><span className="nav-icon">{tab.icon}</span>{unreadTabs.includes(tab.id) && <i className="nav-notification-dot" aria-label="Unread notification" />}<small>{tab.label}</small></button>)}
    </nav>
    <footer><span>TradeSight</span><span>Analysis only · No live orders</span></footer>  </main>
}