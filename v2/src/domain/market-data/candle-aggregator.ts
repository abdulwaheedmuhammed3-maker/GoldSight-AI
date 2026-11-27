import type { CanonicalQuote } from "./types";

export interface ActiveCandle {
  readonly instrumentId: string;
  readonly provider: string;
  readonly priceBasis: CanonicalQuote["priceBasis"];
  readonly timeframeSeconds: number;
  /** UTC epoch milliseconds, aligned to the timeframe boundary. */
  readonly timeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly lastTickTimeMs: number;
  readonly lastSequence: number | null;
  readonly tickCount: number;
}

export interface CandleUpdate {
  readonly accepted: boolean;
  readonly candle: ActiveCandle | null;
  readonly rolledOver: boolean;
  /** Missing intervals are reported, never filled with synthetic candles. */
  readonly gapIntervals: number;
}

function validTimeframe(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function createCandle(quote: CanonicalQuote, timeframeSeconds: number, timeMs: number): ActiveCandle {
  return Object.freeze({
    instrumentId: quote.instrumentId,
    provider: quote.provider,
    priceBasis: quote.priceBasis,
    timeframeSeconds,
    timeMs,
    open: quote.price,
    high: quote.price,
    low: quote.price,
    close: quote.price,
    lastTickTimeMs: quote.sourceTimeMs,
    lastSequence: quote.sequence,
    tickCount: 1,
  });
}

/**
 * Apply the exact same accepted quote used by the UI to the active OHLC bar.
 * The caller also uses quote.price for the chart's current-price line.
 */
export function updateActiveCandle(
  current: ActiveCandle | null,
  quote: CanonicalQuote,
  timeframeSeconds: number,
): CandleUpdate {
  if (!validTimeframe(timeframeSeconds) ||
      !Number.isFinite(quote.sourceTimeMs) || quote.sourceTimeMs <= 0 ||
      !Number.isFinite(quote.price) || quote.price <= 0) {
    return { accepted: false, candle: current, rolledOver: false, gapIntervals: 0 };
  }

  const intervalMs = timeframeSeconds * 1_000;
  const bucketTimeMs = Math.floor(quote.sourceTimeMs / intervalMs) * intervalMs;

  if (!current) {
    return {
      accepted: true,
      candle: createCandle(quote, timeframeSeconds, bucketTimeMs),
      rolledOver: false,
      gapIntervals: 0,
    };
  }

  if (
    current.instrumentId !== quote.instrumentId ||
    current.provider !== quote.provider ||
    current.priceBasis !== quote.priceBasis ||
    current.timeframeSeconds !== timeframeSeconds
  ) {
    return { accepted: false, candle: current, rolledOver: false, gapIntervals: 0 };
  }

  if (quote.sourceTimeMs < current.lastTickTimeMs) {
    return { accepted: false, candle: current, rolledOver: false, gapIntervals: 0 };
  }

  if (
    quote.sourceTimeMs === current.lastTickTimeMs &&
    quote.sequence !== null &&
    current.lastSequence !== null &&
    quote.sequence <= current.lastSequence
  ) {
    return { accepted: false, candle: current, rolledOver: false, gapIntervals: 0 };
  }

  if (bucketTimeMs < current.timeMs) {
    return { accepted: false, candle: current, rolledOver: false, gapIntervals: 0 };
  }

  if (bucketTimeMs > current.timeMs) {
    const gapIntervals = Math.max(0, Math.floor((bucketTimeMs - current.timeMs) / intervalMs) - 1);
    return {
      accepted: true,
      candle: createCandle(quote, timeframeSeconds, bucketTimeMs),
      rolledOver: true,
      gapIntervals,
    };
  }

  const candle: ActiveCandle = Object.freeze({
    ...current,
    high: Math.max(current.high, quote.price),
    low: Math.min(current.low, quote.price),
    close: quote.price,
    lastTickTimeMs: quote.sourceTimeMs,
    lastSequence: quote.sequence,
    tickCount: current.tickCount + 1,
  });

  return { accepted: true, candle, rolledOver: false, gapIntervals: 0 };
}
