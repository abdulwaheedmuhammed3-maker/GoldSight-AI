import { describe, expect, it } from "vitest";
import { createTradeJournalRecord } from "./trade-journal";

const base = {
  instrumentId: "XAUUSD",
  side: "BUY" as const,
  timeframe: "15m" as const,
  entryPrice: 2_650,
  exitPrice: 2_670,
  stopLoss: 2_640,
  openedAtMs: 1_800_000_000_000,
  closedAtMs: 1_800_000_060_000,
  notes: "London session sweep",
};

describe("trade journal calculations", () => {
  it("calculates a BUY result in R without guessing contract value", () => {
    const trade = createTradeJournalRecord(base, { id: "buy-win", nowMs: 1_800_000_100_000 });
    expect(trade.riskDistance).toBe(10);
    expect(trade.resultR).toBe(2);
    expect(trade.outcome).toBe("WIN");
    expect(trade.instrumentId).toBe("XAUUSD");
  });

  it("calculates a SELL result in R", () => {
    const trade = createTradeJournalRecord({
      ...base,
      side: "SELL",
      entryPrice: 2_650,
      exitPrice: 2_630,
      stopLoss: 2_660,
    });
    expect(trade.resultR).toBe(2);
    expect(trade.outcome).toBe("WIN");
  });

  it("records a losing BUY as negative R", () => {
    const trade = createTradeJournalRecord({ ...base, exitPrice: 2_635 });
    expect(trade.resultR).toBe(-1.5);
    expect(trade.outcome).toBe("LOSS");
  });

  it("recognises breakeven", () => {
    const trade = createTradeJournalRecord({ ...base, exitPrice: base.entryPrice });
    expect(trade.resultR).toBe(0);
    expect(trade.outcome).toBe("BREAKEVEN");
  });

  it("rejects a BUY stop on the wrong side", () => {
    expect(() => createTradeJournalRecord({ ...base, stopLoss: 2_660 })).toThrow(/BUY/);
  });

  it("rejects a SELL stop on the wrong side", () => {
    expect(() => createTradeJournalRecord({
      ...base,
      side: "SELL",
      stopLoss: 2_640,
    })).toThrow(/SELL/);
  });

  it("rejects a close time before the open time", () => {
    expect(() => createTradeJournalRecord({ ...base, closedAtMs: base.openedAtMs - 1 }))
      .toThrow(/close time/);
  });
});
