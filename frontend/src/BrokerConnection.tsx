import { useEffect, useState } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')

type Snapshot = {
  broker?: string
  server?: string
  account_login?: string
  account_currency?: string
  leverage?: number
  terminal?: string
  terminal_build?: string
  connected?: boolean
  open_positions?: number
  balance?: number
  equity?: number
  free_margin?: number
  received_at?: string
  position_items?: Array<{
    ticket?: string; symbol?: string; type?: string; volume?: number
    price_open?: number; price_current?: number; stop_loss?: number
    take_profit?: number; profit?: number; swap?: number; time?: number
  }>
  recent_closing_deals?: Array<{
    ticket?: string; symbol?: string; type?: string; volume?: number
    price?: number; profit?: number; swap?: number; commission?: number; time?: number
  }>
}
type BridgeStatus = {
  status: string
  device_id: string
  device_name: string
  created_at?: string
  last_seen_at?: string | null
  snapshot?: Snapshot | null
  read_only: boolean
  order_execution_enabled: boolean
}

function money(value?: number, currency?: string) {
  if (value == null || !Number.isFinite(value)) return '—'
  return (currency ? currency + ' ' : '') + value.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function tradeTime(value?: number) {
  if (!value || !Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value * 1000))
}

function dateLabel(value?: string | null) {
  if (!value) return 'No heartbeat received yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
  }).format(date) + ' WAT'
}

