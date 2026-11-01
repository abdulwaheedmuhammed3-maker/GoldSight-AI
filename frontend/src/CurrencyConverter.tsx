import { useEffect, useMemo, useState } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')
type RateResponse = { status: 'LIVE' | 'STALE'; base: string; rates: Record<string, number>; currency_count: number; provider: string; provider_updated_at: string | null; fetched_at: string; refresh_interval_seconds: number; disclaimer: string; warning?: string }
const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' })
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
// Primary ISO-4217 currency-to-country mappings. Shared currencies use a representative
// country; the note below makes clear that this is not an exclusive country relationship.
const countryByCurrency: Record<string, string> = {
  AED:'AE', AFN:'AF', ALL:'AL', AMD:'AM', ANG:'CW', AOA:'AO', ARS:'AR', AUD:'AU', AWG:'AW', AZN:'AZ',
  BAM:'BA', BBD:'BB', BDT:'BD', BGN:'BG', BHD:'BH', BIF:'BI', BMD:'BM', BND:'BN', BOB:'BO', BRL:'BR', BSD:'BS', BTN:'BT', BWP:'BW', BYN:'BY', BZD:'BZ',
  CAD:'CA', CDF:'CD', CHF:'CH', CLP:'CL', CNY:'CN', COP:'CO', CRC:'CR', CUP:'CU', CVE:'CV', CZK:'CZ',
  DJF:'DJ', DKK:'DK', DOP:'DO', DZD:'DZ',
  EGP:'EG', ERN:'ER', ETB:'ET', EUR:'EU',
  FJD:'FJ', FKP:'FK',
  GBP:'GB', GEL:'GE', GHS:'GH', GIP:'GI', GMD:'GM', GNF:'GN', GTQ:'GT', GYD:'GY',
  HKD:'HK', HNL:'HN', HTG:'HT', HUF:'HU',
  IDR:'ID', ILS:'IL', INR:'IN', IQD:'IQ', IRR:'IR', ISK:'IS',
  JMD:'JM', JOD:'JO', JPY:'JP',
  KES:'KE', KGS:'KG', KHR:'KH', KMF:'KM', KPW:'KP', KRW:'KR', KWD:'KW', KYD:'KY', KZT:'KZ',
  LAK:'LA', LBP:'LB', LKR:'LK', LRD:'LR', LSL:'LS', LYD:'LY',
  MAD:'MA', MDL:'MD', MGA:'MG', MKD:'MK', MMK:'MM', MNT:'MN', MOP:'MO', MRU:'MR', MUR:'MU', MVR:'MV', MWK:'MW', MXN:'MX', MYR:'MY', MZN:'MZ',
  NAD:'NA', NGN:'NG', NIO:'NI', NOK:'NO', NPR:'NP', NZD:'NZ',
  OMR:'OM',
  PAB:'PA', PEN:'PE', PGK:'PG', PHP:'PH', PKR:'PK', PLN:'PL', PYG:'PY',
  QAR:'QA',
  RON:'RO', RSD:'RS', RUB:'RU', RWF:'RW',
  SAR:'SA', SBD:'SB', SCR:'SC', SDG:'SD', SEK:'SE', SGD:'SG', SHP:'SH', SLE:'SL', SOS:'SO', SRD:'SR', SSP:'SS', STN:'ST', SYP:'SY', SZL:'SZ',
  THB:'TH', TJS:'TJ', TMT:'TM', TND:'TN', TOP:'TO', TRY:'TR', TTD:'TT', TWD:'TW', TZS:'TZ',
  UAH:'UA', UGX:'UG', USD:'US', UYU:'UY', UZS:'UZ',
  VES:'VE', VND:'VN', VUV:'VU',
  WST:'WS',
  XAF:'CM', XCD:'AG', XOF:'SN', XPF:'PF',
  YER:'YE',
  ZAR:'ZA', ZMW:'ZM', ZWG:'ZW'
}
const currencyNameFallback: Record<string, string> = {
  AFN:'Afghan Afghani', ALL:'Albanian Lek', AMD:'Armenian Dram', ANG:'Caribbean Guilder', AOA:'Angolan Kwanza',
  AWG:'Aruban Florin', AZN:'Azerbaijani Manat', BAM:'Bosnia-Herzegovina Convertible Mark', BBD:'Barbadian Dollar',
  BIF:'Burundian Franc', BMD:'Bermudian Dollar', BND:'Brunei Dollar', BSD:'Bahamian Dollar', BTN:'Bhutanese Ngultrum',
  BZD:'Belize Dollar', CDF:'Congolese Franc', CLP:'Chilean Peso', COP:'Colombian Peso', CRC:'Costa Rican Colón',
  CUP:'Cuban Peso', CVE:'Cape Verdean Escudo', DJF:'Djiboutian Franc', DOP:'Dominican Peso', ERN:'Eritrean Nakfa',
  FJD:'Fijian Dollar', FKP:'Falkland Islands Pound', GEL:'Georgian Lari', GIP:'Gibraltar Pound', GMD:'Gambian Dalasi',
  GNF:'Guinean Franc', GTQ:'Guatemalan Quetzal', GYD:'Guyanaese Dollar', HNL:'Honduran Lempira', HTG:'Haitian Gourde',
  IQD:'Iraqi Dinar', IRR:'Iranian Rial', ISK:'Icelandic Króna', JMD:'Jamaican Dollar', JOD:'Jordanian Dinar',
  KGS:'Kyrgyzstani Som', KHR:'Cambodian Riel', KMF:'Comorian Franc', KPW:'North Korean Won', KWD:'Kuwaiti Dinar',
  KYD:'Cayman Islands Dollar', KZT:'Kazakhstani Tenge', LAK:'Lao Kip', LBP:'Lebanese Pound', LRD:'Liberian Dollar',
  LSL:'Lesotho Loti', LYD:'Libyan Dinar', MDL:'Moldovan Leu', MGA:'Malagasy Ariary', MKD:'Macedonian Denar',
  MMK:'Myanmar Kyat', MNT:'Mongolian Tögrög', MOP:'Macanese Pataca', MRU:'Mauritanian Ouguiya',
  MVR:'Maldivian Rufiyaa', MWK:'Malawian Kwacha', MZN:'Mozambican Metical', NIO:'Nicaraguan Córdoba',
  NPR:'Nepalese Rupee', OMR:'Omani Rial', PAB:'Panamanian Balboa', PGK:'Papua New Guinean Kina',
  PYG:'Paraguayan Guaraní', QAR:'Qatari Riyal', RON:'Romanian Leu', RSD:'Serbian Dinar',
  SBD:'Solomon Islands Dollar', SCR:'Seychellois Rupee', SDG:'Sudanese Pound', SHP:'Saint Helena Pound',
  SLE:'Sierra Leonean Leone', SOS:'Somali Shilling', SRD:'Surinamese Dollar', SSP:'South Sudanese Pound',
  STN:'São Tomé and Príncipe Dobra', SYP:'Syrian Pound', SZL:'Swazi Lilangeni', TJS:'Tajikistani Somoni',
  TMT:'Turkmenistani Manat', TOP:'Tongan Paʻanga', TTD:'Trinidad and Tobago Dollar', TWD:'New Taiwan Dollar',
  UYU:'Uruguayan Peso', UZS:'Uzbekistani Som', VES:'Venezuelan Bolívar', VUV:'Vanuatu Vatu',
  WST:'Samoan Tala', YER:'Yemeni Rial', ZWG:'Zimbabwe Gold'
}
const capitals: Record<string, string> = {
  NG:'Abuja', US:'Washington, D.C.', GB:'London', CA:'Ottawa', AU:'Canberra', NZ:'Wellington', CH:'Bern', JP:'Tokyo', CN:'Beijing', IN:'New Delhi', ZA:'Pretoria', GH:'Accra', KE:'Nairobi', UG:'Kampala', SN:'Dakar', CM:'Yaoundé', EG:'Cairo', AE:'Abu Dhabi', SA:'Riyadh', QA:'Doha', TR:'Ankara', BR:'Brasília', MX:'Mexico City', SG:'Singapore', HK:'Hong Kong', KR:'Seoul', ID:'Jakarta', MY:'Kuala Lumpur', TH:'Bangkok', PH:'Manila', PK:'Islamabad', BD:'Dhaka', RU:'Moscow', PL:'Warsaw', SE:'Stockholm', NO:'Oslo', DK:'Copenhagen', CZ:'Prague', HU:'Budapest', IL:'Jerusalem', MA:'Rabat', TN:'Tunis', ET:'Addis Ababa', RW:'Kigali', TZ:'Dodoma', ZM:'Lusaka', MU:'Port Louis', BW:'Gaborone', NA:'Windhoek', DZ:'Algiers', LK:'Sri Jayawardenepura Kotte', VN:'Hanoi',
  AF:'Kabul', AL:'Tirana', AM:'Yerevan', AO:'Luanda', AR:'Buenos Aires', AW:'Oranjestad', AZ:'Baku', BA:'Sarajevo', BB:'Bridgetown', BG:'Sofia', BH:'Manama', BI:'Gitega', BM:'Hamilton', BO:'Sucre', BS:'Nassau', BT:'Thimphu', BY:'Minsk', BZ:'Belmopan', CD:'Kinshasa', CL:'Santiago', CO:'Bogotá', CR:'San José', CU:'Havana', CV:'Praia', DJ:'Djibouti', DO:'Santo Domingo', ER:'Asmara', FJ:'Suva', GE:'Tbilisi', GM:'Banjul', GN:'Conakry', GT:'Guatemala City', GY:'Georgetown', HN:'Tegucigalpa', HT:'Port-au-Prince', IQ:'Baghdad', IR:'Tehran', IS:'Reykjavík', JM:'Kingston', JO:'Amman', KG:'Bishkek', KH:'Phnom Penh', KM:'Moroni', KP:'Pyongyang', KW:'Kuwait City', KZ:'Astana', LA:'Vientiane', LB:'Beirut', LR:'Monrovia', LS:'Maseru', LY:'Tripoli', MD:'Chișinău', MG:'Antananarivo', MK:'Skopje', MM:'Naypyidaw', MN:'Ulaanbaatar', MR:'Nouakchott', MV:'Malé', MW:'Lilongwe', MZ:'Maputo', NI:'Managua', NP:'Kathmandu', OM:'Muscat', PA:'Panama City', PE:'Lima', PG:'Port Moresby', PY:'Asunción', RO:'Bucharest', RS:'Belgrade', SB:'Honiara', SC:'Victoria', SD:'Khartoum', SL:'Freetown', SO:'Mogadishu', SR:'Paramaribo', SS:'Juba', ST:'São Tomé', SY:'Damascus', SZ:'Mbabane', TJ:'Dushanbe', TM:'Ashgabat', TO:'Nukuʻalofa', TT:'Port of Spain', TW:'Taipei', UA:'Kyiv', UY:'Montevideo', UZ:'Tashkent', VE:'Caracas', VU:'Port Vila', WS:'Apia', YE:'Sana’a', ZW:'Harare', EU:'Brussels (EU institutions)', CW:'Willemstad', AG:'St. John’s', PF:'Papeete', FK:'Stanley', GI:'Gibraltar', MO:'Macau', SH:'Jamestown'
}
const flagFor = (region?: string) => region && region.length === 2 ? String.fromCodePoint(...[...region.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '🌐'
const countryInfo = (code: string) => {
  const region = countryByCurrency[code]
  const country = region === 'EU' ? 'Euro area' : region ? regionNames.of(region) || region : 'Country mapping unavailable'
  const capital = region === 'EU' ? 'Brussels (EU institutions)' : region ? capitals[region] || 'Capital not specified' : 'Capital not specified'
  return { region, country, capital, flag: region === 'EU' ? '🇪🇺' : flagFor(region) }
}
const money = (value: number, code: string) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 4 }).format(value) } catch { return value.toLocaleString() + ' ' + code } }

