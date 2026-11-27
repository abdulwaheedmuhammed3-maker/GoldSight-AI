import type { CanonicalQuote, InstrumentQuoteState, PriceBasis } from "../market-data/types";
import type { HistoricalCandle } from "../market-data/feed-adapter";

export type SignalSide = "BUY" | "SELL";
export type SignalTimeframe = "5m" | "15m" | "1h" | "4h";
export type MarketTrend = "BULLISH" | "BEARISH" | "RANGE";

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
}

export type SignalRejectionCode =
  | "NO_LIVE_QUOTE"
  | "SOURCE_MISMATCH"
  | "INVALID_QUOTE"
  | "INSUFFICIENT_HISTORY"
  | "STALE_CANDLES"
  | "HIGHER_TIMEFRAME_CONFLICT"
  | "NO_15M_CONFIRMATION"
  | "NO_5M_TRIGGER"
  | "INVALID_RISK"
  | "RISK_TOO_LARGE"
  | "INVALID_TARGETS";

export interface SignalDiagnostics {
  readonly instrumentId: string;
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
  readonly timeframe: "5m";
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

function addReason(
  rejectionCodes: SignalRejectionCode[],
  code: SignalRejectionCode,
): void {
  if (!rejectionCodes.includes(code)) rejectionCodes.push(code);
}

function describeStructure(evidence: StructureEvidence): string {
  if (evidence.bos) return evidence.bos + "_BOS";
  if (evidence.sweep) return evidence.sweep + "_LIQUIDITY_SWEEP";
  return "NO_TRIGGER";
}

function buildDiagnostics(
  input: SignalEngineInput,
  quote: CanonicalQuote | null,
  trends: { "4h": MarketTrend | "UNKNOWN"; "1h": MarketTrend | "UNKNOWN" },
  structures: { "1h": string; "15m": string; "5m": string },
  rejectionCodes: readonly SignalRejectionCode[],
): SignalDiagnostics {
  return {
    instrumentId: input.instrumentId,
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

export function analyzeTradingSignal(input: SignalEngineInput): SignalEngineResult {
  const rejectionCodes: SignalRejectionCode[] = [];
  const quote = input.quoteState.quote;
  let trend4h: MarketTrend | "UNKNOWN" = "UNKNOWN";
  let trend1h: MarketTrend | "UNKNOWN" = "UNKNOWN";
  let oneHour: StructureEvidence | null = null;
  let fifteenMinute: StructureEvidence | null = null;
  let fiveMinute: StructureEvidence | null = null;

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

  const bars: Record<SignalTimeframe, HistoricalCandle[]> = {
    "4h": completedCandles(input.candles["4h"], "4h", input.nowMs),
    "1h": completedCandles(input.candles["1h"], "1h", input.nowMs),
    "15m": completedCandles(input.candles["15m"], "15m", input.nowMs),
    "5m": completedCandles(input.candles["5m"], "5m", input.nowMs),
  };

  if (Object.values(bars).some((set) => set.length < MIN_HISTORY)) {
    addReason(rejectionCodes, "INSUFFICIENT_HISTORY");
  }

  for (const timeframe of Object.keys(bars) as SignalTimeframe[]) {
    const latest = bars[timeframe].at(-1);
    if (latest && input.nowMs - (latest.time * 1_000 + TF_SECONDS[timeframe] * 1_000) >
      TF_SECONDS[timeframe] * 2_000) {
      addReason(rejectionCodes, "STALE_CANDLES");
    }
  }

  if (rejectionCodes.length > 0) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, quote, { "4h": trend4h, "1h": trend1h },
        { "1h": "NOT_EVALUATED", "15m": "NOT_EVALUATED", "5m": "NOT_EVALUATED" }, rejectionCodes),
    };
  }

  const fourHour = structureOf(bars["4h"]);
  oneHour = structureOf(bars["1h"]);
  fifteenMinute = structureOf(bars["15m"]);
  fiveMinute = structureOf(bars["5m"]);
  trend4h = fourHour.trend;
  trend1h = oneHour.trend;

  let bias: SignalSide | null = null;
  let structure: TradingSignal["structure"] = "BOS";

  if (trend4h === "BULLISH" && trend1h === "BULLISH") bias = "BUY";
  if (trend4h === "BEARISH" && trend1h === "BEARISH") bias = "SELL";

  // A confirmed 1H structure break in the new direction can mark an early CHoCH
  // against the 4H background, but only when 15M and 5M subsequently agree.
  if (!bias && oneHour.bos) {
    bias = oneHour.bos;
    structure = oneHour.bos === "BUY" ? "CHoCH" : "CHoCH";
  }

  if (!bias) {
    addReason(rejectionCodes, "HIGHER_TIMEFRAME_CONFLICT");
  }

