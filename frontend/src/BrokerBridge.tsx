import { useMemo, useState } from 'react'

type BridgeSignal = {
  status?: string
  side?: string
  entry?: number | null
  stop_loss?: number | null
  take_profits?: number[]
  confidence?: number | null
}

type Props = {
  symbol: string
  timeframe: string
  signal: BridgeSignal
  livePrice?: number | null
}

const price = (value: number | null | undefined, digits: number) =>
  value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export default function BrokerBridge({ symbol, timeframe, signal, livePrice }: Props) {
  const [broker, setBroker] = useState('Exness')
  const [platform, setPlatform] = useState('MetaTrader 5')
  const [volume, setVolume] = useState('0.01')
  const [copied, setCopied] = useState(false)
  const digits = symbol === 'EURUSD' || symbol === 'GBPUSD' ? 5 : 2
  const valid = (signal.status === 'BUY' || signal.status === 'SELL') &&
    Number.isFinite(signal.entry) && Number.isFinite(signal.stop_loss) &&
    (signal.take_profits || []).length > 0
  const ticket = useMemo(() => [
    'TRADESIGHT ORDER TICKET',
    `Broker: ${broker}`,
    `Platform: ${platform}`,
    `Symbol: ${symbol}`,
    `Direction: ${signal.side || signal.status || '—'}`,
    `Timeframe: ${timeframe.toUpperCase()}`,
    `Volume (lots): ${volume}`,
    `Entry: ${price(signal.entry, digits)}`,
    `Stop loss: ${price(signal.stop_loss, digits)}`,
    ...(signal.take_profits || []).map((tp, index) => `Take profit ${index + 1}: ${price(tp, digits)}`),
    `Live reference price: ${price(livePrice, digits)}`,
    '',
    'Review symbol, volume, quote, margin and all order levels in MT5 before placing the trade.'
  ].join('\n'), [broker, platform, symbol, timeframe, volume, signal.side, signal.status, signal.entry, signal.stop_loss, signal.take_profits, livePrice, digits])

  const openTradingPlatform = () => {
    const packageName = platform === 'MetaTrader 4'
      ? 'net.metaquotes.metatrader4'
      : 'net.metaquotes.metatrader5'
    // Android intent URI: open the installed terminal, or fall back to its
    // Play Store listing if Android cannot resolve the app on this device.
    const scheme = platform === 'MetaTrader 4' ? 'metatrader4' : 'metatrader5'
    const storeUrl = 'https://play.google.com/store/apps/details?id=' + packageName
    const fallback = encodeURIComponent(storeUrl)
    window.location.href = 'intent://launch/#Intent;scheme=' + scheme + ';package=' + packageName + ';S.browser_fallback_url=' + fallback + ';end'
  }

  const copyTicket = async () => {
    try {
      await navigator.clipboard.writeText(ticket)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2200)
    } catch {
      const field = document.createElement('textarea')
      field.value = ticket
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      const ok = document.execCommand('copy')
      field.remove()
      setCopied(ok)
    }
  }

  return <section className="panel broker-bridge-panel">
    <div className="panel-head">
      <div><p className="eyebrow">BROKER CONNECTION · PHASE 1</p><h2>Smart Broker Bridge</h2><p className="muted">Prepare a TradeSight setup for manual confirmation in your trading platform.</p></div>
      <span className="signal-badge none">MANUAL EXECUTION</span>
    </div>
    <div className="pip-fields">
      <label>Broker account<select value={broker} onChange={event => setBroker(event.target.value)}><option>Exness</option><option>Headway</option><option>Other MT5 broker</option></select></label>
      <label>Trading platform<select value={platform} onChange={event => setPlatform(event.target.value)}><option>MetaTrader 5</option><option>MetaTrader 4</option></select></label>
      <label>Order volume (lots)<input inputMode="decimal" value={volume} onChange={event => setVolume(event.target.value)} placeholder="0.01" /></label>
    </div>
    {valid ? <div className="broker-ticket">
      <div className="panel-head"><strong>{symbol} · {signal.side || signal.status}</strong><span className={signal.status === 'BUY' ? 'buy' : 'sell'}>{signal.status}</span></div>
      <div className="signal-levels">
        <div><span>ENTRY</span><b>{price(signal.entry, digits)}</b></div>
        <div><span>STOP LOSS</span><b className="red">{price(signal.stop_loss, digits)}</b></div>
        {(signal.take_profits || []).map((tp, index) => <div key={index}><span>TP{index + 1}</span><b className="green">{price(tp, digits)}</b></div>)}
        <div><span>LIVE REFERENCE</span><b>{price(livePrice, digits)}</b></div>
      </div>
      <p className="score-note">Signal levels are a snapshot. The market may move before you reach MT5. Check the current quote and order type before submitting.</p>
    </div> : <div className="no-setup"><b>No confirmed setup to transfer</b><p>Open a valid BUY or SELL signal in Forecast to prepare its order ticket.</p></div>}
    <div className="broker-bridge-actions">
      <button type="button" className="refresh" onClick={() => void copyTicket()} disabled={!valid || !/^\d+(\.\d+)?$/.test(volume) || Number(volume) <= 0}>{copied ? '✓ Ticket copied' : 'Copy trade ticket'}</button>
      <button type="button" className="refresh broker-open-mt5" onClick={openTradingPlatform}>Open {platform === 'MetaTrader 4' ? 'MT4' : 'MT5'} ↗</button>
    </div>
    <p className="score-note">This first phase copies the exact setup details and attempts to open MT5. It does not connect to your broker account or place orders automatically. Verify lot size, contract specifications, margin and execution price inside MT5.</p>
  </section>
}
