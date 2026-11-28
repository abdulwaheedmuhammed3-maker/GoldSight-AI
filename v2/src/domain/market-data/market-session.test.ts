import { describe, expect, it } from "vitest";
import { isMarketSessionOpen } from "./market-session";

describe("TradeSight market sessions", () => {
  it("keeps BTCUSD open throughout weekends and maintenance hours", () => {
    expect(isMarketSessionOpen("BTCUSD", Date.parse("2026-11-28T12:00:00Z"))).toBe(true);
    expect(isMarketSessionOpen("BTCUSD", Date.parse("2026-11-30T22:00:00Z"))).toBe(true);
  });

  it("closes FX over the weekend and observes its short New York rollover break", () => {
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-28T12:00:00Z"))).toBe(false);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-29T22:04:00Z"))).toBe(false);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-29T22:05:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-30T21:58:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-30T22:00:00Z"))).toBe(false);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-30T22:05:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-12-04T21:58:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-12-04T22:00:00Z"))).toBe(false);
  });

  it("uses the New York timezone so weekly opens follow daylight-saving changes", () => {
    // New York is on EDT on March 15, 2026 (UTC-4).
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-03-15T21:04:00Z"))).toBe(false);
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-03-15T21:05:00Z"))).toBe(true);

    // New York is back on EST on November 29, 2026 (UTC-5).
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-11-29T22:04:00Z"))).toBe(false);
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-11-29T22:05:00Z"))).toBe(true);
  });

  it("applies gold's later weekly open and daily maintenance break", () => {
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-29T23:04:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-29T23:05:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T21:58:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T22:30:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T23:05:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-12-04T22:00:00Z"))).toBe(false);
  });

  it("fails closed for unsupported instruments", () => {
    expect(isMarketSessionOpen("UNKNOWN", Date.parse("2026-11-30T12:00:00Z"))).toBe(false);
  });
});
