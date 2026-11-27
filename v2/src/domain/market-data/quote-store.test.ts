import { describe, expect, it, vi } from "vitest";
import { getQuoteDisplayFreshness, QuoteStore } from "./quote-store";
import type { CanonicalQuote, QuotePersistence } from "./types";

const now = 1_800_000_000_000;
const makeQuote = (overrides: Partial<CanonicalQuote> = {}): CanonicalQuote => ({
  instrumentId: "XAUUSD",
  provider: "example-broker-stream",
  providerSymbol: "XAUUSD",
  priceBasis: "bid",
  price: 4_073.12,
  bid: 4_073.12,
  ask: 4_073.32,
  last: null,
  sourceTimeMs: now,
  receivedTimeMs: now,
  sequence: 1,
  digits: 2,
  ...overrides,
});

describe("QuoteStore", () => {
  it("keeps the last valid price visible while a refresh starts and fails", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    store.setConnection("XAUUSD", true);
    expect(store.ingest(makeQuote())).toBe(true);

    store.beginRefresh("XAUUSD");
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);

    store.failRefresh("XAUUSD", "provider timeout");
    const state = store.getSnapshot("XAUUSD");
    expect(state.quote?.price).toBe(4_073.12);
    expect(state.freshness).toBe("OFFLINE");
    expect(state.lastError).toBe("provider timeout");
  });


  it.each(["REST_SNAPSHOT", "WEBSOCKET_SNAPSHOT"] as const)("never classifies a fresh %s as LIVE", (transport) => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 7 * 60_000 });
    const snapshot = makeQuote({ transport });
    expect(store.ingest(snapshot)).toBe(true);
    const state = store.getSnapshot("XAUUSD");
    expect(state.quote?.price).toBe(snapshot.price);
    expect(state.quote?.transport).toBe(transport);
    expect(state.freshness).toBe("STALE");
  });

  it("does not mark a retained quote LIVE after reconnect until a new tick arrives", () => {
    let clock = now;
    const store = new QuoteStore({ now: () => clock, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote())).toBe(true);
    expect(store.getSnapshot("XAUUSD").freshness).toBe("LIVE");

    clock += 100;
    store.setConnection("XAUUSD", false);
    store.setConnection("XAUUSD", true);
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);
    expect(store.getSnapshot("XAUUSD").freshness).toBe("STALE");

    clock += 100;
    expect(store.ingest(makeQuote({
      price: 4_073.22,
      bid: 4_073.22,
      sourceTimeMs: clock,
      receivedTimeMs: clock,
      sequence: 2,
    }))).toBe(true);
    expect(store.getSnapshot("XAUUSD").freshness).toBe("LIVE");
  });

  it("rejects older ticks without replacing the current quote", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote())).toBe(true);
    expect(store.ingest(makeQuote({
      price: 4_072.90,
      bid: 4_072.90,
      sourceTimeMs: now - 1_000,
      receivedTimeMs: now,
      sequence: 2,
    }))).toBe(false);
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);
  });

  it("rejects a provider change until it is explicitly selected", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote())).toBe(true);
    expect(store.ingest(makeQuote({
      provider: "different-feed",
      price: 4_074,
      bid: 4_074,
      ask: 4_074.2,
      sourceTimeMs: now + 100,
      receivedTimeMs: now + 100,
      sequence: 1,
    }))).toBe(false);

    store.setActiveProvider("XAUUSD", "different-feed");
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);
    expect(store.getSnapshot("XAUUSD").freshness).toBe("STALE");

    expect(store.ingest(makeQuote({
      provider: "different-feed",
      price: 4_074,
      bid: 4_074,
      ask: 4_074.2,
      sourceTimeMs: now + 100,
      receivedTimeMs: now + 100,
      sequence: 1,
    }))).toBe(true);
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_074);
  });

  it("rejects a sequence regression even when the event timestamp is newer", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote())).toBe(true);
    expect(store.ingest(makeQuote({
      price: 4_074,
      bid: 4_074,
      sourceTimeMs: now + 100,
      receivedTimeMs: now + 100,
      sequence: 0,
    }))).toBe(false);
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);
  });

  it("reports STALE from provider time, not from repaint time", () => {
    let clock = now;
    const store = new QuoteStore({ now: () => clock, maxAgeMs: () => 1_000 });
    store.setConnection("XAUUSD", true);
    store.ingest(makeQuote());
    expect(store.getSnapshot("XAUUSD").freshness).toBe("LIVE");
    clock += 1_001;
    expect(store.getSnapshot("XAUUSD").freshness).toBe("STALE");
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);
  });

  it("hydrates cached quotes as OFFLINE while retaining their price", async () => {
    const persistence: QuotePersistence = {
      loadAll: vi.fn(async () => [makeQuote()]),
      save: vi.fn(async () => undefined),
    };
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000, persistence });
    await store.hydrate();
    const state = store.getSnapshot("XAUUSD");
    expect(state.quote?.price).toBe(4_073.12);
    expect(state.freshness).toBe("OFFLINE");
  });

  it("keeps the in-memory live quote if local persistence fails", async () => {
    const persistence: QuotePersistence = {
      loadAll: vi.fn(async () => []),
      save: vi.fn(async () => { throw new Error("disk full"); }),
    };
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000, persistence });
    store.ingest(makeQuote());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot("XAUUSD").quote?.price).toBe(4_073.12);
    expect(store.getSnapshot("XAUUSD").persistenceError).toBe("disk full");
  });

  it("emits the same quote version to every subscriber", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe("XAUUSD", first);
    store.subscribe("XAUUSD", second);
    store.ingest(makeQuote());

    const firstState = first.mock.calls.at(-1)?.[0];
    const secondState = second.mock.calls.at(-1)?.[0];
    expect(firstState.version).toBe(secondState.version);
    expect(firstState.quote).toBe(secondState.quote);
    expect(firstState.quote.price).toBe(secondState.quote.price);
  });

  it("does not show a dash or fake value before the first valid quote", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    const state = store.getSnapshot("XAUUSD");
    expect(state.freshness).toBe("WAITING");
    expect(state.quote).toBeNull();
  });
});

describe("Quote display freshness", () => {
  it.each(["REST_SNAPSHOT", "WEBSOCKET_SNAPSHOT"] as const)("never labels a recent %s as a live tick", (transport) => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote({ transport }))).toBe(true);
    const state = store.getSnapshot("XAUUSD");
    expect(state.freshness).toBe("LIVE");
    expect(getQuoteDisplayFreshness(state)).toBe("SNAPSHOT");
  });

  it("returns to the store freshness when the REST snapshot expires", () => {
    let clock = now;
    const store = new QuoteStore({ now: () => clock, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote({ transport: "REST_SNAPSHOT" }))).toBe(true);
    clock += 7 * 60_000 + 1;
    expect(getQuoteDisplayFreshness(store.getSnapshot("XAUUSD"))).toBe("STALE");
  });

  it("keeps a fresh WebSocket quote labelled LIVE", () => {
    const store = new QuoteStore({ now: () => now, maxAgeMs: () => 5_000 });
    expect(store.ingest(makeQuote({ transport: "WEBSOCKET" }))).toBe(true);
    expect(getQuoteDisplayFreshness(store.getSnapshot("XAUUSD"))).toBe("LIVE");
  });
});
