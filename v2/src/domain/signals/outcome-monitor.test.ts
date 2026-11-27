import { describe, expect, it, vi } from "vitest";
import { OutcomeMonitor } from "./outcome-monitor";
import type { TradingSignal } from "./signal-engine";
import type { CanonicalQuote } from "../market-data/types";

const now = 1_800_000_000_000;

function makeSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: "XAUUSD:BUY:test:1",
    instrumentId: "XAUUSD",
    side: "BUY",
    timeframe: "5m",
    generatedAt: now - 1_000,
    source: "broker-feed",
    priceBasis: "last",
    quoteTimeMs: now - 1_000,
    entry: 100,
    entryZone: { low: 99.5, high: 100.5 },
    stopLoss: 98,
    takeProfits: { tp1: 102, tp2: 104, tp3: 106 },
    riskReward: { tp1: 1, tp2: 2, tp3: 3 },
    invalidationPrice: 98,
    confidence: 75,
    structure: "BOS",
    trends: { "4h": "BULLISH", "1h": "BULLISH", "15m": "BULLISH", "5m": "BULLISH" },
    reasoning: ["test signal"],
    ...overrides,
  };
}

function makeQuote(price: number, sourceTimeMs = now): CanonicalQuote {
  return {
    instrumentId: "XAUUSD",
    provider: "broker-feed",
    providerSymbol: "XAUUSD",
    priceBasis: "last",
    price,
    bid: price - 0.05,
    ask: price + 0.05,
    last: price,
    sourceTimeMs,
    receivedTimeMs: sourceTimeMs,
    sequence: null,
    digits: 2,
  };
}

describe("OutcomeMonitor", () => {
  it("registers a setup only once", () => {
    const monitor = new OutcomeMonitor({ now: () => now, maxQuoteAgeMs: () => 5_000 });
    const signal = makeSignal();
    expect(monitor.register(signal)).toBe(true);
    expect(monitor.register(signal)).toBe(false);
  });

  it("emits TP1 and TP2 exactly once when a quote jumps across both", () => {
    const notify = vi.fn();
    const monitor = new OutcomeMonitor({
      now: () => now,
      maxQuoteAgeMs: () => 5_000,
      notification: { notify },
    });
    monitor.register(makeSignal());

    const first = monitor.ingestQuote(makeQuote(104.2, now));
    const duplicate = monitor.ingestQuote(makeQuote(105, now + 500));

    expect(first.map((event) => event.milestone)).toEqual(["TP1", "TP2"]);
    expect(duplicate).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("emits an SL event and closes the setup", () => {
    const monitor = new OutcomeMonitor({ now: () => now, maxQuoteAgeMs: () => 5_000 });
    monitor.register(makeSignal());

    const events = monitor.ingestQuote(makeQuote(97.9, now));
    const snapshot = monitor.getSnapshot();

    expect(events.map((event) => event.milestone)).toEqual(["SL"]);
    expect(snapshot.setups[0].status).toBe("SL_HIT");
    expect(snapshot.setups[0].closedAt).toBe(now);
  });

  it("does not monitor another provider's quote or an older quote", () => {
    const monitor = new OutcomeMonitor({ now: () => now, maxQuoteAgeMs: () => 5_000 });
    monitor.register(makeSignal());

    expect(monitor.ingestQuote({ ...makeQuote(105), provider: "different-feed" })).toEqual([]);
    expect(monitor.ingestQuote(makeQuote(105, now - 2_000))).toEqual([]);
  });

  it("rejects stale quotes and does not keep monitoring after TP3", () => {
    const monitor = new OutcomeMonitor({ now: () => now, maxQuoteAgeMs: () => 1_000 });
    monitor.register(makeSignal());

    expect(monitor.ingestQuote(makeQuote(107, now - 2_000), now)).toEqual([]);
    expect(monitor.ingestQuote(makeQuote(107, now), now)).toHaveLength(3);
    expect(monitor.getSnapshot().setups[0].status).toBe("TP3_HIT");
    expect(monitor.ingestQuote(makeQuote(97, now + 100), now + 100)).toEqual([]);
  });

  it("handles sell targets and stops in the opposite direction", () => {
    const monitor = new OutcomeMonitor({ now: () => now, maxQuoteAgeMs: () => 5_000 });
    monitor.register(makeSignal({
      id: "XAUUSD:SELL:test:1",
      side: "SELL",
      entry: 100,
      stopLoss: 102,
      takeProfits: { tp1: 98, tp2: 96, tp3: 94 },
      invalidationPrice: 102,
    }));

    expect(monitor.ingestQuote(makeQuote(95, now)).map((event) => event.milestone)).toEqual(["TP1", "TP2", "TP3"]);
  });
});
