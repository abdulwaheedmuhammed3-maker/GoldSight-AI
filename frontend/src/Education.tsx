import type { ReactNode } from 'react'

type DiagramKind = 'structure' | 'liquidity' | 'risk' | 'execution' | 'gold' | 'journal'

const topics: Array<{
  step: string
  title: string
  summary: string
  diagram: DiagramKind
  caption: string
  details: Array<{ heading: string; body: string }>
}> = [
  {
    step: '01 · FOUNDATIONS', title: 'Understand market structure',
    summary: 'Read swing highs and lows to describe trend and meaningful breaks.', diagram: 'structure',
    caption: 'Example uptrend: higher highs and higher lows; BOS is a close through a prior swing.',
    details: [
      { heading: 'Start with swings', body: 'A swing high is a peak with lower highs on either side; a swing low is a trough with higher lows around it. Use the 4H or 1H chart first so small price noise does not define the whole trend.' },
      { heading: 'BOS and CHoCH', body: 'A break of structure (BOS) is a decisive candle close beyond a meaningful prior swing in the current direction. A change of character (CHoCH) is an early break against that direction. Neither label guarantees continuation or reversal; wait for follow through and define where the idea is invalid.' },
      { heading: 'Practice', body: 'Mark the last two clear swing highs and lows, state whether they are rising or falling, and note which candle close would invalidate your view. Avoid redrawing swings after seeing the outcome.' },
    ],
  },
  {
    step: '02 · LIQUIDITY', title: 'Learn where liquidity rests',
    summary: 'Understand why obvious highs and lows can attract stop orders.', diagram: 'liquidity',
    caption: 'Illustration only: a wick above equal highs is a sweep, not an entry signal.',
    details: [
      { heading: 'Common liquidity areas', body: 'Stops often cluster just beyond equal highs, equal lows, recent swing points, and the prior day high or low. These are areas of interest, not guaranteed targets or proof of institutional activity.' },
      { heading: 'Wait for evidence', body: 'A sweep means price trades beyond an obvious level and then returns. It can keep going. For a reversal idea, wait for a strong move away and a confirmed structure shift; for continuation, wait for acceptance beyond the level.' },
      { heading: 'Plan the invalidation', body: 'Decide what price action disproves the idea before entering. If the stop would need to sit inside ordinary noise or makes the planned risk too large, skip the trade.' },
    ],
  },
  {
    step: '03 · RISK MANAGEMENT', title: 'Protect the account first',
    summary: 'Set the loss you can afford before you calculate position size.', diagram: 'risk',
    caption: 'Risk is measured from entry to stop; reward is measured from entry to target.',
    details: [
      { heading: 'Define risk in money', body: 'Choose a fixed, modest amount or percentage of account equity for the trade. The stop belongs at the price that invalidates the setup, not wherever it produces the largest position.' },
      { heading: 'Size from the stop', body: 'Position size = allowed cash risk ÷ (entry-to-stop distance × value per price unit). Include spread, commission, contract size, and currency conversion where relevant. Check broker specifications before placing an order.' },
      { heading: 'Check reward and exposure', body: 'Compare the next realistic target with the planned loss, and consider nearby support, resistance, and scheduled news. A favorable reward-to-risk estimate does not make a weak setup safe. Never widen a stop to avoid recording a loss.' },
    ],
  },
  {
    step: '04 · EXECUTION', title: 'Build a repeatable setup',
    summary: 'Use a top down checklist and let unclear conditions pass.', diagram: 'execution',
    caption: 'Example workflow. A missing confirmation is a reason to wait, not force a trade.',
    details: [
      { heading: 'Set context first', body: 'Use 4H or 1H to identify direction, key levels, and nearby liquidity. Check whether price is trending, ranging, or reacting to a major level.' },
      { heading: 'Wait for lower timeframe evidence', body: 'On 15M or 5M, wait for the planned event: for example, a liquidity sweep followed by displacement and a structure break. Write down the exact entry trigger, stop, target, and what cancels the setup.' },
      { heading: 'Review execution', body: 'Do not chase a candle after the entry zone is gone. Record whether you followed the plan, including spread and slippage. A good process can still lose; evaluate a series of trades rather than changing rules after one result.' },
    ],
  },
  {
    step: '05 · GOLD (XAUUSD)', title: 'Respect gold’s volatility',
    summary: 'Gold can move sharply, and execution conditions can change quickly.', diagram: 'gold',
    caption: 'Large candles and wider spreads can make an otherwise sensible stop unreliable.',
    details: [
      { heading: 'Know what can move it', body: 'Gold can react to US inflation and employment reports, central bank decisions, Treasury yields, and changes in the US dollar. These relationships vary; none predicts the next move by itself.' },
      { heading: 'Check execution conditions', body: 'Around fast markets, spreads may widen, prices may jump, and a stop can fill at a worse price than requested. Check the economic calendar and broker conditions, and reduce or avoid exposure if the risk cannot be estimated.' },
      { heading: 'Use a price based invalidation', body: 'Place the stop where the setup is invalidated and size the position to that distance. Do not use an arbitrary tight stop or increase size because gold is moving quickly.' },
    ],
  },
  {
    step: '06 · TRADING JOURNAL', title: 'Review the process, not one trade',
    summary: 'Capture the plan and outcome so improvements come from evidence.', diagram: 'journal',
    caption: 'Keep the loop consistent: plan, execute, record, review, then adjust one rule at a time.',
    details: [
      { heading: 'Before the trade', body: 'Record the symbol, timeframes, market condition, bias, setup evidence, entry trigger, stop, target, planned cash risk, and any scheduled event. Save a chart screenshot before entry.' },
      { heading: 'After the trade', body: 'Record the actual entry and exit, fees, spread or slippage, result in money and R, and whether each rule was followed. Add a screenshot after closing.' },
      { heading: 'Review a useful sample', body: 'Group results by setup and market condition over a meaningful number of trades. Look for repeated rule breaks or execution costs. Change one rule at a time and track whether the next sample improves.' },
    ],
  },
]

