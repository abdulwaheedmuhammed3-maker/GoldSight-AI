import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announceFeedSelectionChanged,
  FEED_SELECTION_CHANGED_EVENT,
  readSelectedCommoditySymbols,
  readSelectedForexPairs,
} from "./feed-preferences";

describe("Home Forex watchlist preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the five default Forex pairs when no preference has been saved", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
    });

    expect(readSelectedForexPairs()).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "USDCAD",
    ]);
  });

  it("shows only selected Forex pairs and preserves their selected order", () => {
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
      "USDCHF",
    ]);
  });

  it("migrates the original four-pair default to five Forex pairs", () => {
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
      "USDCAD",
    ]);
    expect(JSON.parse(store.get("tradesight-v2-sifting-symbols") ?? "[]")).toContain("USDCAD");
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
          "EURUSD",
          "XAGUSD",
          "NATGAS",
          "XPTUSD",
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
