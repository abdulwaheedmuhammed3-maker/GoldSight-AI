import type { HistoricalCandle } from "../market-data/feed-adapter";

export type StructuralTrend = "BULLISH" | "BEARISH" | "RANGE";
export type StructuralSide = "BUY" | "SELL";
export type StructuralBreak = "BOS" | "CHoCH";

export interface ConfirmedSwing {
  readonly index: number;
  readonly time: number;
  readonly price: number;
}

export interface StructureAnalysis {
  readonly trend: StructuralTrend;
  readonly swingHigh: ConfirmedSwing | null;
  readonly swingLow: ConfirmedSwing | null;
  readonly breakSide: StructuralSide | null;
  readonly breakType: StructuralBreak | null;
  readonly sweepSide: StructuralSide | null;
}

const PIVOT_WINDOW = 2;

/**
 * Analyses completed OHLC bars only. The final bar is the decision candle and
 * is deliberately excluded from pivot confirmation so it cannot create and
 * break its own swing level in the same calculation.
 */
export function analyzeStructure(bars: readonly HistoricalCandle[]): StructureAnalysis {
  const empty: StructureAnalysis = {
    trend: "RANGE",
    swingHigh: null,
    swingLow: null,
    breakSide: null,
    breakType: null,
    sweepSide: null,
  };
  if (bars.length < PIVOT_WINDOW * 2 + 8) return empty;

  const decision = bars[bars.length - 1];
  const highs: ConfirmedSwing[] = [];
  const lows: ConfirmedSwing[] = [];

  // A pivot must have two fully closed candles to its right before it can be
  // used. The current decision candle is not part of that confirmation set.
  for (let index = PIVOT_WINDOW; index < bars.length - 1 - PIVOT_WINDOW; index += 1) {
    const candidate = bars[index];
    let isHigh = true;
    let isLow = true;

    for (let offset = 1; offset <= PIVOT_WINDOW; offset += 1) {
      const left = bars[index - offset];
      const right = bars[index + offset];
      if (candidate.high < left.high || candidate.high <= right.high) isHigh = false;
      if (candidate.low > left.low || candidate.low >= right.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ index, time: candidate.time, price: candidate.high });
    if (isLow) lows.push({ index, time: candidate.time, price: candidate.low });
  }

  if (highs.length < 2 || lows.length < 2) return empty;

  const previousHigh = highs[highs.length - 2];
  const latestHigh = highs[highs.length - 1];
  const previousLow = lows[lows.length - 2];
  const latestLow = lows[lows.length - 1];

  let trend: StructuralTrend = "RANGE";
  if (latestHigh.price > previousHigh.price && latestLow.price > previousLow.price) {
    trend = "BULLISH";
  } else if (latestHigh.price < previousHigh.price && latestLow.price < previousLow.price) {
    trend = "BEARISH";
  }

  let breakSide: StructuralSide | null = null;
  let breakType: StructuralBreak | null = null;
  if (decision.close > latestHigh.price) {
    breakSide = "BUY";
    breakType = trend === "BEARISH" ? "CHoCH" : "BOS";
  } else if (decision.close < latestLow.price) {
    breakSide = "SELL";
    breakType = trend === "BULLISH" ? "CHoCH" : "BOS";
  }

  const sweptSellSide = decision.low < latestLow.price && decision.close > latestLow.price;
  const sweptBuySide = decision.high > latestHigh.price && decision.close < latestHigh.price;
  // A candle that sweeps both ends of the range is ambiguous; do not choose
  // a direction based on branch order.
  const sweepSide: StructuralSide | null = sweptSellSide === sweptBuySide
    ? null
    : sweptSellSide
      ? "BUY"
      : "SELL";

  return {
    trend,
    swingHigh: latestHigh,
    swingLow: latestLow,
    breakSide,
    breakType,
    sweepSide,
  };
}
