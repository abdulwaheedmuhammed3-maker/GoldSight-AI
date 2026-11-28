import { describe, expect, it } from "vitest";
import { getMarketSessionStatus } from "./market-session";

describe("timezone-aware instrument market sessions", () => {
  it("keeps BTC open through the weekend", () => {
    const status = getMarketSessionStatus("BTCUSD", Date.parse("2026-11-28T05:50:00Z"));
    expect(status.isOpen).toBe(true);
    expect(status.kind).toBe("CRYPTO_24_7");
  });

  it("closes Forex over the weekend and reopens Sunday at 5 PM New York time", () => {
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-28T05:50:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-29T21:59:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-29T22:00:00Z")).isOpen).toBe(true);
  });

  it("uses the separate spot-gold Sunday open and daily maintenance break", () => {
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-29T22:59:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-29T23:00:00Z")).isOpen).toBe(true);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-26T22:00:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-26T23:00:00Z")).isOpen).toBe(true);
  });

  it("handles New York daylight-saving changes without fixed UTC offsets", () => {
    // During US summer time, 5 PM New York is 21:00 UTC.
    expect(getMarketSessionStatus("EURUSD", Date.parse("2027-03-14T20:59:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2027-03-14T21:00:00Z")).isOpen).toBe(true);
  });

  it("fails closed when an instrument has no configured market schedule", () => {
    const status = getMarketSessionStatus("UNKNOWN", Date.parse("2026-11-27T15:00:00Z"));
    expect(status.isOpen).toBe(false);
    expect(status.kind).toBe("UNCONFIGURED");
  });
});