export default function CurrencyConverter() {
  const [base, setBase] = useState('USD')
  const [target, setTarget] = useState('NGN')
  const [amount, setAmount] = useState('1')
  const [baseSearch, setBaseSearch] = useState('')
  const [targetSearch, setTargetSearch] = useState('')
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
  const currencyLabel = (code: string) => currencyNameFallback[code] || currencyNames.of(code) || code
  const getSuggestions = (query: string) => {
    const term = query.trim().toLocaleLowerCase()
    if (!term) return []
    return choices.filter(code => {
      const info = countryInfo(code)
      const fields = [info.country, info.capital, currencyLabel(code), code]
      return fields.some(value => value.toLocaleLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').startsWith(term.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')))
    }).slice(0, 8)
  }
  const baseSuggestions = getSuggestions(baseSearch)
  const targetSuggestions = getSuggestions(targetSearch)
  const flagImage = (region?: string) => region ? 'https://flagcdn.com/w80/' + region.toLowerCase() + '.png' : ''
  return <section className="panel pip-panel currency-panel">
    <div className="panel-head"><div><p className="eyebrow">GLOBAL MONEY TOOLS</p><h2>Live Currency Converter</h2></div><span className="history-count">{data?.status === 'LIVE' ? 'RATES LIVE' : data?.status === 'STALE' ? 'STALE RATES' : busy ? 'UPDATING' : 'OFFLINE'}</span></div>
    <div className="pip-fields">
      <label>Amount<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Enter amount" /></label>
      <label className="currency-search-field">Search from country, capital or currency<input type="search" value={baseSearch} onChange={event => setBaseSearch(event.target.value)} placeholder="Type a country, e.g. Nigeria" autoComplete="off" /></label>
      {baseSuggestions.length > 0 && <div className="currency-suggestions" role="listbox" aria-label="Matching from currencies">{baseSuggestions.map(code => { const info = countryInfo(code); return <button type="button" role="option" aria-selected={base === code} key={code} onClick={() => { setBase(code); setBaseSearch('') }}><span className="suggestion-flag">{info.flag}</span><span className="suggestion-copy"><strong>{info.country}</strong><small>{currencyLabel(code)} · {code} · {info.capital}</small></span><span className="suggestion-select">{base === code ? 'Selected' : 'Select'}</span></button> })}</div>}
      <div className="currency-current-selection"><span>FROM</span><strong>{fromInfo.flag} {base} · {currencyLabel(base)}</strong><small>{fromInfo.country} · {fromInfo.capital}</small></div>
      <label className="currency-search-field">Search to country, capital or currency<input type="search" value={targetSearch} onChange={event => setTargetSearch(event.target.value)} placeholder="Type a country, e.g. Japan" autoComplete="off" /></label>
      {targetSuggestions.length > 0 && <div className="currency-suggestions" role="listbox" aria-label="Matching to currencies">{targetSuggestions.map(code => { const info = countryInfo(code); return <button type="button" role="option" aria-selected={target === code} key={code} onClick={() => { setTarget(code); setTargetSearch('') }}><span className="suggestion-flag">{info.flag}</span><span className="suggestion-copy"><strong>{info.country}</strong><small>{currencyLabel(code)} · {code} · {info.capital}</small></span><span className="suggestion-select">{target === code ? 'Selected' : 'Select'}</span></button> })}</div>}
      <div className="currency-current-selection"><span>TO</span><strong>{toInfo.flag} {target} · {currencyLabel(target)}</strong><small>{toInfo.country} · {toInfo.capital}</small></div>
    </div>
    <div className="currency-country-pair">
      <article><span className="currency-flag-fallback" style={{display: fromInfo.region && fromInfo.region !== 'EU' ? 'none' : 'inline-flex'}} aria-label={fromInfo.country + " flag"}>{fromInfo.flag}</span>{fromInfo.region && fromInfo.region !== 'EU' && <img className="currency-flag-image" src={flagImage(fromInfo.region)} alt="" onError={event => { event.currentTarget.style.display = "none"; const fallback = event.currentTarget.previousElementSibling as HTMLElement | null; if (fallback) fallback.style.display = "inline-flex" }} />}<div><b>{fromInfo.country}</b><small>{fromInfo.capital} · {base} · {currencyLabel(base)}</small></div></article>
      <span className="currency-arrow">→</span>
      <article><span className="currency-flag-fallback" style={{display: toInfo.region && toInfo.region !== 'EU' ? 'none' : 'inline-flex'}} aria-label={toInfo.country + " flag"}>{toInfo.flag}</span>{toInfo.region && toInfo.region !== 'EU' && <img className="currency-flag-image" src={flagImage(toInfo.region)} alt="" onError={event => { event.currentTarget.style.display = "none"; const fallback = event.currentTarget.previousElementSibling as HTMLElement | null; if (fallback) fallback.style.display = "inline-flex" }} />}<div><b>{toInfo.country}</b><small>{toInfo.capital} · {target} · {currencyLabel(target)}</small></div></article>
    </div>
    <div className="pip-direction"><button className="refresh" onClick={() => { setBase(target); setTarget(base) }}>⇄ Swap currencies</button><button className="refresh" onClick={() => { setData(null); setError(''); void fetch(API + '/api/v1/currencies/' + base, { cache: 'no-store' }).then(async r => { const json = await r.json(); if (!r.ok) throw new Error(json.detail || 'Refresh failed'); setData(json) }).catch(e => setError(e instanceof Error ? e.message : 'Could not refresh rates.')) }} disabled={busy}>↻ Refresh</button></div>
    {converted == null || safeRate === null ? <div className="pip-error">{error || 'This currency pair is not available yet. Choose another currency or refresh rates.'}</div> : <div className="pip-results"><article><span>CONVERTED AMOUNT</span><strong>{money(converted, target)}</strong><small>{Number(amount).toLocaleString()} {base} × {safeRate.toLocaleString(undefined, { maximumFractionDigits: 8 })}</small></article><article><span>EXCHANGE RATE</span><strong>1 {base} = {safeRate.toLocaleString(undefined, { maximumFractionDigits: 8 })} {target}</strong><small>1 {target} = {(1 / safeRate).toLocaleString(undefined, { maximumFractionDigits: 8 })} {base}</small></article></div>}
    <details className="rate-details"><summary>Rate source & update</summary><p>{data?.currency_count ?? '—'} currencies · {data?.provider || 'Open Exchange Rate API'} · Updated {updated}. Reference rates refresh every 15 minutes.</p></details>
    {data?.warning && <p className="pip-error">{data.warning}</p>}
    <p className="score-note">Reference rates only · Not broker execution prices. Country and capital labels are representative mappings only; some currencies are shared by multiple countries or territories.</p>
  </section>
}
