import { describe, expect, it } from "vitest";
import { consumeSiftingIoInitialSnapshot, normalizeSiftingIoTick, normalizeSiftingIoTopOfBookQuote } from "./siftingio-adapter";

describe("SiftingIO initial subscription snapshot", () => {
  it("classifies exactly the first frame after a subscription as a cached snapshot", () => {
    const pending = new Set(["XAUUSD"]);
    expect(consumeSiftingIoInitialSnapshot("XAUUSD", pending)).toBe(true);
    expect(consumeSiftingIoInitialSnapshot("XAUUSD", pending)).toBe(false);
    expect(pending.has("XAUUSD")).toBe(false);
  });

  it("keeps the following SiftingIO frames classified as live WebSocket ticks", () => {
    const now = 1_800_000_000_100;
    const quote = normalizeSiftingIoTick({
      f: "tick", s: "XAUUSD", p: "4073.45", b: "4073.40", a: "4073.50",
      t: 1_800_000_000_000,
    }, now, "XAUUSD", "WEBSOCKET_SNAPSHOT");
    expect(quote?.transport).toBe("WEBSOCKET_SNAPSHOT");
  });
});

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
    expect(quote?.provider).toBe("SiftingIO Market Data");
    expect(quote?.priceBasis).toBe("last");
    expect(quote?.price).toBe(4_073.45);
    expect(quote?.bid).toBe(4_073.4);
    expect(quote?.ask).toBe(4_073.5);
    expect(quote?.sourceTimeMs).toBe(1_800_000_000_000);
  });

  it("normalizes a supported FX instrument from the shared FX channel", () => {
    const now = 1_800_000_000_100;
    const quote = normalizeSiftingIoTick({
      f: "tick",
      s: "EURUSD",
      p: "1.08425",
      b: "1.08420",
      a: "1.08430",
      t: 1_800_000_000_000,
    }, now, "EURUSD");

    expect(quote?.instrumentId).toBe("EURUSD");
    expect(quote?.provider).toBe("SiftingIO Market Data");
    expect(quote?.price).toBe(1.08425);
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


describe("SiftingIO per-market subscription capacity", () => {
  it("allows five Forex symbols and five Commodities symbols independently", async () => {
    const { buildSiftingIoSubscriptionPlan } = await import("./siftingio-adapter");
    const plan = buildSiftingIoSubscriptionPlan(
      ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"],
      5,
    );

    expect(plan.batches).toEqual([
      { product: "com", symbols: ["XAUUSD"] },
      { product: "fx", symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"] },
    ]);
    expect(plan.rejectedSymbols).toEqual([]);
  });

  it("rejects only symbols beyond the limit within their own market", async () => {
    const { buildSiftingIoSubscriptionPlan } = await import("./siftingio-adapter");
    const plan = buildSiftingIoSubscriptionPlan(
      ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"],
      5,
    );

    expect(plan.batches).toEqual([
      { product: "com", symbols: ["XAUUSD"] },
      { product: "fx", symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"] },
    ]);
    expect(plan.rejectedSymbols).toEqual(["USDCHF"]);
  });
});


describe("SiftingIO REST quote snapshots", () => {
  it("normalizes an unstreamed FX pair from the batched snapshot schema", () => {
    const now = 1_800_000_000_100;
    const quote = normalizeSiftingIoTick({
      f: "tick",
      s: "USDCHF",
      p: "0.81245",
      b: "0.81240",
      a: "0.81250",
      t: 1_800_000_000_000,
    }, now, "USDCHF", "REST_SNAPSHOT");

    expect(quote?.provider).toBe("SiftingIO Market Data");
    expect(quote?.transport).toBe("REST_SNAPSHOT");
    expect(quote?.instrumentId).toBe("USDCHF");
    expect(quote?.price).toBe(0.81245);
    expect(quote?.priceBasis).toBe("last");
  });

  it("uses the actual bid/ask midpoint for an unstreamed commodity quote", () => {
    const now = 1_800_000_000_100;
    const quote = normalizeSiftingIoTopOfBookQuote({
      s: "XAUUSD",
      b: "4073.40",
      a: "4073.50",
      t: 1_800_000_000_000,
    }, now, "XAUUSD");

    expect(quote?.provider).toBe("SiftingIO Market Data");
    expect(quote?.priceBasis).toBe("mid");
    expect(quote?.price).toBe(4073.45);
    expect(quote?.bid).toBe(4073.40);
    expect(quote?.ask).toBe(4073.50);
    expect(quote?.last).toBeNull();
  });

  it("rejects stale, crossed and mismatched top-of-book snapshots", () => {
    const now = 1_800_000_000_100;
    const valid = { s: "XAUUSD", b: "4073.40", a: "4073.50", t: 1_800_000_000_000 };

    expect(normalizeSiftingIoTopOfBookQuote({ ...valid, s: "EURUSD" }, now, "XAUUSD")).toBeNull();
    expect(normalizeSiftingIoTopOfBookQuote({ ...valid, a: "4073.30" }, now, "XAUUSD")).toBeNull();
    expect(normalizeSiftingIoTopOfBookQuote({ ...valid, t: now - 31_000 }, now, "XAUUSD")).toBeNull();
  });
});
