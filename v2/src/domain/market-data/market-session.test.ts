import { describe, expect, it } from "vitest";
import { getMarketSessionStatus } from "./market-session";

describe("timezone-aware instrument market sessions", () => {
  it("keeps BTC open through the weekend", () => {
    const status = getMarketSessionStatus("BTCUSD", Date.parse("2026-11-28T05:50:00Z"));
    expect(status.isOpen).toBe(true);
    expect(status.kind).toBe("CRYPTO_24_7");
  });

  it("uses SiftingIO's published Sunday 21:00 UTC to Friday 21:00 UTC FX session", () => {
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-28T05:50:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-29T20:59:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-29T21:00:00Z")).isOpen).toBe(true);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-27T20:59:00Z")).isOpen).toBe(true);
    expect(getMarketSessionStatus("EURUSD", Date.parse("2026-11-27T21:00:00Z")).isOpen).toBe(false);
  });

  it("uses the separate spot-gold Sunday open and daily maintenance break", () => {
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-29T22:59:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-29T23:00:00Z")).isOpen).toBe(true);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-26T22:00:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2026-11-26T23:00:00Z")).isOpen).toBe(true);
  });

  it("handles New York daylight-saving changes for spot-gold hours", () => {
    // During US summer time, the gold reopen at 6 PM New York is 22:00 UTC.
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2027-03-14T21:59:00Z")).isOpen).toBe(false);
    expect(getMarketSessionStatus("XAUUSD", Date.parse("2027-03-14T22:00:00Z")).isOpen).toBe(true);
  });

  it("fails closed when an instrument has no configured market schedule", () => {
    const status = getMarketSessionStatus("UNKNOWN", Date.parse("2026-11-27T15:00:00Z"));
    expect(status.isOpen).toBe(false);
    expect(status.kind).toBe("UNCONFIGURED");
  });
});
