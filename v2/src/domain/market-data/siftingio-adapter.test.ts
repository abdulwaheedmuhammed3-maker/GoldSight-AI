import { describe, expect, it } from "vitest";
import {
  consumeSiftingIoInitialSnapshot,
  describeSiftingIoRequestError,
  normalizeSiftingIoTick,
  normalizeSiftingIoTopOfBookQuote,
  resolveSiftingIoErrorSymbols,
} from "./siftingio-adapter";

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

describe("SiftingIO supported commodity symbols", () => {
  it("accepts all configured Exness-aligned commodity reference symbols on the com channel", async () => {
    const { COMMODITY_SYMBOLS } = await import("./instrument-catalog");
    const now = 1_800_000_000_100;
    for (const symbol of COMMODITY_SYMBOLS) {
      const quote = normalizeSiftingIoTick({
        f: "tick",
        s: symbol,
        p: "100.25",
        b: "100.20",
        a: "100.30",
        t: 1_800_000_000_000,
      }, now, symbol);
      expect(quote?.instrumentId).toBe(symbol);
      expect(quote?.provider).toBe("SiftingIO Market Data");
      expect(quote?.transport).toBe("WEBSOCKET");
    }
  });

  it("normalizes the single-symbol REST top-of-book for every supported commodity", async () => {
    const { COMMODITY_SYMBOLS } = await import("./instrument-catalog");
    const now = 1_800_000_000_100;
    for (const symbol of COMMODITY_SYMBOLS) {
      const quote = normalizeSiftingIoTopOfBookQuote({
        s: symbol,
        b: "100.20",
        a: "100.30",
        t: 1_800_000_000_000,
      }, now, symbol);
      expect(quote?.instrumentId).toBe(symbol);
      expect(quote?.priceBasis).toBe("mid");
      expect(quote?.price).toBe(100.25);
    }
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


describe("SiftingIO connection-wide subscription capacity", () => {
  it("allocates one shared max_subs allowance across commodities and Forex", async () => {
    const { buildSiftingIoSubscriptionPlan } = await import("./siftingio-adapter");
    const plan = buildSiftingIoSubscriptionPlan(
      ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"],
      5,
    );

    expect(plan.batches).toEqual([
      { product: "com", symbols: ["XAUUSD"] },
      { product: "fx", symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"] },
    ]);
    expect(plan.rejectedSymbols).toEqual(["USDCAD"]);
  });

  it("preserves priority order and rejects every symbol after the shared limit", async () => {
    const { buildSiftingIoSubscriptionPlan } = await import("./siftingio-adapter");
    const plan = buildSiftingIoSubscriptionPlan(
      ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"],
      5,
    );

    expect(plan.batches).toEqual([
      { product: "com", symbols: ["XAUUSD"] },
      { product: "fx", symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"] },
    ]);
    expect(plan.rejectedSymbols).toEqual(["USDCAD", "USDCHF"]);
  });

  it("rejects every priority when the provider reports zero subscriptions", async () => {
    const { buildSiftingIoSubscriptionPlan } = await import("./siftingio-adapter");
    const plan = buildSiftingIoSubscriptionPlan(
      ["XAUUSD", "EURUSD"],
      0,
    );

    expect(plan.batches).toEqual([]);
    expect(plan.rejectedSymbols).toEqual(["XAUUSD", "EURUSD"]);
  });

  it("keeps all selected symbols when the provider does not report a limit", async () => {
    const { buildSiftingIoSubscriptionPlan } = await import("./siftingio-adapter");
    const plan = buildSiftingIoSubscriptionPlan(
      ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"],
      null,
    );

    expect(plan.batches).toEqual([
      { product: "com", symbols: ["XAUUSD"] },
      { product: "fx", symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"] },
    ]);
    expect(plan.rejectedSymbols).toEqual([]);
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

describe("SiftingIO request error diagnostics", () => {
  it("explains fetch failures without claiming whether network or CORS is responsible", () => {
    expect(describeSiftingIoRequestError(new TypeError("Failed to fetch"), "Forex snapshot"))
      .toContain("failed before an HTTP response");
    expect(describeSiftingIoRequestError(new TypeError("Failed to fetch"), "Forex snapshot"))
      .toContain("provider CORS");
  });

  it("preserves explicit provider and HTTP errors", () => {
    expect(describeSiftingIoRequestError(new Error("SiftingIO Forex snapshot returned HTTP 401."), "Forex snapshot"))
      .toBe("SiftingIO Forex snapshot returned HTTP 401.");
  });
});

describe("SiftingIO subscription error attribution", () => {
  const active = ["XAUUSD", "EURUSD", "GBPUSD"];
  const subscribed = new Set(["com:XAUUSD"]);

  it("does not demote an acknowledged commodity when a generic error rejects pending FX", () => {
    expect(resolveSiftingIoErrorSymbols(
      {},
      active,
      subscribed,
    )).toEqual(["EURUSD", "GBPUSD"]);
  });

  it("uses the product supplied in a provider error when available", () => {
    expect(resolveSiftingIoErrorSymbols(
      { product: "com" },
      active,
      subscribed,
    )).toEqual(["XAUUSD"]);
  });

  it("uses explicit symbols supplied in a provider error", () => {
    expect(resolveSiftingIoErrorSymbols(
      { symbols: ["GBPUSD"] },
      active,
      subscribed,
    )).toEqual(["GBPUSD"]);
  });
});
