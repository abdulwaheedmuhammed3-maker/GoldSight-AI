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
      quoteFreshness: "LIVE",
      quoteConnected: true,
      quoteTransport: "WEBSOCKET",
      requiredTimeframes: ["4h", "1h", "15m", "5m"],
      candles: {
        "4h": { timeframe: "4h", required: true, receivedCount: 40, completedCount: 40, minimumRequired: 40, latestCloseTimeMs: now, latestAgeMs: 0, sufficientHistory: true, fresh: true },
        "1h": { timeframe: "1h", required: true, receivedCount: 40, completedCount: 40, minimumRequired: 40, latestCloseTimeMs: now, latestAgeMs: 0, sufficientHistory: true, fresh: true },
        "15m": { timeframe: "15m", required: true, receivedCount: 40, completedCount: 40, minimumRequired: 40, latestCloseTimeMs: now, latestAgeMs: 0, sufficientHistory: true, fresh: true },
        "5m": { timeframe: "5m", required: true, receivedCount: 40, completedCount: 40, minimumRequired: 40, latestCloseTimeMs: now, latestAgeMs: 0, sufficientHistory: true, fresh: true },
      },
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

    expect(first?.status).toBe("SIGNAL");
    expect(first?.timeframeResults.map((item) => item.timeframe)).toEqual(["4h", "1h", "15m", "5m"]);
    expect(first?.timeframeResults.filter((item) => item.status === "SIGNAL")).toHaveLength(1);
    expect(second?.generatedCount).toBe(1);
    expect(outcomes.register).toHaveBeenCalledTimes(2);
    expect(scanner.getSnapshot().totalScans).toBe(2);
    expect(scanner.getSnapshot().totalSignals).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(8);
  });



  it("does not analyze or count XAUUSD ticks while its market session is closed", () => {
    const saturday = Date.parse("2026-11-28T12:00:00Z");
    const quote = { ...createQuote(), receivedTimeMs: saturday, sourceTimeMs: saturday };
    const analyze = vi.fn();
    const outcomes = { register: vi.fn() };
    const scanner = new SignalScanner(
      { getCandles: vi.fn(() => []) } as never,
      { getSnapshot: vi.fn(() => ({ freshness: "LIVE" })) } as never,
      outcomes as never,
      () => saturday,
      analyze as never,
    );

    const record = scanner.scanQuote(quote);
    expect(record.status).toBe("MARKET_CLOSED");
    expect(record.scanCount).toBe(0);
    expect(record.sessionDetail).toContain("weekend closure");
    expect(analyze).not.toHaveBeenCalled();
    expect(outcomes.register).not.toHaveBeenCalled();
    expect(scanner.getSnapshot().totalScans).toBe(0);
    expect(scanner.getSnapshot().records).toHaveLength(1);
  });

  it("seeds explicit market-closed and waiting-for-tick rows when the scanner starts", () => {
    const saturday = Date.parse("2026-11-28T12:00:00Z");
    const scanner = new SignalScanner(
      { addQuoteObserver: vi.fn(() => vi.fn()) } as never,
      { getSnapshot: vi.fn() } as never,
      { register: vi.fn() } as never,
      () => saturday,
    );

    scanner.start();
    const records = new Map(
      scanner.getSnapshot().records.map((record) => [record.instrumentId, record]),
    );

    expect(records.get("BTCUSD")?.status).toBe("WAITING_FOR_TICK");
    expect(records.get("XAUUSD")?.status).toBe("MARKET_CLOSED");
    expect(records.get("XAGUSD")?.status).toBe("MARKET_CLOSED");
    expect(records.get("XPTUSD")?.status).toBe("MARKET_CLOSED");
    expect(records.get("XPDUSD")?.status).toBe("MARKET_CLOSED");
    expect(records.get("WTIUSD")?.status).toBe("MARKET_CLOSED");
    expect(records.get("UKOUSD")?.status).toBe("MARKET_CLOSED");
    expect(records.get("NATGAS")?.status).toBe("MARKET_CLOSED");
    expect(records.get("EURUSD")?.status).toBe("MARKET_CLOSED");
    expect(scanner.getSnapshot().totalScans).toBe(0);
    scanner.stop();
  });

  it("continues scanning BTCUSD during the FX and gold weekend closure", () => {
    const saturday = Date.parse("2026-11-28T12:00:00Z");
    const quote = {
      ...createQuote(),
      instrumentId: "BTCUSD",
      provider: "Binance Spot",
      providerSymbol: "BTCUSDT",
      receivedTimeMs: saturday,
      sourceTimeMs: saturday,
    };
    const analyze = vi.fn((input: SignalEngineInput) =>
      resultFor(input.targetTimeframe ?? "5m", null),
    );
    const scanner = new SignalScanner(
      { getCandles: vi.fn(() => []) } as never,
      { getSnapshot: vi.fn(() => ({
        instrumentId: "BTCUSD",
        freshness: "LIVE",
        connected: true,
        connectionStartedAtMs: saturday,
        refreshing: false,
        version: 1,
        lastError: null,
        persistenceError: null,
        activeProvider: "Binance Spot",
        quoteAgeMs: 0,
        quote,
      })) } as never,
      { register: vi.fn() } as never,
      () => saturday,
      analyze,
    );

    expect(scanner.scanQuote(quote)?.status).toBe("NO_SETUP");
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(scanner.getSnapshot().totalScans).toBe(1);
  });

  it.each(["REST_SNAPSHOT", "WEBSOCKET_SNAPSHOT"] as const)("does not create live signals from %s", (transport) => {
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
    observer.current?.({ ...createQuote(), transport });

    expect(analyze).not.toHaveBeenCalled();
    expect(outcomes.register).not.toHaveBeenCalled();
    expect(scanner.getSnapshot().totalScans).toBe(0);
    scanner.stop();
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
