import type { CanonicalQuote, InstrumentQuoteState, PriceBasis } from "../market-data/types";
import type { HistoricalCandle } from "../market-data/feed-adapter";

export type SignalSide = "BUY" | "SELL";
export type SignalTimeframe = "5m" | "15m" | "1h" | "4h";
export type MarketTrend = "BULLISH" | "BEARISH" | "RANGE";

export const SIGNAL_TIMEFRAMES: readonly SignalTimeframe[] = ["4h", "1h", "15m", "5m"];

export interface SignalCandles {
  readonly "5m": readonly HistoricalCandle[];
  readonly "15m": readonly HistoricalCandle[];
  readonly "1h": readonly HistoricalCandle[];
  readonly "4h": readonly HistoricalCandle[];
}

export interface SignalEngineInput {
  readonly instrumentId: string;
  readonly quoteState: InstrumentQuoteState;
  readonly candles: SignalCandles;
  readonly candleProvider: string;
  readonly candlePriceBasis: PriceBasis;
  readonly nowMs: number;
  /** A scan target. Defaults to 5m for backwards-compatible callers. */
  readonly targetTimeframe?: SignalTimeframe;
}

export type SignalRejectionCode =
  | "NO_LIVE_QUOTE"
  | "SOURCE_MISMATCH"
  | "INVALID_QUOTE"
  | "INSUFFICIENT_HISTORY"
  | "STALE_CANDLES"
  | "HIGHER_TIMEFRAME_CONFLICT"
  | "NO_TIMEFRAME_TRIGGER"
  | "NO_15M_CONFIRMATION"
  | "NO_5M_TRIGGER"
  | "INVALID_RISK"
  | "RISK_TOO_LARGE"
  | "INVALID_TARGETS";

export interface SignalDiagnostics {
  readonly instrumentId: string;
  readonly targetTimeframe: SignalTimeframe;
  readonly scannedAt: number;
  readonly quoteAgeMs: number | null;
  readonly provider: string | null;
  readonly priceBasis: PriceBasis | null;
  readonly trend4h: MarketTrend | "UNKNOWN";
  readonly trend1h: MarketTrend | "UNKNOWN";
  readonly structure1h: string;
  readonly structure15m: string;
  readonly structure5m: string;
  readonly rejectionCodes: readonly SignalRejectionCode[];
  readonly rejected: boolean;
}

export interface TradingSignal {
  readonly id: string;
  readonly instrumentId: string;
  readonly side: SignalSide;
  readonly timeframe: SignalTimeframe;
  readonly generatedAt: number;
  readonly source: string;
  readonly priceBasis: PriceBasis;
  readonly quoteTimeMs: number;
  readonly entry: number;
  readonly entryZone: { readonly low: number; readonly high: number };
  readonly stopLoss: number;
  readonly takeProfits: {
    readonly tp1: number;
    readonly tp2: number;
    readonly tp3: number;
  };
  readonly riskReward: { readonly tp1: 1; readonly tp2: 2; readonly tp3: 3 };
  readonly invalidationPrice: number;
  readonly confidence: number;
  readonly structure: "BOS" | "CHoCH" | "LIQUIDITY_SWEEP";
  readonly trends: {
    readonly "4h": MarketTrend;
    readonly "1h": MarketTrend;
    readonly "15m": MarketTrend;
    readonly "5m": MarketTrend;
  };
  readonly reasoning: readonly string[];
}

export interface SignalEngineResult {
  readonly status: "SIGNAL" | "NO_SETUP";
  readonly signal: TradingSignal | null;
  readonly diagnostics: SignalDiagnostics;
}

const TF_SECONDS: Record<SignalTimeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
};

const MIN_HISTORY = 40;

