import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announceFeedSelectionChanged,
  FEED_SELECTION_CHANGED_EVENT,
  hasSameSymbolPriority,
  readSelectedCommoditySymbols,
  readSelectedForexPairs,
  readSelectedSiftingIoSymbols,
} from "./feed-preferences";

describe("Home Forex watchlist preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to four Forex pairs followed by Gold within the five shared slots", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
    });

    expect(readSelectedForexPairs()).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
    ]);
    expect(readSelectedCommoditySymbols()).toEqual(["XAUUSD"]);
    expect(readSelectedSiftingIoSymbols()).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "XAUUSD",
    ]);
  });

  it("filters selected Forex pairs from the shared five-instrument priority order", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => JSON.stringify([
          "XAUUSD",
          "USDJPY",
          "EURGBP",
          "EURUSD",
          "BTCUSD",
          "AUDUSD",
          "USDCHF",
          "GBPUSD",
        ])),
      },
    });

    expect(readSelectedForexPairs()).toEqual([
      "USDJPY",
      "EURGBP",
      "EURUSD",
      "AUDUSD",
    ]);
    expect(readSelectedSiftingIoSymbols()).toEqual([
      "XAUUSD",
      "USDJPY",
      "EURGBP",
      "EURUSD",
      "AUDUSD",
    ]);
  });

  it("migrates the old Gold-first starter preset to Forex-first priority", () => {
    const store = new Map<string, string>([
      ["tradesight-v2-sifting-symbols", JSON.stringify([
        "XAUUSD",
        "EURUSD",
        "GBPUSD",
        "USDJPY",
        "AUDUSD",
      ])],
    ]);
    const localStorage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    };
    vi.stubGlobal("window", { localStorage });

    expect(readSelectedForexPairs()).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
    ]);
    expect(readSelectedSiftingIoSymbols()).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "XAUUSD",
    ]);
    expect(JSON.parse(store.get("tradesight-v2-sifting-symbols") ?? "[]")).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "XAUUSD",
    ]);
  });

  it("migrates the previous Forex-only starter preset to include Gold", () => {
    const store = new Map<string, string>([
      ["tradesight-v2-sifting-symbols", JSON.stringify([
        "EURUSD",
        "GBPUSD",
        "USDJPY",
        "AUDUSD",
        "USDCAD",
      ])],
    ]);
    const localStorage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    };
    vi.stubGlobal("window", { localStorage });

    expect(readSelectedSiftingIoSymbols()).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "XAUUSD",
    ]);
  });

  it("keeps the first five saved symbols in order and caps mixed asset selections globally", () => {
    const store = new Map<string, string>([
      ["tradesight-v2-sifting-symbols", JSON.stringify([
        "XAUUSD", "XAGUSD", "WTIUSD", "EURUSD", "GBPUSD", "USDJPY",
      ])],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      },
    });

    expect(readSelectedSiftingIoSymbols()).toEqual([
      "XAUUSD", "XAGUSD", "WTIUSD", "EURUSD", "GBPUSD",
    ]);
    expect(readSelectedCommoditySymbols()).toEqual(["XAUUSD", "XAGUSD", "WTIUSD"]);
    expect(readSelectedForexPairs()).toEqual(["EURUSD", "GBPUSD"]);
    expect(JSON.parse(store.get("tradesight-v2-sifting-symbols") ?? "[]")).toHaveLength(5);
  });

  it("announces settings changes so the Home watchlist refreshes immediately", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
      dispatchEvent,
    });

    announceFeedSelectionChanged();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0]).toBeInstanceOf(Event);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe(FEED_SELECTION_CHANGED_EVENT);
  });
});

describe("Home commodity watchlist preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns only selected supported commodity symbols in saved selection order", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => JSON.stringify([
          "WTIUSD",
          "XAUUSD",
          "XAGUSD",
          "NATGAS",
          "XPTUSD",
          "EURUSD",
          "XPDUSD",
        ])),
      },
    });

    expect(readSelectedCommoditySymbols()).toEqual([
      "WTIUSD",
      "XAUUSD",
      "XAGUSD",
      "NATGAS",
      "XPTUSD",
    ]);
  });

  it("returns no commodity watchlist symbols when nothing is selected", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => JSON.stringify(["EURUSD", "GBPUSD"])) },
    });
    expect(readSelectedCommoditySymbols()).toEqual([]);
  });
});

describe("Applied feed selection comparison", () => {
  it("treats a different symbol order as a pending priority change", () => {
    expect(hasSameSymbolPriority(
      ["XAUUSD", "GBPUSD", "USDJPY"],
      ["GBPUSD", "USDJPY", "XAUUSD"],
    )).toBe(false);
  });

  it("matches only when the applied and saved priority lists are identical", () => {
    expect(hasSameSymbolPriority(
      ["XAUUSD", "GBPUSD", "USDJPY"],
      ["XAUUSD", "GBPUSD", "USDJPY"],
    )).toBe(true);
    expect(hasSameSymbolPriority(["XAUUSD"], [])).toBe(false);
  });
});

describe("Feed connection priority order", () => {
  it("connects selected symbols in user-selected order, then connects the remaining feeds", async () => {
    const { orderFeedSymbolsByPriority } = await import("./feed-preferences");
    expect(orderFeedSymbolsByPriority(
      ["USDJPY", "EURUSD", "XAUUSD"],
      ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD"],
    )).toEqual(["USDJPY", "EURUSD", "XAUUSD", "GBPUSD", "AUDUSD"]);
  });

  it("ignores duplicate and unsupported priority symbols", async () => {
    const { orderFeedSymbolsByPriority } = await import("./feed-preferences");
    expect(orderFeedSymbolsByPriority(
      ["EURUSD", "EURUSD", "INVALID"],
      ["XAUUSD", "EURUSD", "GBPUSD"],
    )).toEqual(["EURUSD", "XAUUSD", "GBPUSD"]);
  });
});
