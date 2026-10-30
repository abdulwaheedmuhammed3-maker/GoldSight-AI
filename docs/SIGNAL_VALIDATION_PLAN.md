# TradeSight signal validation plan

## Current baseline (before strategy changes)

The live engine is a deterministic, rule-based strategy. It is not a trained AI model and its displayed alignment score is not a probability of winning.

Current entry logic combines:
- 9/21 EMA directional trend on completed candles.
- A recent 20-candle close break (BOS), an EMA trend flip (used as a provisional CHoCH proxy), or a 10-candle liquidity sweep and reclaim.
- Candle confirmation beyond the previous candle's high/low.
- Higher-timeframe EMA agreement for timeframes below 4H.
- A basic spread-to-stop-distance rejection.

## Validation safeguards

1. Keep live signals and historical simulation separate. A live quote does not validate a strategy.
2. Use completed candles only for decisions; simulate entry at the next candle open.
3. When OHLC data shows both stop and target touched in one bar, count the stop first.
4. Reject malformed OHLC values and report duplicate timestamps and data gaps.
5. Report sample size, date span, trade details, drawdown and profit factor. A small sample is not evidence of an edge.
6. Treat current spread applied to historical trades as an estimate only. It is not historical execution data and excludes slippage, commission, financing and latency.
7. Never describe the rule-alignment score as win probability.
8. Keep BTCUSDT spot analysis clearly distinguished from a broker's BTCUSD CFD execution feed.

## Known strategy limitations to resolve

- EMA cross/relationship is a trend filter, not a complete market-structure CHoCH definition.
- BOS currently uses a rolling high/low window, not confirmed swing points.
- Liquidity sweep logic is a simple lookback sweep-and-close-back test.
- Stops are ATR/range-buffer based; ATR should be upgraded to true range including gaps.
- Entry is currently a single next-bar market-style fill; there is no pullback/limit-entry model.
- Spread and execution costs are simplified.
- A current provider candle sample (up to 1,000 bars) is too short for robust multi-regime conclusions.

## Phased improvement sequence

### Phase A — protect the baseline
- Add regression tests for OHLC validation, duplicate handling, insufficient history and conservative same-bar stop/target handling.
- Save baseline results for XAUUSD and BTCUSD across 5m, 15m, 1h and 4h before tuning.

### Phase B — improve signal quality
- Replace rolling-window structure checks with confirmed swing highs/lows.
- Distinguish BOS from CHoCH using the prior confirmed structure trend.
- Use true-range ATR and volatility-aware stop buffers.
- Add explicit spread/volatility filters and minimum reward-to-risk checks.
- Require alignment of 4H/1H context with 15M/5M execution without using future candles.

### Phase C — validate out of sample
- Split history chronologically into development, validation and untouched test periods.
- Tune only on the development period; freeze rules before the test period.
- Report expectancy in R, profit factor, win rate, max drawdown, trade count, exposure and cost assumptions.
- Repeat across symbols and market regimes. Do not select a timeframe based only on the best small-sample result.

### Phase D — forward test
- Run signals in paper mode with timestamped entry/exit assumptions.
- Compare expected fills with executable broker bid/ask prices.
- Require a meaningful forward sample before considering any live-money use.

## Current status

This document records the validation plan and known caveats. Passing regression tests verifies software behavior, not trading profitability. Backtest results must be captured from the deployed API and independently reviewed before changing live signal rules.


## Support and resistance: core strategy component

Support and resistance must be treated as price zones with evidence, not arbitrary single-price lines. The live engine should calculate and expose these levels for both XAUUSD and BTCUSD, then use them in setup qualification and trade management.

### Level construction
- Detect confirmed swing highs and swing lows using a symmetric pivot window. A pivot becomes usable only after the required candles to its right have closed; never use an unconfirmed/future pivot.
- Cluster nearby confirmed pivots into zones using a volatility-scaled tolerance (based on true-range ATR), rather than a fixed dollar/pip distance. Merge overlapping zones and retain their boundaries, midpoint, source timeframe and timestamps.
- Give more weight to zones with repeated independent reactions, clear rejection/displacement, and higher-timeframe origin. Do not inflate strength by counting many candles from one reaction as separate touches.
- Keep prior day high/low and prior week high/low as separately labelled reference levels where sufficient timestamped history exists.
- Expire or reduce the weight of old levels when price decisively accepts beyond them; a broken resistance may become support and broken support may become resistance only after a confirmed break and retest.

### How levels affect a trade
- **Location first:** no long entry directly beneath a nearby resistance zone and no short entry directly above nearby support unless there is a confirmed breakout/retest setup with adequate room to target.
- **Rejection setup:** at support, require a completed-candle rejection/failed breakdown and bullish confirmation before considering BUY. At resistance, require rejection/failed breakout and bearish confirmation before considering SELL.
- **Breakout setup:** require a completed candle to close beyond the zone by a volatility-aware buffer; then prefer a retest that holds the broken zone. Do not chase the first wick through a level.
- **Confluence:** give stronger consideration when the level aligns with 4H/1H structure, liquidity pools, a sweep, BOS/CHoCH and directional context. A level alone is not a trade signal.
- **Risk and targets:** place invalidation beyond the relevant zone plus a volatility buffer, not exactly on the visible line. Prefer the next opposing support/resistance zone as a realistic target; only publish TP levels when reward-to-risk remains acceptable after spread and execution assumptions.
- **No-trade rule:** if price is between zones, trapped in a tight range, or has insufficient distance to the next opposing zone, return NO SETUP rather than manufacturing a trade.

### Output and transparency
- Return nearest support and resistance zones, zone boundaries/midpoint, timeframe/source, touch count, strength score and distance from current price in the analysis payload.
- Explain whether the setup is a rejection, breakout/retest, or no-trade due to location. The strength score is a ranking aid, not a probability of a successful trade.
- Display higher-timeframe zones more prominently while retaining lower-timeframe execution levels. Avoid clutter by showing the nearest relevant zones and key prior-day/prior-week levels.
- Preserve the existing API response shape where possible; add fields rather than silently changing existing field meanings.

### Validation requirements before activation
- Add deterministic tests for confirmed pivots, no lookahead, zone clustering, repeated-touch scoring, break-and-retest role reversal, stale-level decay, and entries blocked by nearby opposing zones.
- Backtest with the same completed-candle and next-bar-open safeguards. Compare the original baseline against the S/R-enhanced candidate on identical date windows and realistic costs.
- Report results by symbol and timeframe, including trades, expectancy in R, profit factor, drawdown, and how many trades were rejected by location filters.
- Do not activate the S/R-enhanced engine for live signals until tests pass and out-of-sample/forward-paper results justify it.
