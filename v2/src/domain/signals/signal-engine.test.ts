import { describe, expect, it } from "vitest";
import { analyzeTradingSignal } from "./signal-engine";
import type { HistoricalCandle } from "../market-data/feed-adapter";
import type { InstrumentQuoteState } from "../market-data/types";

const now = 1_800_000_000_000;

function bars(timeframeSeconds: number, count = 80, base = 100): HistoricalCandle[] {
  const result: HistoricalCandle[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = base + index * 0.5;
    result.push({
      time: Math.floor((now - (count - index) * timeframeSeconds * 1_000) / 1_000),
      open: close - 0.2,
      high: close + 0.1,
      low: close - 0.3,
      close,
      closed: true,
    });
  }
  const previous = result.slice(0, -1);
  const last = result[result.length - 1];
  const priorHigh = Math.max(...previous.slice(-20).map((bar) => bar.high));
  return [
    ...previous,
    { ...last, close: priorHigh + 0.4, high: priorHigh + 0.5 },
  ];
}

function quoteState(freshness: InstrumentQuoteState["freshness"] = "LIVE"): InstrumentQuoteState {
  return {
    instrumentId: "XAUUSD",
    freshness,
    connected: freshness === "LIVE",
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

  it("generates a structured signal when all four timeframes confirm", () => {
    const input = createInput();
    const result = analyzeTradingSignal(input);
    expect(result.status).toBe("SIGNAL");
    expect(result.signal?.side).toBe("BUY");
    expect(result.signal?.timeframe).toBe("5m");
    expect(result.signal?.takeProfits.tp2).toBeGreaterThan(result.signal!.entry);
    expect(result.signal?.stopLoss).toBeLessThan(result.signal!.entry);
    expect(result.signal?.riskReward).toEqual({ tp1: 1, tp2: 2, tp3: 3 });
  });
});
