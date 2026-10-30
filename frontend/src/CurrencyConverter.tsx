import { useEffect, useMemo, useState } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\\/$/, '')
type RateResponse = { status: 'LIVE' | 'STALE'; base: string; rates: Record<string, number>; currency_count: number; provider: string; provider_updated_at: string | null; fetched_at: string; refresh_interval_seconds: number; disclaimer: string; warning?: string }
const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' })
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const countryByCurrency: Record<string, string> = {
  NGN:'NG', USD:'US', EUR:'EU', GBP:'GB', CAD:'CA', AUD:'AU', NZD:'NZ', CHF:'CH', JPY:'JP', CNY:'CN', INR:'IN', ZAR:'ZA', GHS:'GH', KES:'KE', UGX:'UG', XOF:'SN', XAF:'CM', EGP:'EG', AED:'AE', SAR:'SA', QAR:'QA', TRY:'TR', BRL:'BR', MXN:'MX', SGD:'SG', HKD:'HK', KRW:'KR', IDR:'ID', MYR:'MY', THB:'TH', PHP:'PH', PKR:'PK', BDT:'BD', RUB:'RU', PLN:'PL', SEK:'SE', NOK:'NO', DKK:'DK', CZK:'CZ', HUF:'HU', ILS:'IL', MAD:'MA', TND:'TN', ETB:'ET', RWF:'RW', TZS:'TZ', ZMW:'ZM', MUR:'MU', BWP:'BW', NAD:'NA', DZD:'DZ', LKR:'LK', VND:'VN'
}
const capitals: Record<string, string> = {
  NG:'Abuja', US:'Washington, D.C.', GB:'London', CA:'Ottawa', AU:'Canberra', NZ:'Wellington', CH:'Bern', JP:'Tokyo', CN:'Beijing', IN:'New Delhi', ZA:'Pretoria', GH:'Accra', KE:'Nairobi', UG:'Kampala', SN:'Dakar', CM:'Yaoundé', EG:'Cairo', AE:'Abu Dhabi', SA:'Riyadh', QA:'Doha', TR:'Ankara', BR:'Brasília', MX:'Mexico City', SG:'Singapore', HK:'Hong Kong', KR:'Seoul', ID:'Jakarta', MY:'Kuala Lumpur', TH:'Bangkok', PH:'Manila', PK:'Islamabad', BD:'Dhaka', RU:'Moscow', PL:'Warsaw', SE:'Stockholm', NO:'Oslo', DK:'Copenhagen', CZ:'Prague', HU:'Budapest', IL:'Jerusalem', MA:'Rabat', TN:'Tunis', ET:'Addis Ababa', RW:'Kigali', TZ:'Dodoma', ZM:'Lusaka', MU:'Port Louis', BW:'Gaborone', NA:'Windhoek', DZ:'Algiers', LK:'Sri Jayawardenepura Kotte', VN:'Hanoi'
}
const flagFor = (region?: string) => region && region.length === 2 ? String.fromCodePoint(...[...region.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '🌐'
const countryInfo = (code: string) => {
  const region = countryByCurrency[code]
  const country = region === 'EU' ? 'Euro area' : region ? regionNames.of(region) || region : 'Country/region not mapped'
  const capital = region === 'EU' ? 'Brussels (EU institutions)' : region ? capitals[region] || 'Capital not listed' : 'Capital not listed'
  return { region, country, capital, flag: region === 'EU' ? '🇪🇺' : flagFor(region) }
}
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
  const safeRate = typeof rate === 'number' && Number.isFinite(rate) ? rate : null
  const numericAmount = Number(amount)
  const converted = Number.isFinite(numericAmount) && numericAmount >= 0 && safeRate !== null ? numericAmount * safeRate : null
  const updated = data?.provider_updated_at ? new Date(data.provider_updated_at).toLocaleString() : '—'
  const choices = currencies.length ? currencies : ['USD','EUR','GBP','NGN']
  const fromInfo = countryInfo(base)
  const toInfo = countryInfo(target)
  const optionLabel = (code: string) => { const info = countryInfo(code); return `${info.flag} ${code} · ${currencyNames.of(code) || code} · ${info.country}` }
  return <section className="panel pip-panel currency-panel">
    <div className="panel-head"><div><p className="eyebrow">GLOBAL MONEY TOOLS</p><h2>Live Currency Converter</h2></div><span className="history-count">{data?.status === 'LIVE' ? 'RATES LIVE' : data?.status === 'STALE' ? 'STALE RATES' : busy ? 'UPDATING' : 'OFFLINE'}</span></div>
    <div className="pip-fields">
      <label>Amount<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Enter amount" /></label>
      <label>From currency<select value={base} onChange={event => setBase(event.target.value)}>{choices.map(code => <option key={code} value={code}>{optionLabel(code)}</option>)}</select></label>
      <label>To currency<select value={target} onChange={event => setTarget(event.target.value)}>{choices.map(code => <option key={code} value={code}>{optionLabel(code)}</option>)}</select></label>
    </div>
    <div className="currency-country-pair">
      <article><span className="currency-flag">{fromInfo.flag}</span><div><b>{fromInfo.country}</b><small>{fromInfo.capital} · {base}</small></div></article>
      <span className="currency-arrow">→</span>
      <article><span className="currency-flag">{toInfo.flag}</span><div><b>{toInfo.country}</b><small>{toInfo.capital} · {target}</small></div></article>
    </div>
    <div className="pip-direction"><button className="refresh" onClick={() => { setBase(target); setTarget(base) }}>⇄ Swap currencies</button><button className="refresh" onClick={() => { setData(null); setError(''); void fetch(API + '/api/v1/currencies/' + base, { cache: 'no-store' }).then(async r => { const json = await r.json(); if (!r.ok) throw new Error(json.detail || 'Refresh failed'); setData(json) }).catch(e => setError(e instanceof Error ? e.message : 'Could not refresh rates.')) }} disabled={busy}>↻ Refresh</button></div>
    {converted == null || safeRate === null ? <div className="pip-error">{error || 'This currency pair is not available yet. Choose another currency or refresh rates.'}</div> : <div className="pip-results"><article><span>CONVERTED AMOUNT</span><strong>{money(converted, target)}</strong><small>{Number(amount).toLocaleString()} {base} × {safeRate.toLocaleString(undefined, { maximumFractionDigits: 8 })}</small></article><article><span>EXCHANGE RATE</span><strong>1 {base} = {safeRate.toLocaleString(undefined, { maximumFractionDigits: 8 })} {target}</strong><small>1 {target} = {(1 / safeRate).toLocaleString(undefined, { maximumFractionDigits: 8 })} {base}</small></article></div>}
    <details className="rate-details"><summary>Rate source & update</summary><p>{data?.currency_count ?? '—'} currencies · {data?.provider || 'Open Exchange Rate API'} · Updated {updated}. Reference rates refresh every 15 minutes.</p></details>
    {data?.warning && <p className="pip-error">{data.warning}</p>}
    <p className="score-note">Reference rates only · Not broker execution prices. Capital names are informational; some currencies are shared by multiple countries, so the country shown is the primary mapping.</p>
  </section>
}
