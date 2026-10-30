import { useEffect, useMemo, useState } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai.onrender.com').replace(/\/$/, '')
type RateResponse = { status: 'LIVE' | 'STALE'; base: string; rates: Record<string, number>; currency_count: number; provider: string; provider_updated_at: string | null; fetched_at: string; refresh_interval_seconds: number; disclaimer: string; warning?: string }
const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' })
const money = (value: number, code: string) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 4 }).format(value) } catch { return value.toLocaleString() + ' ' + code } }

export default function CurrencyConverter() {
  const [base, setBase] = useState('USD')
  const [target, setTarget] = useState('NGN')
  const [amount, setAmount] = useState('1')
  const [data, setData] = useState<RateResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setBusy(true)
      try {
        const response = await fetch(API + '/api/v1/currencies/' + base, { cache: 'no-store' })
        const json = await response.json()
        if (!response.ok) throw new Error(json.detail || 'Currency rates are unavailable.')
        if (!cancelled) { setData(json); setError('') }
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load currency rates.') }
      finally { if (!cancelled) setBusy(false) }
    }
    void load()
    const timer = window.setInterval(() => void load(), 15 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [base])
  const currencies = useMemo(() => Object.keys(data?.rates || {}).sort(), [data])
  const rate = data?.rates?.[target]
  const numericAmount = Number(amount)
  const converted = Number.isFinite(numericAmount) && numericAmount >= 0 && typeof rate === 'number' ? numericAmount * rate : null
  const updated = data?.provider_updated_at ? new Date(data.provider_updated_at).toLocaleString() : '—'
  const choices = currencies.length ? currencies : ['USD','EUR','GBP','NGN']
  return <section className="panel pip-panel">
    <div className="panel-head"><div><p className="eyebrow">GLOBAL MONEY TOOLS</p><h2>Live Currency Converter</h2><p className="muted">Convert between currencies supported by the FX provider.</p></div><span className="history-count">{data?.status === 'LIVE' ? 'RATES LIVE' : data?.status === 'STALE' ? 'STALE RATES' : busy ? 'UPDATING' : 'OFFLINE'}</span></div>
    <div className="pip-fields">
      <label>Amount<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Enter amount" /></label>
      <label>From currency<select value={base} onChange={event => setBase(event.target.value)}>{choices.map(code => <option key={code} value={code}>{code} · {currencyNames.of(code) || code}</option>)}</select></label>
      <label>To currency<select value={target} onChange={event => setTarget(event.target.value)}>{choices.map(code => <option key={code} value={code}>{code} · {currencyNames.of(code) || code}</option>)}</select></label>
    </div>
    <div className="pip-direction"><button className="refresh" onClick={() => { setBase(target); setTarget(base) }}>⇄ Swap currencies</button><button className="refresh" onClick={() => { setData(null); setError(''); void fetch(API + '/api/v1/currencies/' + base, { cache: 'no-store' }).then(r => r.json()).then(setData).catch(() => setError('Could not refresh rates.')) }} disabled={busy}>↻ Refresh</button></div>
    {converted == null ? <div className="pip-error">{error || 'Enter a valid amount and wait for exchange rates.'}</div> : <div className="pip-results"><article><span>CONVERTED AMOUNT</span><strong>{money(converted, target)}</strong><small>{Number(amount).toLocaleString()} {base} × {rate.toLocaleString(undefined, { maximumFractionDigits: 8 })}</small></article><article><span>EXCHANGE RATE</span><strong>1 {base} = {rate.toLocaleString(undefined, { maximumFractionDigits: 8 })} {target}</strong><small>1 {target} = {(1 / rate).toLocaleString(undefined, { maximumFractionDigits: 8 })} {base}</small></article></div>}
    <p className="score-note">{data?.currency_count ?? '—'} currencies supported · Source: {data?.provider || 'Open Exchange Rate API'} · Provider updated: {updated}. App refreshes every 15 minutes; the provider publishes periodic reference rates, not tick-by-tick trading prices.</p>
    {data?.warning && <p className="pip-error">{data.warning}</p>}
    <p className="score-note">{data?.disclaimer || 'Reference exchange rates only. Actual bank, broker, card, cash-exchange and remittance rates may differ.'}</p>
  </section>
}
