import { describe, expect, it, vi } from "vitest";
import { MarketDataEngine } from "./market-data-engine";
import { QuoteStore } from "./quote-store";
import type { CanonicalQuote } from "./types";
import type { CandlePersistence, FeedCallbacks, FeedConnection, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";

const fixedNow = 1_800_000_000_000;

function makeQuote(price: number, sourceTimeMs = fixedNow, sequence = 1): CanonicalQuote {
  return {
    instrumentId: "XAUUSD",
    provider: "test-stream",
    providerSymbol: "XAUUSD",
    priceBasis: "last",
    price,
    bid: price - 0.1,
    ask: price + 0.1,
    last: price,
    sourceTimeMs,
    receivedTimeMs: sourceTimeMs,
    sequence,
    digits: 2,
  };
}

class FakeAdapter implements MarketFeedAdapter {
  readonly providerId = "test-stream";
  readonly supportedInstrumentIds = ["XAUUSD"];
  callbacks: FeedCallbacks | null = null;

  connect(_instrumentId: string, callbacks: FeedCallbacks): FeedConnection {
    this.callbacks = callbacks;
    callbacks.onStatus("CONNECTED");
    return { close: () => callbacks.onStatus("DISCONNECTED") };
  }

  emit(quote: CanonicalQuote): void {
    this.callbacks?.onQuote(quote);
  }

  async loadCandles(): Promise<readonly HistoricalCandle[]> {
    return [];
  }
}

function setup() {
  const quotes = new QuoteStore({ now: () => fixedNow + 10_000, maxAgeMs: () => 30_000 });
  const engine = new MarketDataEngine(quotes);
  const adapter = new FakeAdapter();
  engine.registerAdapter(adapter);
  engine.connect("XAUUSD", "test-stream");
  return { quotes, engine, adapter };
}

describe("MarketDataEngine shared price path", () => {
  it("publishes one accepted quote to watch state and every active candle", () => {
    const { engine, adapter } = setup();
    const tick = makeQuote(4_073.45);
    adapter.emit(tick);

    const state = engine.getState("XAUUSD");
    expect(state.quote.quote?.price).toBe(tick.price);

    for (const timeframe of ["5m", "15m", "1h", "4h"] as const) {
      const candles = engine.getCandles("XAUUSD", timeframe, "test-stream");
      expect(candles.at(-1)?.close).toBe(tick.price);
    }
  });

  it.each(["REST_SNAPSHOT", "WEBSOCKET_SNAPSHOT"] as const)("stores %s without notifying tick observers or building candles", (transport) => {
    const { engine, adapter } = setup();
    const observer = vi.fn();
    engine.addQuoteObserver(observer);
    const snapshot = { ...makeQuote(4_073.45), transport };
    adapter.emit(snapshot);

    expect(engine.getState("XAUUSD").quote.quote?.price).toBe(4_073.45);
    expect(engine.getCandles("XAUUSD", "5m", "test-stream")).toHaveLength(0);
    expect(observer).not.toHaveBeenCalled();
  });

  it("retains a closed-session quote for reference but does not build candles", () => {
    const closedAt = Date.parse("2026-11-28T05:50:00Z");
    const quotes = new QuoteStore({ now: () => closedAt + 500, maxAgeMs: () => 30_000 });
    const engine = new MarketDataEngine(quotes);
    const adapter = new FakeAdapter();
    adapter.connect = (_instrumentId, callbacks) => {
      adapter.callbacks = callbacks;
      return { close: () => callbacks.onStatus("DISCONNECTED") };
    };
    engine.registerAdapter(adapter);
    engine.connect("XAUUSD", "test-stream");
    const observer = vi.fn();
    engine.addQuoteObserver(observer);

    adapter.emit(makeQuote(4_073.45, closedAt, 1));

    expect(engine.getState("XAUUSD").quote.quote?.price).toBe(4_073.45);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(engine.getCandles("XAUUSD", "5m", "test-stream")).toHaveLength(0);
  });

  it("keeps last-known-good quote and candle after the feed disconnects", () => {
    const { engine, adapter } = setup();
    adapter.emit(makeQuote(4_073.45));
    engine.disconnect("XAUUSD");

    const state = engine.getState("XAUUSD");
    expect(state.quote.quote?.price).toBe(4_073.45);
    expect(state.quote.freshness).toBe("OFFLINE");
    expect(state.feedStatus).toBe("DISCONNECTED");
    expect(engine.getCandles("XAUUSD", "5m", "test-stream").at(-1)?.close).toBe(4_073.45);
  });

  it("does not let an older tick move the chart away from the shared quote", () => {
    const { engine, adapter } = setup();
    adapter.emit(makeQuote(4_073.45, fixedNow, 2));
    adapter.emit(makeQuote(4_072.90, fixedNow - 1_000, 1));

    expect(engine.getState("XAUUSD").quote.quote?.price).toBe(4_073.45);
    expect(engine.getCandles("XAUUSD", "5m", "test-stream").at(-1)?.close).toBe(4_073.45);
  });

  it("seeds the current candle from provider OHLC then applies the latest shared quote", async () => {
    const quotes = new QuoteStore({ now: () => fixedNow + 10_000, maxAgeMs: () => 30_000 });
    const engine = new MarketDataEngine(quotes);
    const adapter = new FakeAdapter();
    // Provide the response before connect(), because the engine bootstraps history on CONNECTED.
    adapter.loadCandles = async () => [{
      time: Math.floor(fixedNow / 300_000) * 300,
      open: 4_068.00,
      high: 4_075.00,
      low: 4_066.00,
      close: 4_072.90,
      closed: false,
    }];
    engine.registerAdapter(adapter);
    engine.connect("XAUUSD", "test-stream");

    const current = makeQuote(4_073.45, fixedNow, 2);
    adapter.emit(current);

    await engine.loadHistory("XAUUSD", "test-stream", "5m");
    const latest = engine.getCandles("XAUUSD", "5m", "test-stream").at(-1);
    expect(latest?.open).toBe(4_068.00);
    expect(latest?.high).toBe(4_075.00);
    expect(latest?.low).toBe(4_066.00);
    expect(latest?.close).toBe(current.price);
    expect(latest?.close).toBe(engine.getState("XAUUSD").quote.quote?.price);
  });

  it.each(["REST_SNAPSHOT", "WEBSOCKET_SNAPSHOT"] as const)("does not seed an active candle from %s during history loading", async (transport) => {
    const quotes = new QuoteStore({ now: () => fixedNow + 10_000, maxAgeMs: () => 30_000 });
    const engine = new MarketDataEngine(quotes);
    const adapter = new FakeAdapter();
    adapter.loadCandles = async () => [{
      time: Math.floor(fixedNow / 300_000) * 300,
      open: 4_068.00,
      high: 4_075.00,
      low: 4_066.00,
      close: 4_072.90,
      closed: false,
    }];
    adapter.connect = (_instrumentId, callbacks) => {
      adapter.callbacks = callbacks;
      return { close: () => callbacks.onStatus("DISCONNECTED") };
    };
    engine.registerAdapter(adapter);
    engine.connect("XAUUSD", "test-stream");
    adapter.emit({ ...makeQuote(4_073.45), transport });

    await engine.loadHistory("XAUUSD", "test-stream", "5m");
    expect(engine.getCandles("XAUUSD", "5m", "test-stream")).toHaveLength(0);
  });

  it.each(["REST_SNAPSHOT", "WEBSOCKET_SNAPSHOT"] as const)("does not apply %s received during history loading to an active candle", async (transport) => {
    const quotes = new QuoteStore({ now: () => fixedNow + 10_000, maxAgeMs: () => 30_000 });
    const engine = new MarketDataEngine(quotes);
    const adapter = new FakeAdapter();
    let resolveHistory: (bars: readonly HistoricalCandle[]) => void = () => undefined;
    adapter.connect = (_instrumentId, callbacks) => {
      adapter.callbacks = callbacks;
      return { close: () => callbacks.onStatus("DISCONNECTED") };
    };
    adapter.loadCandles = () => new Promise((resolve) => { resolveHistory = resolve; });
    engine.registerAdapter(adapter);
    engine.connect("XAUUSD", "test-stream");
    const liveTick = makeQuote(4_073.45, fixedNow, 1);
    adapter.emit(liveTick);

    const load = engine.loadHistory("XAUUSD", "test-stream", "5m");
    await Promise.resolve();
    adapter.emit({
      ...makeQuote(4_076.20, fixedNow + 1_000, 2),
      transport,
    });
    resolveHistory([{
      time: Math.floor(fixedNow / 300_000) * 300,
      open: 4_068.00,
      high: 4_075.00,
      low: 4_066.00,
      close: 4_072.90,
      closed: false,
    }]);
    await load;

    expect(engine.getCandles("XAUUSD", "5m", "test-stream").at(-1)?.close).toBe(liveTick.price);
  });

  it("archives the prior candle when a new timeframe bucket starts", () => {
    const { engine, adapter } = setup();
    adapter.emit(makeQuote(4_073.10, fixedNow - 1_000, 1));
    adapter.emit(makeQuote(4_075.25, fixedNow + 500, 2));

    const candles = engine.getCandles("XAUUSD", "5m", "test-stream");
    expect(candles).toHaveLength(2);
    expect(candles[0].close).toBe(4_073.10);
    expect(candles[1].close).toBe(4_075.25);
  });

  it("restores cached candles for offline chart access", async () => {
    const cached: HistoricalCandle[] = [{
      time: Math.floor(fixedNow / 300_000) * 300,
      open: 4_070,
      high: 4_075,
      low: 4_068,
      close: 4_073,
      closed: true,
    }];
    const persistence: CandlePersistence = {
      loadCandles: async (instrumentId, timeframe, providerId) =>
        instrumentId === "XAUUSD" && timeframe === "5m" && providerId === "test-stream" ? cached : [],
      saveCandles: async () => undefined,
    };
    const quotes = new QuoteStore({ now: () => fixedNow + 10_000, maxAgeMs: () => 30_000 });
    const engine = new MarketDataEngine(quotes, persistence);

    await engine.hydrateCachedHistory([{ instrumentId: "XAUUSD", providerId: "test-stream" }]);

    expect(engine.getCandles("XAUUSD", "5m", "test-stream")).toEqual(cached);
  });
});
