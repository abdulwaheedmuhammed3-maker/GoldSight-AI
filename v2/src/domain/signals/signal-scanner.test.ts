import { describe, expect, it, vi } from "vitest";
import { SignalScanner } from "./signal-scanner";
import type { CanonicalQuote, InstrumentQuoteState } from "../market-data/types";
import type { TradingSignal } from "./signal-engine";
import type { SignalEngineResult } from "./signal-engine";

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
    sourceTimeMs: 1_800_000_000_000,
    receivedTimeMs: 1_800_000_000_000,
    sequence: null,
    digits: 2,
  };
}

describe("SignalScanner", () => {
  it("scans only the canonical quote source and registers a valid signal once", () => {
    const quote = createQuote();
    const signal = {
      id: "XAUUSD:BUY:feed-a:1",
      instrumentId: "XAUUSD",
      side: "BUY",
      timeframe: "5m",
      generatedAt: quote.sourceTimeMs,
      source: "feed-a",
      priceBasis: "last",
      quoteTimeMs: quote.sourceTimeMs,
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

    const result: SignalEngineResult = {
      status: "SIGNAL",
      signal,
      diagnostics: {
        instrumentId: "XAUUSD",
        scannedAt: quote.receivedTimeMs,
        quoteAgeMs: 0,
        provider: "feed-a",
        priceBasis: "last",
        trend4h: "BULLISH",
        trend1h: "BULLISH",
        structure1h: "BUY_BOS",
        structure15m: "BUY_BOS",
        structure5m: "BUY_BOS",
        rejectionCodes: [],
        rejected: false,
      },
    };

    const quoteState: InstrumentQuoteState = {
      instrumentId: "XAUUSD",
      freshness: "LIVE",
      connected: true,
      refreshing: false,
      version: 1,
      lastError: null,
      persistenceError: null,
      activeProvider: "feed-a",
      quoteAgeMs: 0,
      quote,
    };

    const market = {
      getCandles: vi.fn(() => []),
    };
    const quotes = { getSnapshot: vi.fn(() => quoteState) };
    const outcomes = { register: vi.fn(() => true) };
    const scanner = new SignalScanner(
      market as never,
      quotes as never,
      outcomes as never,
      () => quote.receivedTimeMs,
    );
    const analyze = vi.spyOn(await import("./signal-engine"), "analyzeTradingSignal")
      .mockReturnValue(result);

    const first = scanner.scanQuote(quote);
    const second = scanner.scanQuote(quote);

    expect(first.status).toBe("SIGNAL");
    expect(second.generatedCount).toBe(1);
    expect(outcomes.register).toHaveBeenCalledTimes(2);
    expect(scanner.getSnapshot().totalSignals).toBe(2);
    expect(analyze).toHaveBeenCalled();

    analyze.mockRestore();
  });

  it("subscribes only once and can stop observing accepted quote ticks", () => {
    const addQuoteObserver = vi.fn(() => vi.fn());
    const scanner = new SignalScanner(
      { addQuoteObserver } as never,
      { getSnapshot: vi.fn() } as never,
      { register: vi.fn() } as never,
    );
    scanner.start();
    scanner.start();
    expect(addQuoteObserver).toHaveBeenCalledTimes(1);
    scanner.stop();
  });
});