  const fifteenMinuteTrigger = bias
    ? fifteenMinute.bos === bias || fifteenMinute.sweep === bias
    : false;
  if (!fifteenMinuteTrigger) addReason(rejectionCodes, "NO_15M_CONFIRMATION");

  const fiveMinuteTrigger = bias
    ? fiveMinute.bos === bias || fiveMinute.sweep === bias
    : false;
  if (!fiveMinuteTrigger) addReason(rejectionCodes, "NO_5M_TRIGGER");

  if (rejectionCodes.length > 0 || !bias || !quote || !oneHour || !fifteenMinute || !fiveMinute) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, quote, { "4h": trend4h, "1h": trend1h },
        {
          "1h": describeStructure(oneHour),
          "15m": describeStructure(fifteenMinute),
          "5m": describeStructure(fiveMinute),
        }, rejectionCodes),
    };
  }

  const triggerBars = bars["5m"];
  const atr = averageTrueRange(triggerBars);
  const entry = bias === "BUY" ? quote.ask ?? quote.price : quote.bid ?? quote.price;
  const recent = triggerBars.slice(-12);
  const rawStop = bias === "BUY"
    ? Math.min(...recent.map((bar) => bar.low)) - atr * 0.2
    : Math.max(...recent.map((bar) => bar.high)) + atr * 0.2;
  const risk = Math.abs(entry - rawStop);
  const spread = quote.bid !== null && quote.ask !== null ? quote.ask - quote.bid : 0;

  if (!isFinitePositive(atr) || !isFinitePositive(risk) || rawStop <= 0 || rawStop === entry) {
    addReason(rejectionCodes, "INVALID_RISK");
  } else if (risk > atr * 3.5 || (spread > 0 && risk < spread * 1.5)) {
    addReason(rejectionCodes, "RISK_TOO_LARGE");
  }

  if (rejectionCodes.length > 0) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, quote, { "4h": trend4h, "1h": trend1h },
        {
          "1h": describeStructure(oneHour),
          "15m": describeStructure(fifteenMinute),
          "5m": describeStructure(fiveMinute),
        }, rejectionCodes),
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
      diagnostics: buildDiagnostics(input, quote, { "4h": trend4h, "1h": trend1h },
        {
          "1h": describeStructure(oneHour),
          "15m": describeStructure(fifteenMinute),
          "5m": describeStructure(fiveMinute),
        }, rejectionCodes),
    };
  }

  if (fifteenMinute.sweep === bias || fiveMinute.sweep === bias) {
    structure = "LIQUIDITY_SWEEP";
  } else if (oneHour.bos && trend4h !== trend1h) {
    structure = "CHoCH";
  } else if (oneHour.bos === bias || fifteenMinute.bos === bias || fiveMinute.bos === bias) {
    structure = "BOS";
  }

  const confidence = Math.min(
    85,
    60 +
      (trend4h === trend1h ? 8 : 0) +
      (oneHour.bos === bias ? 5 : 0) +
      (fifteenMinute.sweep === bias ? 5 : 0) +
      (fiveMinute.bos === bias ? 5 : 0) +
      (fiveMinute.sweep === bias ? 3 : 0),
  );

  const signal: TradingSignal = Object.freeze({
    id: [
      input.instrumentId,
      bias,
      quote.provider,
      Math.floor(triggerBars[triggerBars.length - 1].time),
    ].join(":"),
    instrumentId: input.instrumentId,
    side: bias,
    timeframe: "5m",
    generatedAt: input.nowMs,
    source: quote.provider,
    priceBasis: quote.priceBasis,
    quoteTimeMs: quote.sourceTimeMs,
    entry,
    entryZone: { low: Math.min(entry, entry + direction * atr * 0.1), high: Math.max(entry, entry + direction * atr * 0.1) },
    stopLoss: rawStop,
    takeProfits,
    riskReward: { tp1: 1, tp2: 2, tp3: 3 },
    invalidationPrice: rawStop,
    confidence,
    structure,
    trends: {
      "4h": trend4h,
      "1h": trend1h,
      "15m": fifteenMinute.trend,
      "5m": fiveMinute.trend,
    },
    reasoning: [
      "4H and 1H market context: " + trend4h + " / " + trend1h,
      "15M structure: " + describeStructure(fifteenMinute),
      "5M execution trigger: " + describeStructure(fiveMinute),
      "Entry uses the current " + (bias === "BUY" ? "ask" : "bid") + " when supplied by the provider.",
      "Targets use 1R, 2R and 3R from the structural stop.",
    ],
  });

  return {
    status: "SIGNAL",
    signal,
    diagnostics: buildDiagnostics(input, quote, { "4h": trend4h, "1h": trend1h },
      {
        "1h": describeStructure(oneHour),
        "15m": describeStructure(fifteenMinute),
        "5m": describeStructure(fiveMinute),
      }, []),
  };
}
