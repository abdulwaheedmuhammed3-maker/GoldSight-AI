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
