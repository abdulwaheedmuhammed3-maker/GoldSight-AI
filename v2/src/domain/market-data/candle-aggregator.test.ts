import { describe, expect, it } from "vitest";
import { updateActiveCandle } from "./candle-aggregator";
import type { CanonicalQuote } from "./types";

const baseTime = 1_800_000_000_000;
const quote = (price: number, sourceTimeMs: number, sequence: number): CanonicalQuote => ({
  instrumentId: "XAUUSD",
  provider: "broker-feed",
  providerSymbol: "XAUUSD",
  priceBasis: "bid",
  price,
  bid: price,
  ask: price + 0.2,
  last: null,
  sourceTimeMs,
  receivedTimeMs: sourceTimeMs,
  sequence,
  digits: 2,
});

describe("canonical quote candle aggregation", () => {
  it("sets the active candle close to the exact canonical quote price", () => {
    const firstTick = quote(4_073.1, baseTime, 1);
    const first = updateActiveCandle(null, firstTick, 60);
    expect(first.accepted).toBe(true);
    expect(first.candle?.close).toBe(firstTick.price);

    const nextTick = quote(4_073.4, baseTime + 1_000, 2);
    const update = updateActiveCandle(first.candle, nextTick, 60);
    expect(update.accepted).toBe(true);
    expect(update.candle?.close).toBe(nextTick.price);
    expect(update.candle?.high).toBe(nextTick.price);
    expect(update.candle?.low).toBe(firstTick.price);
    // Market-watch price and chart marker both read nextTick.price.
    expect(update.candle?.close).toBe(nextTick.price);
  });

  it("rejects candles from a different provider or price basis", () => {
    const first = updateActiveCandle(null, quote(4_073.1, baseTime, 1), 60);
    const incompatible = quote(4_074.1, baseTime + 1_000, 2);
    const result = updateActiveCandle(first.candle, {
      ...incompatible,
      provider: "different-provider",
    }, 60);
    expect(result.accepted).toBe(false);
    expect(result.candle).toBe(first.candle);
  });

  it("rolls into the next candle without inventing missing bars", () => {
    const first = updateActiveCandle(null, quote(4_073.1, baseTime, 1), 60);
    const nextTime = baseTime + 180_000;
    const next = updateActiveCandle(first.candle, quote(4_075.1, nextTime, 2), 60);

    expect(next.accepted).toBe(true);
    expect(next.rolledOver).toBe(true);
    expect(next.gapIntervals).toBe(2);
    expect(next.candle?.open).toBe(4_075.1);
    expect(next.candle?.close).toBe(4_075.1);
  });

  it("rejects an out-of-order tick instead of moving the chart backwards", () => {
    const first = updateActiveCandle(null, quote(4_073.1, baseTime + 2_000, 2), 60);
    const late = updateActiveCandle(first.candle, quote(4_072.9, baseTime + 1_000, 1), 60);
    expect(late.accepted).toBe(false);
    expect(late.candle?.close).toBe(4_073.1);
  });
});
