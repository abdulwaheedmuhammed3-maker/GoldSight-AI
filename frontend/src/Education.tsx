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
    summary: 'Use swing highs and lows to describe a trend and spot significant breaks.', diagram: 'structure',
    caption: 'Example uptrend: higher highs and higher lows; BOS marks a close beyond a prior swing high.',
    details: [
      { heading: 'Start with swing points', body: 'A swing high is a local peak above the highs immediately before and after it. A swing low is a local trough below the lows immediately before and after it. Start on the 4H or 1H chart so short-term price noise does not dominate your view.' },
      { heading: 'BOS and CHoCH', body: 'A break of structure (BOS) is a candle close beyond a meaningful prior swing in the direction of the current trend. A change of character (CHoCH) is an early break against that trend. Neither guarantees continuation or reversal. Wait for follow-through and identify the price level that would invalidate your idea.' },
      { heading: 'Practice', body: 'Mark the last two clear swing highs and lows. Note whether they are rising or falling, then write down what price action would prove your view wrong. Do not redraw the swings after seeing what happened next.' },
    ],
  },
  {
    step: '02 · LIQUIDITY', title: 'Learn where liquidity rests',
    summary: 'Obvious highs and lows may become areas where stop orders cluster.', diagram: 'liquidity',
    caption: 'Illustration only: a move above equal highs may sweep stops; it is not an entry signal.',
    details: [
      { heading: 'Where orders may cluster', body: 'Many traders place stops just beyond equal highs, equal lows, recent swing points, and the previous day’s high or low. These levels can be useful areas to watch, but they are not guaranteed targets and do not prove that a particular group is trading there.' },
      { heading: 'Wait for confirmation', body: 'Here, a sweep means price moves beyond an obvious level and then closes back inside it. Price may still continue in either direction. For a reversal idea, look for a strong move away and a confirmed structure shift. For a continuation idea, look for price to hold beyond the level.' },
      { heading: 'Set an invalidation level', body: 'Before entering, decide what price action would disprove the idea. If a technically sensible stop is too far away for your risk limit, reduce the position size or skip the trade.' },
    ],
  },
  {
    step: '03 · RISK MANAGEMENT', title: 'Protect the account first',
    summary: 'Set the loss you can afford before you calculate position size.', diagram: 'risk',
    caption: 'Risk is measured from entry to stop; reward is measured from entry to target.',
    details: [
      { heading: 'Choose your risk limit', body: 'Decide the maximum amount of account equity you are willing to lose if the stop is reached. Place the stop where the setup is invalidated; do not move it closer just to increase position size.' },
      { heading: 'Calculate position size', body: 'Position size = maximum cash risk ÷ (entry-to-stop distance × value per price unit). Account for spread, commission, contract size, and currency conversion. Check your broker’s contract specifications because the price value differs between instruments.' },
      { heading: 'Compare risk and reward', body: 'Compare the distance to a realistic target with the distance to your stop. Also consider nearby support or resistance, spread, and scheduled news. A favorable reward-to-risk estimate does not make a weak setup safe. Never widen a stop to avoid taking a planned loss.' },
    ],
  },
  {
    step: '04 · EXECUTION', title: 'Build a repeatable setup',
    summary: 'Follow a top-down checklist and wait when conditions are unclear.', diagram: 'execution',
    caption: 'Example workflow: if a confirmation is missing, wait instead of forcing a trade.',
    details: [
      { heading: 'Set the higher-timeframe context', body: 'Use the 4H or 1H chart to mark the current structure, important price levels, and nearby liquidity. Decide whether the market is trending, ranging, or reacting to a key level.' },
      { heading: 'Wait for a lower-timeframe trigger', body: 'On the 15M or 5M chart, wait for the event in your plan—for example, a liquidity sweep followed by a strong move and a structure break. Before entry, record the trigger, stop, target, and the condition that cancels the setup.' },
      { heading: 'Follow and review the plan', body: 'Do not chase price after it has left your entry area. Record whether you followed your rules, including the effects of spread and slippage. A well-planned trade can still lose; review a series of trades before changing a rule.' },
    ],
  },
  {
    step: '05 · GOLD (XAUUSD)', title: 'Respect gold’s volatility',
    summary: 'Gold can move sharply, and trading costs can change quickly.', diagram: 'gold',
    caption: 'Fast price moves and wider spreads can increase the loss when a stop is triggered.',
    details: [
      { heading: 'What can move gold?', body: 'Gold may react to US inflation and employment reports, central bank decisions, Treasury yields, and changes in the US dollar. These relationships can change and cannot predict gold’s next move on their own.' },
      { heading: 'Check trading conditions', body: 'During fast markets, spreads can widen and prices can jump. A stop order may fill at a worse price than requested, especially when the market gaps. Check the economic calendar and your broker’s conditions; reduce or avoid exposure when you cannot estimate the risk.' },
      { heading: 'Set a clear invalidation level', body: 'Place the stop where the setup no longer holds, then size the position to that stop distance. Avoid arbitrary tight stops and do not increase position size just because gold is moving quickly.' },
    ],
  },
  {
    step: '06 · TRADING JOURNAL', title: 'Review the process, not one trade',
    summary: 'Capture the plan and outcome so improvements come from evidence.', diagram: 'journal',
    caption: 'Keep the loop consistent: plan, execute, record, review, then adjust one rule at a time.',
    details: [
      { heading: 'Before the trade', body: 'Record the symbol, timeframes, market condition, directional bias, setup evidence, entry trigger, stop, target, planned cash risk, and any scheduled event. Save a chart screenshot before entry.' },
      { heading: 'After the trade', body: 'Record the actual entry and exit, fees, spread or slippage, result in money and R (the result as a multiple of your initial risk), and whether you followed each rule. Save a screenshot after closing.' },
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
      drawing = <><path d="M42 130 100 82 160 118 220 72 278 110 334 74 390 128 445 58 510 94" stroke={teal} {...line}/><path d="M185 66h160" stroke={gold} strokeDasharray="7 7" {...line}/><path d="M334 74 390 128 445 58" stroke={red} {...line}/>{label(190,52,'Possible stops above',gold)}{label(370,158,'Sweep ≠ reversal',red)}</>
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


