import { describe, expect, it, vi } from "vitest";
import { SignalScanner } from "./signal-scanner";
import type { CanonicalQuote, InstrumentQuoteState } from "../market-data/types";
import type { SignalEngineInput, TradingSignal } from "./signal-engine";
import type { SignalEngineResult } from "./signal-engine";

const now = 1_800_000_000_000;

function createQuote(): CanonicalQuote {
  return {
    instrumentId: "XAUUSD",
    provider: "feed-a",
    providerSymbol: "XAUUSD",
    priceBasis: "last",
    price: 100,
    bid: 99.9,
    ask: 100.1,
    last: 100,
    sourceTimeMs: now,
    receivedTimeMs: now,
    sequence: null,
    digits: 2,
  };
}

function resultFor(timeframe: "4h" | "1h" | "15m" | "5m", signal: TradingSignal | null): SignalEngineResult {
  return {
    status: signal ? "SIGNAL" : "NO_SETUP",
    signal,
    diagnostics: {
      instrumentId: "XAUUSD",
      targetTimeframe: timeframe,
      scannedAt: now,
      quoteAgeMs: 0,
      provider: "feed-a",
      priceBasis: "last",
      trend4h: "BULLISH",
      trend1h: "BULLISH",
      structure1h: "BUY_BOS",
      structure15m: "BUY_BOS",
      structure5m: "BUY_BOS",
      rejectionCodes: signal ? [] : ["NO_TIMEFRAME_TRIGGER"],
      rejected: !signal,
    },
  };
}

describe("SignalScanner", () => {
  it("scans all four timeframes and registers a repeated setup only once", () => {
    const quote = createQuote();
    const signal = {
      id: "XAUUSD:BUY:5m:feed-a:1",
      instrumentId: "XAUUSD",
      side: "BUY",
      timeframe: "5m",
      generatedAt: now,
      source: "feed-a",
      priceBasis: "last",
      quoteTimeMs: now,
      entry: 100,
      entryZone: { low: 99, high: 100 },
      stopLoss: 98,
      takeProfits: { tp1: 102, tp2: 104, tp3: 106 },
      riskReward: { tp1: 1, tp2: 2, tp3: 3 },
      invalidationPrice: 98,
      confidence: 70,
      structure: "BOS",
      trends: { "4h": "BULLISH", "1h": "BULLISH", "15m": "BULLISH", "5m": "BULLISH" },
      reasoning: [],
    } as unknown as TradingSignal;

    const quoteState: InstrumentQuoteState = {
      instrumentId: "XAUUSD",
      freshness: "LIVE",
      connected: true,
      connectionStartedAtMs: now - 100,
      refreshing: false,
      version: 1,
      lastError: null,
      persistenceError: null,
      activeProvider: "feed-a",
      quoteAgeMs: 0,
      quote,
    };

    const market = { getCandles: vi.fn(() => []) };
    const quotes = { getSnapshot: vi.fn(() => quoteState) };
    const registered = new Set<string>();
    const outcomes = {
      register: vi.fn((candidate: TradingSignal) => {
        if (registered.has(candidate.id)) return false;
        registered.add(candidate.id);
        return true;
      }),
    };
    const analyze = vi.fn((input: SignalEngineInput) =>
      input.targetTimeframe === "5m"
        ? resultFor("5m", signal)
        : resultFor(input.targetTimeframe ?? "5m", null),
    );
    const scanner = new SignalScanner(
      market as never,
      quotes as never,
      outcomes as never,
      () => now,
      analyze,
    );

    const first = scanner.scanQuote(quote);
    const second = scanner.scanQuote(quote);

    expect(first.status).toBe("SIGNAL");
    expect(first.timeframeResults.map((item) => item.timeframe)).toEqual(["4h", "1h", "15m", "5m"]);
    expect(first.timeframeResults.filter((item) => item.status === "SIGNAL")).toHaveLength(1);
    expect(second.generatedCount).toBe(1);
    expect(outcomes.register).toHaveBeenCalledTimes(2);
    expect(scanner.getSnapshot().totalScans).toBe(2);
    expect(scanner.getSnapshot().totalSignals).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(8);
  });



  it("does not create live signals from low-frequency REST snapshots", () => {
    const observer: { current?: (quote: CanonicalQuote) => void } = {};
    const analyze = vi.fn();
    const addQuoteObserver = vi.fn((listener: (quote: CanonicalQuote) => void) => {
      observer.current = listener;
      return vi.fn();
    });
    const outcomes = { register: vi.fn() };
    const scanner = new SignalScanner(
      { addQuoteObserver, getCandles: vi.fn(() => []) } as never,
      { getSnapshot: vi.fn() } as never,
      outcomes as never,
      () => now,
      analyze as never,
    );

    scanner.start();
    observer.current?.({ ...createQuote(), transport: "REST_SNAPSHOT" });

    expect(analyze).not.toHaveBeenCalled();
    expect(outcomes.register).not.toHaveBeenCalled();
    expect(scanner.getSnapshot().totalScans).toBe(0);
  });

  it("subscribes only once and can stop observing accepted quote ticks", () => {
    const remove = vi.fn();
    const addQuoteObserver = vi.fn(() => remove);
    const scanner = new SignalScanner(
      { addQuoteObserver } as never,
      { getSnapshot: vi.fn() } as never,
      { register: vi.fn() } as never,
    );
    scanner.start();
    scanner.start();
    expect(addQuoteObserver).toHaveBeenCalledTimes(1);
    scanner.stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
