import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BinanceSpotAdapter,
  buildBinanceWebSocketUrls,
  normalizeBinanceRestTicker,
  normalizeBinanceTicker,
} from "./binance-spot-adapter";

describe("Binance BTC spot ticker normalization", () => {
  it("maps last, bid, ask, event time and trade sequence into a canonical quote", () => {
    const quote = normalizeBinanceTicker("BTCUSD", {
      e: "24hrTicker",
      E: 1_800_000_000_000,
      s: "BTCUSDT",
      c: "74500.12000000",
      b: "74499.90000000",
      a: "74500.30000000",
      L: 123_456_789,
    }, 1_800_000_000_200);

    expect(quote).not.toBeNull();
    expect(quote?.instrumentId).toBe("BTCUSD");
    expect(quote?.providerSymbol).toBe("BTCUSDT");
    expect(quote?.priceBasis).toBe("last");
    expect(quote?.transport).toBe("WEBSOCKET");
    expect(quote?.price).toBe(74_500.12);
    expect(quote?.last).toBe(74_500.12);
    expect(quote?.bid).toBe(74_499.9);
    expect(quote?.ask).toBe(74_500.3);
    expect(quote?.sourceTimeMs).toBe(1_800_000_000_000);
    expect(quote?.sequence).toBe(123_456_789);
  });

  it("rejects an unexpected instrument or ticker event", () => {
    expect(normalizeBinanceTicker("XAUUSD", {
      e: "24hrTicker", E: 1_800_000_000_000, s: "BTCUSDT",
      c: "74500", b: "74499", a: "74501", L: 1,
    }, 1_800_000_000_100)).toBeNull();

    expect(normalizeBinanceTicker("BTCUSD", {
      e: "trade", E: 1_800_000_000_000, s: "BTCUSDT",
      c: "74500", b: "74499", a: "74501", L: 1,
    }, 1_800_000_000_100)).toBeNull();
  });

  it("rejects invalid bid/ask geometry and future provider time", () => {
    expect(normalizeBinanceTicker("BTCUSD", {
      e: "24hrTicker", E: 1_800_000_000_000, s: "BTCUSDT",
      c: "74500", b: "74501", a: "74500", L: 1,
    }, 1_800_000_000_100)).toBeNull();

    expect(normalizeBinanceTicker("BTCUSD", {
      e: "24hrTicker", E: 1_800_000_010_000, s: "BTCUSDT",
      c: "74500", b: "74499", a: "74501", L: 1,
    }, 1_800_000_000_100)).toBeNull();
  });
});

 
describe("Single official Binance BTC market-data feed", () => {
  it("uses only Binance's documented public market-data WebSocket endpoint", () => {
    expect(buildBinanceWebSocketUrls("BTCUSD")).toEqual([
      "wss://data-stream.binance.vision/ws/btcusdt@ticker",
    ]);
  });

  it("does not build a feed URL for unsupported instruments", () => {
    expect(buildBinanceWebSocketUrls("XAUUSD")).toEqual([]);
  });
});


describe("Binance live connection status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps REST snapshots and socket-open events unconnected until a live ticker arrives", async () => {
    const sockets: MockBinanceWebSocket[] = [];
    class MockBinanceWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = MockBinanceWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
      }

      open() {
        this.readyState = MockBinanceWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      sendTicker(payload: object) {
        this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
      }

      close() {
        this.readyState = MockBinanceWebSocket.CLOSED;
        this.onclose?.({} as CloseEvent);
      }
    }
    vi.stubGlobal("WebSocket", MockBinanceWebSocket);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        symbol: "BTCUSDT",
        lastPrice: "74500.12000000",
        bidPrice: "74499.90000000",
        askPrice: "74500.30000000",
        closeTime: Date.now(),
      }),
    }));

    const statuses: string[] = [];
    const quotes: unknown[] = [];
    const connection = new BinanceSpotAdapter().connect("BTCUSD", {
      onQuote: (quote) => quotes.push(quote),
      onStatus: (status) => statuses.push(status),
    });

    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    if (!socket) throw new Error("Mock Binance socket was not constructed.");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(quotes).toHaveLength(1);
    expect((quotes[0] as { transport?: string }).transport).toBe("REST_SNAPSHOT");
    expect(statuses).not.toContain("CONNECTED");

    socket.open();
    expect(statuses.at(-1)).toBe("CONNECTING");
    expect(statuses).not.toContain("CONNECTED");

    const now = Date.now();
    socket.sendTicker({
      e: "24hrTicker",
      E: now,
      s: "BTCUSDT",
      c: "74500.12000000",
      b: "74499.90000000",
      a: "74500.30000000",
      L: 123_456_789,
    });

    expect(quotes).toHaveLength(2);
    expect((quotes[1] as { transport?: string }).transport).toBe("WEBSOCKET");
    expect(statuses.at(-1)).toBe("CONNECTED");
    connection.close();
  });
});


describe("Binance REST snapshot normalization", () => {
  it("normalizes a fresh public ticker snapshot to the same Binance Spot source", () => {
    const quote = normalizeBinanceRestTicker("BTCUSD", {
      symbol: "BTCUSDT",
      lastPrice: "74500.12000000",
      bidPrice: "74499.90000000",
      askPrice: "74500.30000000",
      closeTime: 1_800_000_000_000,
    }, 1_800_000_000_200);

    expect(quote?.provider).toBe("Binance Spot");
    expect(quote?.instrumentId).toBe("BTCUSD");
    expect(quote?.transport).toBe("REST_SNAPSHOT");
    expect(quote?.price).toBe(74_500.12);
    expect(quote?.bid).toBe(74_499.9);
    expect(quote?.ask).toBe(74_500.3);
  });

  it("rejects invalid, stale, wrong-symbol and crossed ticker snapshots", () => {
    const valid = {
      symbol: "BTCUSDT",
      lastPrice: "74500",
      bidPrice: "74499",
      askPrice: "74501",
      closeTime: 1_800_000_000_000,
    };
    const now = 1_800_000_000_200;
    expect(normalizeBinanceRestTicker("XAUUSD", valid, now)).toBeNull();
    expect(normalizeBinanceRestTicker("BTCUSD", { ...valid, symbol: "ETHUSDT" }, now)).toBeNull();
    expect(normalizeBinanceRestTicker("BTCUSD", { ...valid, askPrice: "74498" }, now)).toBeNull();
    expect(normalizeBinanceRestTicker("BTCUSD", { ...valid, closeTime: now - 31_000 }, now)).toBeNull();
  });
});