export default function BrokerConnection() {
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  const connect = async () => {
    const clean = token.trim()
    if (clean.length < 40) {
      setError('Paste the full device token created during administrator pairing.')
      return
    }
    setBusy(true); setError('')
    try {
      const response = await fetch(API + '/api/v1/mt5-bridge/status', {
        headers: { Authorization: 'Bearer ' + clean },
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not verify this bridge token.')
      setStatus(result as BridgeStatus)
      setLastChecked(new Date())
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Connection check failed. Try again.')
    } finally { setBusy(false) }
  }

  const disconnect = () => { setStatus(null); setToken(''); setError(''); setLastChecked(null) }
  useEffect(() => {
    if (!status || !token) return
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(API + '/api/v1/mt5-bridge/status', { headers: { Authorization: 'Bearer ' + token.trim() } })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Connection status refresh failed.')
        if (active) { setStatus(result as BridgeStatus); setLastChecked(new Date()) }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Automatic status refresh failed.')
      }
    }, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [status?.device_id, token])
  const snapshot = status?.snapshot
  const heartbeatTime = status?.last_seen_at || snapshot?.received_at || null
  const recent = heartbeatTime ? Date.now() - new Date(heartbeatTime).getTime() < 90000 : false

  return <section className="panel broker-connection-panel">
    <div className="panel-head">
      <div><p className="eyebrow">MT5 COMPANION</p><h2>Broker connection</h2><p className="muted">Read-only terminal monitoring. No trade execution.</p></div>
      <span className={status ? (recent && snapshot?.connected ? 'bridge-state online' : 'bridge-state waiting') : 'bridge-state offline'}>{status ? (recent && snapshot?.connected ? 'CONNECTED' : 'PAIRED') : 'NOT PAIRED'}</span>
    </div>

    {!status ? <>
      <div className="bridge-explainer">
        <b>Connect your Windows MT5 terminal</b>
        <p>Pair the terminal through the secure backend administrator process, then paste its one-time device token here. The token stays in this screen's memory and is not saved to browser storage.</p>
      </div>
      <label className="bridge-token-label" htmlFor="bridge-device-token">Device token</label>
      <div className="bridge-token-row">
        <input id="bridge-device-token" type={showToken ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder="Paste your paired MT5 device token" />
        <button type="button" onClick={() => setShowToken(value => !value)}>{showToken ? 'Hide' : 'Show'}</button>
      </div>
      <button type="button" className="bridge-primary" disabled={busy || !token.trim()} onClick={() => void connect()}>{busy ? 'Checking token…' : 'Connect terminal'}</button>
      {error && <p className="bridge-error" role="alert">{error}</p>}
      <ol className="bridge-steps">
        <li>Configure <code>MT5_BRIDGE_ADMIN_KEY</code> on the backend and ensure persistent PostgreSQL is available.</li>
        <li>Use the administrator pairing command in <code>mt5/README.md</code> to create a device token.</li>
        <li>Paste the token here, then enable remote telemetry in the MT5 Expert Advisor inputs.</li>
      </ol>
    </> : <>
      <div className="bridge-summary">
        <div><span>DEVICE</span><strong>{status.device_name}</strong></div>
        <div><span>BROKER</span><strong>{snapshot?.broker || 'Waiting for first heartbeat'}</strong></div>
        <div><span>SERVER</span><strong>{snapshot?.server || '—'}</strong></div>
        <div><span>ACCOUNT</span><strong>{snapshot?.account_login ? '••••' + snapshot.account_login.slice(-4) : '—'} {snapshot?.account_currency || ''}</strong></div>
        <div><span>LEVERAGE</span><strong>{snapshot?.leverage ? '1:' + snapshot.leverage : '—'}</strong></div>
        <div><span>MT5 TERMINAL</span><strong>{snapshot?.terminal || '—'} {snapshot?.terminal_build ? '· ' + snapshot.terminal_build : ''}</strong></div>
        <div><span>TERMINAL CONNECTION</span><strong className={snapshot?.connected ? 'bridge-good' : 'bridge-bad'}>{snapshot ? (snapshot.connected ? 'Connected' : 'Disconnected') : 'No heartbeat yet'}</strong></div>
        <div><span>OPEN POSITIONS</span><strong>{snapshot?.open_positions ?? '—'}</strong></div>
        <div><span>FLOATING P/L</span><strong className={(snapshot?.position_items || []).reduce((sum, item) => sum + (item.profit || 0) + (item.swap || 0), 0) >= 0 ? 'bridge-good' : 'bridge-bad'}>{money((snapshot?.position_items || []).reduce((sum, item) => sum + (item.profit || 0) + (item.swap || 0), 0), snapshot?.account_currency)}</strong></div>
        {snapshot?.balance != null && <div><span>BALANCE</span><strong>{money(snapshot.balance, snapshot.account_currency)}</strong></div>}
        {snapshot?.equity != null && <div><span>EQUITY</span><strong>{snapshot.account_currency || ''} {snapshot.equity.toLocaleString()}</strong></div>}
      </div>
      <div className="bridge-detail-section">
        <h3>Open positions ({snapshot?.position_items?.length || 0})</h3>
        {!snapshot?.position_items?.length ? <p className="muted">No position details received yet. Enable remote telemetry in the MT5 EA and wait for its next heartbeat.</p> :
          <div className="bridge-record-list">{snapshot.position_items.map((position, index) => <article className="bridge-record" key={position.ticket || index}>
            <div className="bridge-record-head"><strong>{position.symbol || 'Unknown symbol'} · {position.type || '—'}</strong><span>{position.volume ?? '—'} lots</span></div>
            <div className="bridge-record-grid">
              <span>Entry <b>{position.price_open ?? '—'}</b></span><span>Current <b>{position.price_current ?? '—'}</b></span>
              <span>Stop loss <b>{position.stop_loss || 'Not set'}</b></span><span>Take profit <b>{position.take_profit || 'Not set'}</b></span>
              <span>Floating P/L <b className={(position.profit || 0) + (position.swap || 0) >= 0 ? 'bridge-good' : 'bridge-bad'}>{money((position.profit || 0) + (position.swap || 0), snapshot.account_currency)}</b></span>
              <span>Opened <b>{tradeTime(position.time)}</b></span>
            </div>
          </article>)}</div>}
      </div>
      <div className="bridge-detail-section">
        <h3>Recent closing deals ({snapshot?.recent_closing_deals?.length || 0})</h3>
        {!snapshot?.recent_closing_deals?.length ? <p className="muted">No closing-deal history received yet. The EA sends up to 50 closing deals from the configured history window. Partial closes can appear as separate deals; these are not reconstructed full trades.</p> :
          <div className="bridge-record-list">{snapshot.recent_closing_deals.map((trade, index) => <article className="bridge-record" key={trade.ticket || index}>
            <div className="bridge-record-head"><strong>{trade.symbol || 'Unknown symbol'} · {trade.type || '—'}</strong><span>{trade.volume ?? '—'} lots</span></div>
            <div className="bridge-record-grid">
              <span>Close price <b>{trade.price ?? '—'}</b></span>
              <span>Net result <b className={(trade.profit || 0) + (trade.swap || 0) + (trade.commission || 0) >= 0 ? 'bridge-good' : 'bridge-bad'}>{money((trade.profit || 0) + (trade.swap || 0) + (trade.commission || 0), snapshot.account_currency)}</b></span>
              <span>Closed <b>{tradeTime(trade.time)}</b></span>
            </div>
          </article>)}</div>}
      </div>
      <p className="bridge-last-seen">Last heartbeat: {dateLabel(heartbeatTime)}<br />Status checked: {lastChecked ? dateLabel(lastChecked.toISOString()) : '—'} · Auto-refresh every 30 seconds</p>
      <button type="button" className="bridge-secondary" onClick={() => void connect()} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh connection status'}</button>
      <button type="button" className="bridge-secondary danger" onClick={disconnect}>Disconnect this screen</button>
      <p className="score-note">Disconnecting removes the token from this screen only. To revoke the terminal's access, use the administrator revoke command in the MT5 README.</p>
    </>}
    <div className="bridge-safety-note"><b>Safety status</b><span>Read-only telemetry · No broker password collected · Remote orders disabled</span></div>
  </section>
}
