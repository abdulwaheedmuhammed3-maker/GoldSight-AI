import { useEffect, useState } from 'react'
import { readDataCache, writeDataCache } from './dataCache'

const API = (import.meta.env.VITE_API_BASE_URL || 'https://goldsight-ai-api.onrender.com').replace(/\/$/, '')

function MacroLine({title,unit,points}:{title:string;unit:string;points:{year:number;value:number}[]}) {
  const values=points.slice(-12), min=Math.min(...values.map(p=>p.value)), max=Math.max(...values.map(p=>p.value)), span=max-min||1
  const coords=values.map((p,i)=>`${values.length<2?50:8+i*84/(values.length-1)},${88-(p.value-min)/span*70}`).join(' ')
  return <article className="ng-macro-chart"><div className="ng-macro-chart-head"><b>{title}</b><small>{unit}</small></div>{values.length>1?<><svg viewBox="0 0 100 100" role="img" aria-label={title+' annual trend'} preserveAspectRatio="none"><polyline points={coords} fill="none" stroke="#20c997" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>{values.map((p,i)=><circle key={p.year} cx={values.length<2?50:8+i*84/(values.length-1)} cy={88-(p.value-min)/span*70} r="1.8" fill="#20c997" vectorEffect="non-scaling-stroke"/>)}</svg><div className="ng-macro-chart-foot"><span>{values[0].year}</span><b>{values[values.length-1].value.toLocaleString('en-NG',{maximumFractionDigits:2})}{unit==='%'?'%':''}</b><span>{values[values.length-1].year}</span></div></>:<p className="muted">Historical series unavailable.</p>}</article>
}

export default function StockPortfolio() {
  const [nigeriaData,setNigeriaData] = useState<any>(() => {
    const cached = readDataCache<any>('tradesight-nigeria-economy-snapshot-v1',null)
    return cached ? { ...cached, status:'STALE' } : null
  })
  const [macroStatus,setMacroStatus] = useState(() => readDataCache<any>('tradesight-nigeria-economy-snapshot-v1',null) ? 'Showing saved Nigeria indicators while fresh data loads…' : 'Loading Nigeria economy data…')

  useEffect(() => {
    let active = true
    const fetchMacro = async () => {
      try {
        const response = await fetch(API+'/api/v1/nigeria/economy',{cache:'no-store'})
        const json = await response.json()
        if (!response.ok) throw new Error(json.detail || 'Nigeria economy data unavailable')
        if (active) {
          setNigeriaData(json)
          writeDataCache('tradesight-nigeria-economy-snapshot-v1',json)
          setMacroStatus(json.note || 'Nigeria data loaded')
        }
      } catch (error) {
        if (active) setMacroStatus(error instanceof Error ? error.message : 'Nigeria economy data unavailable; saved indicators retained.')
      }
    }
    void fetchMacro()
    const id = window.setInterval(fetchMacro,15*60*1000)
    return () => { active=false; window.clearInterval(id) }
  }, [])

  return <section className="panel stock-portfolio-panel nigeria-economy-dashboard">
    <div className="panel-head">
      <div><p className="eyebrow">NIGERIA · NAIRA & ECONOMY</p><h2>Nigerian Naira & Economy</h2><p className="muted">A focused view of the naira, inflation and Nigeria’s economic growth.</p></div>
      <span className={nigeriaData?.status==='LIVE'?'stock-live':'history-count'}>{nigeriaData?.status==='LIVE'?'DATA LOADED':'DATA STATUS'}</span>
    </div>
    <div className="ng-fx-card">
      <div><small>US DOLLAR / NIGERIAN NAIRA · USD/NGN</small><strong>{nigeriaData?.reference_fx?.ngn_per_usd ? '₦'+Number(nigeriaData.reference_fx.ngn_per_usd).toLocaleString('en-NG',{maximumFractionDigits:2}) : '—'}</strong><span>{nigeriaData?.reference_fx?.updated_at || 'Latest provider update unavailable'}</span></div>
      <b>🇳🇬 NIGERIAN NAIRA<br/><small>NGN</small></b>
    </div>
    <div className="ng-macro-grid">
      <MacroLine title="Naira exchange-rate history" unit="NGN per US$" points={nigeriaData?.indicators?.exchange_rate?.series || []}/>
      <MacroLine title="Real GDP growth" unit="%" points={nigeriaData?.indicators?.gdp_growth?.series || []}/>
      <MacroLine title="Consumer price inflation" unit="%" points={nigeriaData?.indicators?.inflation?.series || []}/>
    </div>
    <p className="score-note">{macroStatus} {nigeriaData?.note || ''}</p>
    <p className="score-note">Sources: World Bank World Development Indicators and open.er-api.com reference FX. Annual macro series are not live market prices; the USD/NGN quote is indicative, not the CBN NFEM fixing or parallel-market rate.</p>
  </section>
}