function Diagram({ kind }: { kind: DiagramKind }) {
  const label = (x: number, y: number, value: string, color = '#c8d4e2') => <text x={x} y={y} fill={color} fontSize="14" fontWeight="700">{value}</text>
  const line = { fill: 'none', strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const teal = '#24c5df'
  const green = '#28c994'
  const red = '#ff647c'
  const gold = '#f2c76e'
  let drawing: ReactNode
  let description = ''
  switch (kind) {
    case 'structure':
      description = 'An uptrend with rising swing highs and lows and a bullish break of structure.'
      drawing = <><path d="M42 156 105 120 170 137 235 84 300 103 365 50 430 72 500 28" stroke={teal} {...line}/><path d="M165 137h75M295 103h75M425 72h60" stroke={gold} strokeDasharray="7 7" {...line}/><path d="m481 38 19-10-4 22" stroke={green} {...line}/>{label(42,188,'Swing low')}{label(195,72,'Higher high',gold)}{label(390,40,'BOS',green)}</>
      break
    case 'liquidity':
      description = 'Price moves above equal highs to sweep liquidity and then returns; the sweep alone does not prove a reversal.'
      drawing = <><path d="M42 130 100 82 160 118 220 72 278 110 334 74 390 128 445 58 510 94" stroke={teal} {...line}/><path d="M185 66h160" stroke={gold} strokeDasharray="7 7" {...line}/><path d="M334 74 390 128 445 58" stroke={red} {...line}/>{label(190,52,'Equal highs · stops above',gold)}{label(370,158,'Sweep ≠ reversal',red)}</>
      break
    case 'risk':
      description = 'Entry, stop and target levels show risk below entry and potential reward above entry.'
      drawing = <><path d="M44 44h470" stroke={green} {...line}/><path d="M44 100h470" stroke={teal} {...line}/><path d="M44 158h470" stroke={red} {...line}/><path d="M275 143V113m-6 6 6-6 6 6M275 57v32m-6-6 6 6 6-6" stroke={gold} {...line}/>{label(52,36,'Target',green)}{label(52,91,'Entry',teal)}{label(52,151,'Stop',red)}{label(300,139,'Risk',gold)}{label(300,77,'Reward',gold)}</>
      break
    case 'execution':
      description = 'A four step process: set higher timeframe bias, identify a liquidity sweep, wait for confirmation, then plan entry and stop.'
      drawing = <>{[['1. Bias',45],['2. Sweep',175],['3. Confirm',305],['4. Plan',435]].map(([text,x],index)=><g key={text as string}><rect x={Number(x)} y="60" width="100" height="62" rx="12" fill="rgba(36,197,223,.08)" stroke={index===3?green:teal} strokeWidth="2"/>{label(Number(x)+11,97,text as string)}{index<3&&<path d={`M${Number(x)+104} 91h18m-6-6 6 6-6 6`} stroke={gold} {...line}/>}</g>)}{label(57,153,'4H / 1H',gold)}{label(185,153,'Stops',gold)}{label(315,153,'15M / 5M',gold)}{label(443,153,'Entry + SL',gold)}</>
      break
    case 'gold':
      description = 'Candlesticks of different sizes illustrate that gold volatility can expand, while a stop level remains fixed.'
      drawing = <><path d="M50 52h470" stroke={gold} strokeDasharray="7 7" {...line}/><path d="M50 158h470" stroke={red} {...line}/><path d="M85 102h42M106 65v75M180 95h42M201 72v62M275 108h42M296 43v110M370 88h42M391 60v91M465 98h42M486 35v122" stroke={teal} {...line}/>{label(52,40,'Fast news moves',gold)}{label(400,185,'Stop level',red)}</>
      break
    case 'journal':
      description = 'A cycle from planning and execution to recording results and reviewing the process.'
      drawing = <><path d="M90 98c0-28 24-50 52-50h270c28 0 52 22 52 50v7m0 0 10-10m-10 10-10-10M470 112c0 28-24 50-52 50H148c-28 0-52-22-52-50v-7m0 0-10 10m10-10 10 10" stroke={teal} {...line}/>{label(166,79,'Plan → Execute → Record',teal)}{label(165,139,'Review → Improve',green)}</>
      break
  }
  return <svg className="education-diagram-svg" viewBox="0 0 560 200" role="img" aria-label={description}>{drawing}</svg>
}

export default function Education() {
  return <section className="education-dashboard">
    <div className="tab-hero education-hero"><p className="eyebrow">TRADE SMARTER · BUILD SKILL</p><h2>Trading Education</h2><p className="muted">Open a topic for a practical explanation and a visual example. Learn the process before risking capital.</p></div>
    <div className="education-grid">{topics.map(topic => <details className="panel education-topic" key={topic.step}>
      <summary><span className="education-topic-heading"><span className="education-step">{topic.step}</span><strong>{topic.title}</strong><small>{topic.summary}</small></span><span className="education-expand" aria-hidden="true">+</span></summary>
      <div className="education-topic-content">
        <div className="education-explanations">{topic.details.map(detail => <section key={detail.heading}><h4>{detail.heading}</h4><p>{detail.body}</p></section>)}</div>
        <figure className="education-diagram"><Diagram kind={topic.diagram}/><figcaption>{topic.caption}</figcaption></figure>
      </div>
    </details>)}</div>
    <p className="score-note">Educational material only. Examples are illustrative, not guarantees or recommendations to trade.</p>
  </section>
}


