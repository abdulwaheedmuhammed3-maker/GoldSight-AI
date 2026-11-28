import { describe, expect, it } from "vitest";
import { getMarketSessionStatus, isMarketSessionOpen } from "./market-session";

describe("TradeSight market sessions", () => {
  it("keeps BTCUSD open 24/7, including weekends and rollover hours", () => {
    expect(isMarketSessionOpen("BTCUSD", Date.parse("2026-11-28T12:00:00Z"))).toBe(true);
    expect(isMarketSessionOpen("BTCUSD", Date.parse("2026-11-30T22:00:00Z"))).toBe(true);
  });

  it("uses SiftingIO's Sunday 21:00 UTC to Friday 21:00 UTC Forex schedule", () => {
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-28T12:00:00Z"))).toBe(false);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-29T20:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-29T21:00:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-11-30T22:30:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-12-04T20:59:00Z"))).toBe(true);
    expect(isMarketSessionOpen("EURUSD", Date.parse("2026-12-04T21:00:00Z"))).toBe(false);
  });

  it("keeps Forex weekly boundaries in UTC across US daylight-saving changes", () => {
    // New York is on EDT on March 15, 2026, but SiftingIO's Forex anchor remains 21:00 UTC.
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-03-15T20:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-03-15T21:00:00Z"))).toBe(true);
    // New York is back on EST on November 29, 2026; Forex anchor is still 21:00 UTC.
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-11-29T20:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("GBPUSD", Date.parse("2026-11-29T21:00:00Z"))).toBe(true);
  });

  it("applies the spot-gold weekday maintenance break and weekly closure", () => {
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-29T22:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-29T23:00:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T21:59:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T22:00:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T22:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-30T23:00:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-12-04T21:59:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-12-04T22:00:00Z"))).toBe(false);
  });

  it("uses New York daylight-saving time for gold's reference schedule", () => {
    // New York changes from EST to EDT; 18:00 local therefore maps to 23:00Z then 22:00Z.
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-03-15T21:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-03-15T22:00:00Z"))).toBe(true);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-29T22:59:00Z"))).toBe(false);
    expect(isMarketSessionOpen("XAUUSD", Date.parse("2026-11-29T23:00:00Z"))).toBe(true);
  });

  it("fails closed for unknown instruments and invalid timestamps", () => {
    const unknown = getMarketSessionStatus("UNKNOWN", Date.parse("2026-11-30T12:00:00Z"));
    expect(unknown.isOpen).toBe(false);
    expect(unknown.kind).toBe("UNCONFIGURED");
    expect(isMarketSessionOpen("EURUSD", Number.NaN)).toBe(false);
  });
});
