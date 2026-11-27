import { describe, expect, it } from "vitest";
import { buildBinanceWebSocketUrls, normalizeBinanceTicker } from "./binance-spot-adapter";

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

 
describe("Binance public WebSocket endpoint failover", () => {
  it("tries the public market-data 443 host before the standard endpoints", () => {
    expect(buildBinanceWebSocketUrls("BTCUSD")).toEqual([
      "wss://data-stream.binance.vision/ws/btcusdt@ticker",
      "wss://stream.binance.com:443/ws/btcusdt@ticker",
      "wss://stream.binance.com:9443/ws/btcusdt@ticker",
    ]);
  });

  it("does not build a feed URL for unsupported instruments", () => {
    expect(buildBinanceWebSocketUrls("XAUUSD")).toEqual([]);
  });
});
