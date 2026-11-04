import { useEffect, useState } from 'react'

type Lesson = { id: string; title: string; summary: string; body: string; question: string; options: string[]; answer: number; explanation: string }
const lessons: Lesson[] = [
 { id:'structure', title:'01 · Market structure', summary:'Swing highs/lows, BOS and CHoCH', body:'A swing high is a local peak and a swing low a local trough. A BOS is a close beyond a meaningful swing in the trend direction; a CHoCH is an early break against it. Neither guarantees continuation or reversal. Define invalidation and wait for follow-through.', question:'What best describes a bullish BOS?', options:['Price wicks below a swing low','A candle closes above a meaningful prior swing high','Price touches a moving average'], answer:1, explanation:'A close beyond a meaningful swing high is a more useful structural confirmation than a wick alone.' },
 { id:'liquidity', title:'02 · Liquidity', summary:'Equal highs/lows and sweeps', body:'Stops may cluster beyond obvious highs, lows and prior-day levels. A sweep is price moving beyond a level and closing back inside. It is not an entry signal by itself; price can continue either way. Look for confirmation and a clear invalidation point.', question:'After a liquidity sweep, what should you do?', options:['Enter immediately every time','Assume reversal is guaranteed','Wait for your planned confirmation and assess invalidation'], answer:2, explanation:'A sweep alone does not prove reversal. Confirmation and risk definition matter.' },
 { id:'risk', title:'03 · Risk management', summary:'Cash risk, position sizing, R:R', body:'Choose maximum cash risk first. Position size depends on cash risk, entry-to-stop distance, instrument value and contract specifications. Stops belong where the setup is invalidated—not where they make sizing convenient. Include spread, commission and slippage.', question:'What should determine position size?', options:['Your maximum cash risk and stop distance, with contract value accounted for','How confident you feel','A fixed lot size for every setup'], answer:0, explanation:'Risk-based sizing adapts to stop distance and instrument value.' },
 { id:'execution', title:'04 · Execution', summary:'Top-down process and confirmation', body:'Set context on 4H/1H: trend or range, structure and key levels. Use 15M/5M for the trigger you planned. Record entry, stop, target and cancellation condition. Do not chase after price leaves the entry zone; review a series of trades.', question:'If your planned trigger is missing, what is the disciplined action?', options:['Force an entry','Wait or skip the trade','Widen the stop'], answer:1, explanation:'A missing confirmation means the setup is not complete.' },
 { id:'gold', title:'05 · Gold (XAUUSD)', summary:'Volatility, news and spread', body:'Gold may react to US inflation, employment, central-bank decisions, yields and USD moves; these are not reliable predictions by themselves. Spreads can widen and execution slip during fast markets. Check calendar and broker specifications; size to the invalidation stop.', question:'What risk can increase during fast gold news?', options:['Spread widening and slippage','Guaranteed fills at the requested price','Stops becoming unnecessary'], answer:0, explanation:'Fast markets can produce wider costs and worse stop fills.' },
 { id:'journal', title:'06 · Trading journal', summary:'Review outcomes in R and process', body:'Before trade: record bias, setup evidence, trigger, stop, target, cash risk and event context. After: record actual fills, costs, result in money and R, rule adherence and screenshots. Analyze meaningful samples; change one rule at a time.', question:'What does a result of +2R mean?', options:['Two times the account balance','Profit equal to twice the initial risk','Two winning trades'], answer:1, explanation:'R expresses the result as a multiple of the initial planned risk.' },
]
const STORAGE_KEY = 'goldsight-education-progress-v1'
export default function Education() {
 const [completed, setCompleted] = useState<string[]>([])
 const [answers, setAnswers] = useState<Record<string, number>>({})
 const [feedback, setFeedback] = useState<Record<string, boolean>>({})
 useEffect(() => { try { const saved = window.localStorage.getItem(STORAGE_KEY); if (saved) setCompleted(JSON.parse(saved) as string[]) } catch { /* local progress is optional */ } }, [])
 const markComplete = (id: string) => { const next = [...new Set([...completed, id])]; setCompleted(next); try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* storage may be unavailable */ } }
 const reset = () => { setCompleted([]); setAnswers({}); setFeedback({}); try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* storage may be unavailable */ } }
 return <section className="education-dashboard">
  <div className="tab-hero education-hero"><p className="eyebrow">TRADE SMARTER · BUILD SKILL</p><h2>Trading Education</h2><p className="muted">Learn the process, test your understanding, and track your lesson progress. Examples are educational—not trade signals.</p></div>
  <section className="panel" style={{padding:16,marginBottom:16}} aria-label="Learning progress">
   <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center',flexWrap:'wrap'}}><strong>Learning progress</strong><span>{completed.length} / {lessons.length} lessons completed</span></div>
   <div role="progressbar" aria-label="Lessons completed" aria-valuemin={0} aria-valuemax={lessons.length} aria-valuenow={completed.length} style={{height:8,background:'var(--border-color, #394150)',borderRadius:8,overflow:'hidden',marginTop:10}}><div style={{height:'100%',width:`${completed.length / lessons.length * 100}%`,background:'var(--accent-color, #28c994)',transition:'width .2s'}} /></div>
   <button type="button" onClick={reset} style={{marginTop:12}}>Reset progress</button>
  </section>
  <div className="education-grid">{lessons.map((lesson) => <details className="panel education-topic" key={lesson.id}>
   <summary><span className="education-topic-heading"><span className="education-step">{lesson.id.toUpperCase()}</span><strong>{lesson.title}</strong><small>{lesson.summary}{completed.includes(lesson.id) ? ' · Completed ✓' : ''}</small></span><span className="education-expand" aria-hidden="true">+</span></summary>
   <div className="education-topic-content" style={{padding:16}}>
    <section><h4>Lesson</h4><p>{lesson.body}</p></section>
    <section style={{marginTop:16,borderTop:'1px solid var(--border-color, #394150)',paddingTop:12}}>
     <h4>Quick check</h4><p>{lesson.question}</p>
     {lesson.options.map((option,index)=><label key={option} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'8px 4px',cursor:'pointer'}}><input type="radio" name={lesson.id} checked={answers[lesson.id]===index} onChange={()=>{setAnswers(prev=>({...prev,[lesson.id]:index}));setFeedback(prev=>({...prev,[lesson.id]:false}))}} /> <span>{option}</span></label>)}
     <button type="button" disabled={answers[lesson.id]===undefined} onClick={()=>setFeedback(prev=>({...prev,[lesson.id]:true}))} style={{marginTop:8}}>Check answer</button>
     {feedback[lesson.id] && <p role="status" style={{marginTop:10}}><strong>{answers[lesson.id]===lesson.answer?'Correct!':'Not quite.'}</strong> {lesson.explanation}</p>}
     {answers[lesson.id]===lesson.answer && feedback[lesson.id] && <button type="button" onClick={()=>markComplete(lesson.id)} style={{marginTop:8}}>{completed.includes(lesson.id)?'Lesson completed ✓':'Mark lesson complete'}</button>}
    </section>
   </div>
  </details>)}</div>
  <p className="score-note">Educational material only. Quiz completion does not certify trading skill. Never treat examples as guarantees or recommendations.</p>
 </section>
}
