import type { CanonicalQuote, InstrumentQuoteState, PriceBasis } from "../market-data/types";
import type { HistoricalCandle } from "../market-data/feed-adapter";
import { analyzeStructure } from "./structure-analysis";
import { isMarketSessionOpen } from "../market-data/market-session";

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
  | "MARKET_CLOSED"
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

export interface SignalCandleDiagnostics {
  readonly timeframe: SignalTimeframe;
  readonly required: boolean;
  readonly receivedCount: number;
  readonly completedCount: number;
  readonly minimumRequired: number;
  readonly latestCloseTimeMs: number | null;
  readonly latestAgeMs: number | null;
  readonly sufficientHistory: boolean;
  readonly fresh: boolean;
}

export interface SignalDiagnostics {
  readonly instrumentId: string;
  readonly quoteFreshness: InstrumentQuoteState["freshness"];
  readonly quoteConnected: boolean;
  readonly quoteTransport: CanonicalQuote["transport"] | null;
  readonly requiredTimeframes: readonly SignalTimeframe[];
  readonly candles: Readonly<Record<SignalTimeframe, SignalCandleDiagnostics>>;
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
  readonly choch: SignalSide | null;
  readonly sweep: SignalSide | null;
  readonly swingHigh: number | null;
  readonly swingLow: number | null;
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

function structureOf(bars: readonly HistoricalCandle[]): StructureEvidence {
  const result = analyzeStructure(bars);
  return {
    trend: result.trend,
    bos: result.breakType === "BOS" ? result.breakSide : null,
    choch: result.breakType === "CHoCH" ? result.breakSide : null,
    sweep: result.sweepSide,
    swingHigh: result.swingHigh?.price ?? null,
    swingLow: result.swingLow?.price ?? null,
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
  if (evidence.choch) return evidence.choch + "_CHoCH";
  if (evidence.bos) return evidence.bos + "_BOS";
  if (evidence.sweep) return evidence.sweep + "_LIQUIDITY_SWEEP";
  return "NO_TRIGGER";
}

function structureEventSide(evidence: StructureEvidence | null): SignalSide | null {
  return evidence?.choch ?? evidence?.bos ?? evidence?.sweep ?? null;
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
  bars: Readonly<Record<SignalTimeframe, readonly HistoricalCandle[]>>,
  needed: readonly SignalTimeframe[],
): SignalDiagnostics {
  const candleDiagnostics = Object.fromEntries(
    SIGNAL_TIMEFRAMES.map((timeframe) => {
      const completed = bars[timeframe];
      const latest = completed[completed.length - 1] ?? null;
      const latestCloseTimeMs = latest
        ? (latest.time + TF_SECONDS[timeframe]) * 1_000
        : null;
      const latestAgeMs = latestCloseTimeMs === null
        ? null
        : Math.max(0, input.nowMs - latestCloseTimeMs);
      return [timeframe, {
        timeframe,
        required: needed.includes(timeframe),
        receivedCount: input.candles[timeframe].length,
        completedCount: completed.length,
        minimumRequired: MIN_HISTORY,
        latestCloseTimeMs,
        latestAgeMs,
        sufficientHistory: completed.length >= MIN_HISTORY,
        fresh: latestAgeMs !== null && latestAgeMs <= TF_SECONDS[timeframe] * 2_000,
      }];
    }),
  ) as Record<SignalTimeframe, SignalCandleDiagnostics>;

  return {
    instrumentId: input.instrumentId,
    quoteFreshness: input.quoteState.freshness,
    quoteConnected: input.quoteState.connected,
    quoteTransport: quote?.transport ?? null,
    requiredTimeframes: [...needed],
    candles: candleDiagnostics,
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
  if (!isMarketSessionOpen(input.instrumentId, input.nowMs)) {
    addReason(rejectionCodes, "MARKET_CLOSED");
  }

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
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes, bars, needed),
    };
  }

  const bias = toSignalSide(fourHour.trend);
  let structure: TradingSignal["structure"] = "BOS";
  const contextReasons: string[] = ["4H structural bias: " + fourHour.trend];

  if (!bias) {
    addReason(rejectionCodes, "HIGHER_TIMEFRAME_CONFLICT");
  }

  // The 1H structure must agree with the 4H directional context. A lower
  // timeframe reversal is not promoted into a counter-trend signal.
  if (targetTimeframe !== "4h") {
    if (!oneHour || !bias || toSignalSide(oneHour.trend) !== bias) {
      addReason(rejectionCodes, "HIGHER_TIMEFRAME_CONFLICT");
    } else {
      contextReasons.push("1H structural confirmation: " + oneHour.trend + " (" + describeStructure(oneHour) + ")");
    }
  }

  const trigger = targetTimeframe === "4h"
    ? fourHour
    : targetTimeframe === "1h"
      ? oneHour
      : targetTimeframe === "15m"
        ? fifteenMinute
        : fiveMinute;

  // A 15M sweep or structural break is the setup context for a 5M entry.
  if (targetTimeframe === "5m" && bias) {
    if (!fifteenMinute || structureEventSide(fifteenMinute) !== bias) {
      addReason(rejectionCodes, "NO_15M_CONFIRMATION");
    } else {
      contextReasons.push("15M setup confirmation: " + describeStructure(fifteenMinute));
    }
  }

  if (trigger && bias) {
    const triggerSide = structureEventSide(trigger);
    if (triggerSide !== bias) {
      addReason(rejectionCodes, targetTimeframe === "5m" ? "NO_5M_TRIGGER" : "NO_TIMEFRAME_TRIGGER");
    }
    // 5M is the execution trigger: require a confirmed structure break. A
    // wick sweep by itself is setup information, not an entry confirmation.
    if (targetTimeframe === "5m" && trigger.bos !== bias && trigger.choch !== bias) {
      addReason(rejectionCodes, "NO_5M_TRIGGER");
    }
  } else {
    addReason(rejectionCodes, targetTimeframe === "5m" ? "NO_5M_TRIGGER" : "NO_TIMEFRAME_TRIGGER");
  }

  if (rejectionCodes.length > 0 || !bias || !trigger || !quote) {
    return {
      status: "NO_SETUP",
      signal: null,
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes, bars, needed),
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
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes, bars, needed),
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
      diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, rejectionCodes, bars, needed),
    };
  }

  // A confirmed close beyond structure is the execution trigger. If the
  // same candle also swept liquidity, keep the published label aligned with
  // the BOS/CHoCH reasoning rather than describing the entry as sweep-only.
  if (trigger.choch === bias) structure = "CHoCH";
  else if (trigger.bos === bias) structure = "BOS";
  else structure = "LIQUIDITY_SWEEP";

  const alignmentBonus = targetTimeframe === "4h" ? 0 : oneHour?.trend === fourHour.trend ? 8 : 0;
  const structureBonus = trigger.bos === bias ? 6 : trigger.choch === bias ? 4 : 2;
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
    diagnostics: buildDiagnostics(input, targetTimeframe, quote, { "4h": trend4h, "1h": trend1h }, structures, [], bars, needed),
  };
}

/** Allow a single market update to evaluate the full timeframe ladder. */
export function analyzeTradingSignals(input: SignalEngineInput): readonly SignalEngineResult[] {
  return SIGNAL_TIMEFRAMES.map((targetTimeframe) =>
    analyzeTradingSignal({ ...input, targetTimeframe }),
  );
}

