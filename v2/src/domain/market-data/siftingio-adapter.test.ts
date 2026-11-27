import { describe, expect, it } from "vitest";
import { normalizeSiftingIoTick } from "./siftingio-adapter";

describe("SiftingIO XAUUSD tick normalization", () => {
  it("normalizes one valid timestamped Gold tick to a canonical quote", () => {
    const now = 1_800_000_000_100;
    const quote = normalizeSiftingIoTick({
      f: "tick",
      s: "XAUUSD",
      p: "4073.45",
      b: "4073.40",
      a: "4073.50",
      t: 1_800_000_000_000,
    }, now);

    expect(quote).not.toBeNull();
    expect(quote?.instrumentId).toBe("XAUUSD");
    expect(quote?.provider).toBe("SiftingIO WebSocket");
    expect(quote?.priceBasis).toBe("last");
    expect(quote?.price).toBe(4_073.45);
    expect(quote?.bid).toBe(4_073.4);
    expect(quote?.ask).toBe(4_073.5);
    expect(quote?.sourceTimeMs).toBe(1_800_000_000_000);
  });

  it("rejects malformed, stale, future-dated and wrong-symbol ticks", () => {
    const now = 1_800_000_000_100;
    const valid = {
      f: "tick",
      s: "XAUUSD",
      p: "4073.45",
      b: "4073.40",
      a: "4073.50",
      t: 1_800_000_000_000,
    };

    expect(normalizeSiftingIoTick({ ...valid, s: "BTCUSD" }, now)).toBeNull();
    expect(normalizeSiftingIoTick({ ...valid, a: "4073.30" }, now)).toBeNull();
    expect(normalizeSiftingIoTick({ ...valid, t: now - 31_000 }, now)).toBeNull();
    expect(normalizeSiftingIoTick({ ...valid, t: now + 10_000 }, now)).toBeNull();
  });
});
