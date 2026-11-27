import { describe, expect, it } from "vitest";
import { analyzeTradingSignal } from "./signal-engine";
import { analyzeStructure } from "./structure-analysis";
import type { HistoricalCandle } from "../market-data/feed-adapter";
import type { InstrumentQuoteState } from "../market-data/types";

const now = 1_800_000_000_000;

function bars(
  timeframeSeconds: number,
  count = 96,
  base = 73,
  direction: 1 | -1 = 1,
  trigger = true,
): HistoricalCandle[] {
  const pattern = [0, 3, 6, 2, 4, 7];
  const result: HistoricalCandle[] = Array.from({ length: count }, (_, index) => {
    const close = base + direction * (Math.floor(index / 6) * 4 + pattern[index % 6]);
    const open = close - direction * 0.2;
    return {
      time: Math.floor((now - (count - index) * timeframeSeconds * 1_000) / 1_000),
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.3,
      close,
      closed: true,
    };
  });
  const initial = analyzeStructure(result);
  const last = result[result.length - 1];
  const latestHigh = initial.swingHigh?.price ?? last.high;
  const latestLow = initial.swingLow?.price ?? last.low;
  const close = trigger
    ? direction === 1 ? latestHigh + 1 : latestLow - 1
    : (latestHigh + latestLow) / 2;
  const open = close - direction * 0.3;
  result[result.length - 1] = {
    ...last,
    open,
    high: Math.max(open, close) + 0.2,
    low: Math.min(open, close) - 0.3,
    close,
  };
  return result;
}

function quoteState(freshness: InstrumentQuoteState["freshness"] = "LIVE"): InstrumentQuoteState {
  return {
    instrumentId: "XAUUSD",
    freshness,
    connected: freshness === "LIVE",
    connectionStartedAtMs: freshness === "LIVE" ? now - 500 : null,
    refreshing: false,
    version: 1,
    lastError: null,
    persistenceError: null,
    activeProvider: "feed-a",
    quoteAgeMs: 100,
    quote: {
      instrumentId: "XAUUSD",
      provider: "feed-a",
      providerSymbol: "XAUUSD",
      priceBasis: "last",
      price: 140,
      bid: 139.9,
      ask: 140.1,
      last: 140,
      sourceTimeMs: now - 100,
      receivedTimeMs: now,
      sequence: 1,
      digits: 2,
    },
  };
}

function createInput(overrides: Partial<Parameters<typeof analyzeTradingSignal>[0]> = {}) {
  return {
    instrumentId: "XAUUSD",
    quoteState: quoteState(),
    candles: {
      "5m": bars(300),
      "15m": bars(900),
      "1h": bars(3600),
      "4h": bars(14400),
    },
    candleProvider: "feed-a",
    candlePriceBasis: "last" as const,
    nowMs: now,
    ...overrides,
  };
}

describe("multi-timeframe signal engine", () => {
  it("does not create a setup from stale prices", () => {
    const result = analyzeTradingSignal(createInput({ quoteState: quoteState("STALE") }));
    expect(result.status).toBe("NO_SETUP");
    expect(result.diagnostics.rejectionCodes).toContain("NO_LIVE_QUOTE");
  });

  it("rejects candle sources that do not match the current quote source", () => {
    const result = analyzeTradingSignal(createInput({ candleProvider: "different-feed" }));
    expect(result.status).toBe("NO_SETUP");
    expect(result.diagnostics.rejectionCodes).toContain("SOURCE_MISMATCH");
  });

  it("records insufficient candle history instead of inventing missing bars", () => {
    const input = createInput({
      candles: {
        "5m": bars(300, 12),
        "15m": bars(900),
        "1h": bars(3600),
        "4h": bars(14400),
      },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("NO_SETUP");
    expect(result.diagnostics.rejectionCodes).toContain("INSUFFICIENT_HISTORY");
  });

  it("generates a structured 5M signal when all four timeframes confirm", () => {
    const input = createInput();
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("SIGNAL");
    expect(result.signal?.side).toBe("BUY");
    expect(result.signal?.timeframe).toBe("5m");
    expect(result.signal?.takeProfits.tp2).toBeGreaterThan(result.signal!.entry);
    expect(result.signal?.stopLoss).toBeLessThan(result.signal!.entry);
    expect(result.signal?.riskReward).toEqual({ tp1: 1, tp2: 2, tp3: 3 });
  });

  it("can validate a 4H opportunity without requiring lower-timeframe candles", () => {
    const input = createInput({
      targetTimeframe: "4h",
      candles: { "4h": bars(14_400), "1h": [], "15m": [], "5m": [] },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("SIGNAL");
    expect(result.signal?.timeframe).toBe("4h");
    expect(result.diagnostics.structure1h).toBe("NOT_REQUIRED");
  });

  it("can validate a 1H opportunity without requiring 15M or 5M history", () => {
    const input = createInput({
      targetTimeframe: "1h",
      candles: { "4h": bars(14_400), "1h": bars(3_600), "15m": [], "5m": [] },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("SIGNAL");
    expect(result.signal?.timeframe).toBe("1h");
    expect(result.diagnostics.structure15m).toBe("NOT_REQUIRED");
  });

  it("can validate a 15M opportunity without requiring 5M history", () => {
    const input = createInput({
      targetTimeframe: "15m",
      candles: { "4h": bars(14_400), "1h": bars(3_600), "15m": bars(900), "5m": [] },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("SIGNAL");
    expect(result.signal?.timeframe).toBe("15m");
    expect(result.diagnostics.structure5m).toBe("NOT_REQUIRED");
  });
  it("labels a confirmed 5M BOS as BOS when the same candle also sweeps liquidity", () => {
    const fiveMinute = bars(300);
    const priorStructure = analyzeStructure(fiveMinute);
    const last = fiveMinute[fiveMinute.length - 1];
    fiveMinute[fiveMinute.length - 1] = {
      ...last,
      low: priorStructure.swingLow!.price - 1,
    };

    const result = analyzeTradingSignal(createInput({
      candles: {
        "5m": fiveMinute,
        "15m": bars(900),
        "1h": bars(3_600),
        "4h": bars(14_400),
      },
    }));

    expect(result.status).toBe("SIGNAL");
    expect(result.signal?.structure).toBe("BOS");
  });

  it("rejects a 5M entry when the 15M setup has no directional confirmation", () => {
    const input = createInput({
      candles: {
        "5m": bars(300),
        "15m": bars(900, 96, 100, 1, false),
        "1h": bars(3_600),
        "4h": bars(14_400),
      },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("NO_SETUP");
    expect(result.diagnostics.rejectionCodes).toContain("NO_15M_CONFIRMATION");
  });

  it("requires a confirmed 5M structure break, not a wick sweep alone", () => {
    const input = createInput({
      candles: {
        "5m": bars(300, 96, 100, 1, false),
        "15m": bars(900),
        "1h": bars(3_600),
        "4h": bars(14_400),
      },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("NO_SETUP");
    expect(result.diagnostics.rejectionCodes).toContain("NO_5M_TRIGGER");
  });

  it("rejects lower-timeframe signals when 1H structure conflicts with 4H bias", () => {
    const input = createInput({
      candles: {
        "5m": bars(300),
        "15m": bars(900),
        "1h": bars(3_600, 96, 100, -1),
        "4h": bars(14_400),
      },
    });
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("NO_SETUP");
    expect(result.diagnostics.rejectionCodes).toContain("HIGHER_TIMEFRAME_CONFLICT");
  });

});