interface StructureEvidence {
  readonly trend: MarketTrend;
  readonly bos: SignalSide | null;
  readonly sweep: SignalSide | null;
  readonly swingHigh: number;
  readonly swingLow: number;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function completedCandles(
  input: readonly HistoricalCandle[],
  timeframe: SignalTimeframe,
  nowMs: number,
): HistoricalCandle[] {
  const seconds = TF_SECONDS[timeframe];
  const byTime = new Map<number, HistoricalCandle>();
  for (const candle of input) {
    if (
      !Number.isFinite(candle.time) ||
      !isFinitePositive(candle.open) ||
      !isFinitePositive(candle.high) ||
      !isFinitePositive(candle.low) ||
      !isFinitePositive(candle.close) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.closed === false ||
      candle.time * 1_000 + seconds * 1_000 > nowMs
    ) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function ema(values: readonly number[], period: number): number {
  const alpha = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) {
    result = alpha * values[index] + (1 - alpha) * result;
  }
  return result;
}

function trendOf(bars: readonly HistoricalCandle[]): MarketTrend {
  if (bars.length < MIN_HISTORY) return "RANGE";
  const closes = bars.slice(-120).map((bar) => bar.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const tolerance = Math.max(Math.abs(slow) * 0.00002, Number.EPSILON);
  if (fast - slow > tolerance) return "BULLISH";
  if (slow - fast > tolerance) return "BEARISH";
  return "RANGE";
}

function structureOf(bars: readonly HistoricalCandle[]): StructureEvidence {
  const last = bars[bars.length - 1];
  const prior = bars.slice(-21, -1);
  const swingHigh = Math.max(...prior.map((bar) => bar.high));
  const swingLow = Math.min(...prior.map((bar) => bar.low));
  const bullishBos = last.close > swingHigh;
  const bearishBos = last.close < swingLow;
  const bullishSweep = last.low < swingLow && last.close > swingLow;
  const bearishSweep = last.high > swingHigh && last.close < swingHigh;

  return {
    trend: trendOf(bars),
    bos: bullishBos && !bearishBos ? "BUY" : bearishBos && !bullishBos ? "SELL" : null,
    sweep: bullishSweep && !bearishSweep ? "BUY" : bearishSweep && !bullishSweep ? "SELL" : null,
    swingHigh,
    swingLow,
  };
}

function averageTrueRange(bars: readonly HistoricalCandle[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const ranges: number[] = [];
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : 0;
}

function addReason(codes: SignalRejectionCode[], code: SignalRejectionCode): void {
  if (!codes.includes(code)) codes.push(code);
}

function describeStructure(evidence: StructureEvidence | null): string {
  if (!evidence) return "NOT_REQUIRED";
  if (evidence.bos) return evidence.bos + "_BOS";
  if (evidence.sweep) return evidence.sweep + "_LIQUIDITY_SWEEP";
  return "NO_TRIGGER";
}

function requiredTimeframes(target: SignalTimeframe): readonly SignalTimeframe[] {
  const index = SIGNAL_TIMEFRAMES.indexOf(target);
  return SIGNAL_TIMEFRAMES.slice(0, index + 1);
}

function toSignalSide(trend: MarketTrend): SignalSide | null {
  return trend === "BULLISH" ? "BUY" : trend === "BEARISH" ? "SELL" : null;
}

function buildDiagnostics(
  input: SignalEngineInput,
  targetTimeframe: SignalTimeframe,
  quote: CanonicalQuote | null,
  trends: { "4h": MarketTrend | "UNKNOWN"; "1h": MarketTrend | "UNKNOWN" },
  structures: { "1h": string; "15m": string; "5m": string },
  rejectionCodes: readonly SignalRejectionCode[],
): SignalDiagnostics {
  return {
    instrumentId: input.instrumentId,
    targetTimeframe,
    scannedAt: input.nowMs,
    quoteAgeMs: quote ? Math.max(0, input.nowMs - quote.sourceTimeMs) : null,
    provider: quote?.provider ?? null,
    priceBasis: quote?.priceBasis ?? null,
    trend4h: trends["4h"],
    trend1h: trends["1h"],
    structure1h: structures["1h"],
    structure15m: structures["15m"],
    structure5m: structures["5m"],
    rejectionCodes: [...rejectionCodes],
    rejected: rejectionCodes.length > 0,
  };
}

/**
 * One independent candidate scan for the requested execution timeframe.
 *
 * 4H candidates need 4H context/structure; 1H candidates need 4H context and
 * a 1H trigger; 15M candidates need 4H/1H context plus a 15M trigger; 5M
 * candidates need 4H/1H bias, 15M confirmation and a 5M trigger.
 *
 * Each candidate retains the same provider/source checks and structural ATR
 * risk controls. This does not force every valid opportunity to be a 5M setup.
 */
export function analyzeTradingSignal(input: SignalEngineInput): SignalEngineResult {
  const targetTimeframe = input.targetTimeframe ?? "5m";
  const needed = requiredTimeframes(targetTimeframe);
  const rejectionCodes: SignalRejectionCode[] = [];
  const quote = input.quoteState.quote;

  const bars: Record<SignalTimeframe, HistoricalCandle[]> = {
    "4h": completedCandles(input.candles["4h"], "4h", input.nowMs),
    "1h": completedCandles(input.candles["1h"], "1h", input.nowMs),
    "15m": completedCandles(input.candles["15m"], "15m", input.nowMs),
    "5m": completedCandles(input.candles["5m"], "5m", input.nowMs),
  };

  if (input.quoteState.freshness !== "LIVE" || !quote) {
    addReason(rejectionCodes, "NO_LIVE_QUOTE");
  }

  if (quote && (
    quote.instrumentId !== input.instrumentId ||
    quote.provider !== input.candleProvider ||
    quote.priceBasis !== input.candlePriceBasis
  )) {
    addReason(rejectionCodes, "SOURCE_MISMATCH");
  }

  if (quote && (
    !isFinitePositive(quote.price) ||
    !Number.isFinite(quote.sourceTimeMs) ||
    quote.sourceTimeMs > input.nowMs + 5_000 ||
    input.nowMs - quote.sourceTimeMs > 60_000
  )) {
    addReason(rejectionCodes, "INVALID_QUOTE");
  }

  for (const timeframe of needed) {
    const set = bars[timeframe];
    if (set.length < MIN_HISTORY) {
      addReason(rejectionCodes, "INSUFFICIENT_HISTORY");
      continue;
    }
    const latest = set[set.length - 1];
    const latestCloseMs = (latest.time + TF_SECONDS[timeframe]) * 1_000;
    if (input.nowMs - latestCloseMs > TF_SECONDS[timeframe] * 2_000) {
      addReason(rejectionCodes, "STALE_CANDLES");
    }
  }

  const fourHour = bars["4h"].length >= MIN_HISTORY ? structureOf(bars["4h"]) : null;
  const oneHour = needed.includes("1h") && bars["1h"].length >= MIN_HISTORY ? structureOf(bars["1h"]) : null;
  const fifteenMinute = needed.includes("15m") && bars["15m"].length >= MIN_HISTORY ? structureOf(bars["15m"]) : null;
  const fiveMinute = needed.includes("5m") && bars["5m"].length >= MIN_HISTORY ? structureOf(bars["5m"]) : null;

  const trend4h: MarketTrend | "UNKNOWN" = fourHour?.trend ?? "UNKNOWN";
  const trend1h: MarketTrend | "UNKNOWN" = oneHour?.trend ?? "UNKNOWN";
  const structures = {
    "1h": describeStructure(oneHour),
    "15m": describeStructure(fifteenMinute),
    "5m": describeStructure(fiveMinute),
  };

  if (rejectionCodes.length > 0 || !fourHour) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes),
    };
  }

  let bias: SignalSide | null = null;
  let structure: TradingSignal["structure"] = "BOS";
  let contextReasons: string[] = [];

  if (targetTimeframe === "4h") {
    bias = fourHour.bos ?? fourHour.sweep;
    contextReasons.push("4H market context: " + fourHour.trend);
  } else {
    const higherBias = toSignalSide(fourHour.trend);
    const oneHourBias = oneHour ? toSignalSide(oneHour.trend) : null;

    if (targetTimeframe === "1h") {
      // A 1H BOS can be an early shift against the 4H trend; label it CHoCH.
      if (oneHour?.bos && higherBias && oneHour.bos !== higherBias) {
        bias = oneHour.bos;
        structure = "CHoCH";
      } else {
        bias = higherBias ?? oneHour?.bos ?? oneHour?.sweep ?? oneHourBias;
      }
      contextReasons = ["4H market context: " + fourHour.trend];
    } else {
      if (higherBias && (
        oneHourBias === higherBias ||
        oneHour?.bos === higherBias ||
        oneHour?.sweep === higherBias
      )) {
        bias = higherBias;
      } else if (oneHour?.bos && higherBias && oneHour.bos !== higherBias) {
        // A confirmed 1H break against 4H is allowed as a reversal candidate.
        bias = oneHour.bos;
        structure = "CHoCH";
      } else if (!higherBias && oneHourBias) {
        bias = oneHourBias;
      } else {
        addReason(rejectionCodes, "HIGHER_TIMEFRAME_CONFLICT");
      }
      contextReasons = [
        "4H market context: " + fourHour.trend,
        "1H market structure: " + (oneHour ? describeStructure(oneHour) : "NOT_AVAILABLE"),
      ];
    }
  }

  const trigger = targetTimeframe === "4h"
    ? fourHour
    : targetTimeframe === "1h"
      ? oneHour
      : targetTimeframe === "15m"
        ? fifteenMinute
        : fiveMinute;

  if (!bias || !trigger) {
    addReason(rejectionCodes, "HIGHER_TIMEFRAME_CONFLICT");
  } else if (trigger.bos !== bias && trigger.sweep !== bias) {
    addReason(rejectionCodes, "NO_TIMEFRAME_TRIGGER");
  }

  if (targetTimeframe === "5m" && bias && fifteenMinute &&
      fifteenMinute.bos !== bias && fifteenMinute.sweep !== bias) {
    addReason(rejectionCodes, "NO_15M_CONFIRMATION");
  }

  if (rejectionCodes.length > 0 || !bias || !trigger || !quote) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes),
    };
  }

  const triggerBars = bars[targetTimeframe];
  const atr = averageTrueRange(triggerBars);
  const entry = bias === "BUY" ? quote.ask ?? quote.price : quote.bid ?? quote.price;
  const recent = triggerBars.slice(-4);
  const rawStop = bias === "BUY"
    ? Math.min(...recent.map((bar) => bar.low)) - atr * 0.2
    : Math.max(...recent.map((bar) => bar.high)) + atr * 0.2;
  const risk = Math.abs(entry - rawStop);
  const spread = quote.bid !== null && quote.ask !== null ? quote.ask - quote.bid : 0;

  if (!isFinitePositive(atr) || !isFinitePositive(risk) || rawStop <= 0 || rawStop === entry) {
    addReason(rejectionCodes, "INVALID_RISK");
  } else if (risk > atr * 6 || (spread > 0 && risk < spread * 1.5)) {
    addReason(rejectionCodes, "RISK_TOO_LARGE");
  }

  if (rejectionCodes.length > 0) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes),
    };
  }

  const direction = bias === "BUY" ? 1 : -1;
  const takeProfits = {
    tp1: entry + direction * risk,
    tp2: entry + direction * risk * 2,
    tp3: entry + direction * risk * 3,
  };
  if (!Object.values(takeProfits).every(isFinitePositive)) {
    addReason(rejectionCodes, "INVALID_TARGETS");
  }

  if (rejectionCodes.length > 0) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes),
    };
  }

  if (trigger.sweep === bias) structure = "LIQUIDITY_SWEEP";
  else if (oneHour?.bos && higherContextTrend(fourHour, oneHour) === "CHoCH") structure = "CHoCH";
  else structure = "BOS";

  const alignmentBonus = oneHour && oneHour.trend === fourHour.trend ? 8 : 0;
  const structureBonus = trigger.bos === bias ? 5 : 3;
  const reversalPenalty = structure === "CHoCH" ? 4 : 0;
  const confidence = Math.max(50, Math.min(88, 62 + alignmentBonus + structureBonus - reversalPenalty));

  const signal: TradingSignal = Object.freeze({
    id: [
      input.instrumentId,
      bias,
      targetTimeframe,
      quote.provider,
      Math.floor(triggerBars[triggerBars.length - 1].time),
    ].join(":"),
    instrumentId: input.instrumentId,
    side: bias,
    timeframe: targetTimeframe,
    generatedAt: input.nowMs,
    source: quote.provider,
    priceBasis: quote.priceBasis,
    quoteTimeMs: quote.sourceTimeMs,
    entry,
    entryZone: {
      low: Math.min(entry, entry + direction * atr * 0.1),
      high: Math.max(entry, entry + direction * atr * 0.1),
    },
    stopLoss: rawStop,
    takeProfits,
    riskReward: { tp1: 1 as const, tp2: 2 as const, tp3: 3 as const },
    invalidationPrice: rawStop,
    confidence,
    structure,
    trends: {
      "4h": fourHour.trend,
      "1h": oneHour?.trend ?? fourHour.trend,
      "15m": fifteenMinute?.trend ?? "RANGE",
      "5m": fiveMinute?.trend ?? "RANGE",
    },
    reasoning: [
      ...contextReasons,
      targetTimeframe.toUpperCase() + " trigger: " + describeStructure(trigger),
      ...(targetTimeframe === "5m" && fifteenMinute
        ? ["15M confirmation: " + describeStructure(fifteenMinute)]
        : []),
      "Entry uses the current " + (bias === "BUY" ? "ask" : "bid") + " when supplied by the provider.",
      "Targets use 1R, 2R and 3R from the " + targetTimeframe.toUpperCase() + " structural stop.",
    ],
  });

  return {
    status: "SIGNAL",
    signal,
    diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, []),
  };
}

/** Allow a single market update to evaluate the full timeframe ladder. */
export function analyzeTradingSignals(input: SignalEngineInput): readonly SignalEngineResult[] {
  return SIGNAL_TIMEFRAMES.map((targetTimeframe) =>
    analyzeTradingSignal({ ...input, targetTimeframe }),
  );
}

function higherContextTrend(
  fourHour: StructureEvidence,
  oneHour: StructureEvidence,
): "CHoCH" | "ALIGNED" | "MIXED" {
  const fourHourSide = toSignalSide(fourHour.trend);
  const oneHourSide = toSignalSide(oneHour.trend);
  if (fourHourSide && oneHour.bos && oneHour.bos !== fourHourSide) return "CHoCH";
  if (fourHourSide && oneHourSide === fourHourSide) return "ALIGNED";
  return "MIXED";
}
