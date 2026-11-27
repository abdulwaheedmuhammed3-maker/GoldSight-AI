import { describe, expect, it } from "vitest";
import type { HistoricalCandle } from "../market-data/feed-adapter";
import { analyzeStructure } from "./structure-analysis";

function candles(direction: 1 | -1 = 1, breakout = true): HistoricalCandle[] {
  const pattern = [0, 3, 6, 2, 4, 7];
  const count = 72;
  const bars = Array.from({ length: count }, (_, index) => {
    const close = 100 + direction * (Math.floor(index / 6) * 4 + pattern[index % 6]);
    const open = close - direction * 0.2;
    return {
      time: index * 300,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.3,
      close,
      closed: true,
    };
  });

  const initial = analyzeStructure(bars);
  const last = bars[bars.length - 1];
  const target = breakout
    ? (direction === 1 ? (initial.swingHigh?.price ?? last.close) + 1 : (initial.swingLow?.price ?? last.close) - 1)
    : ((initial.swingHigh?.price ?? last.close) + (initial.swingLow?.price ?? last.close)) / 2;
  const open = target - direction * 0.3;
  bars[bars.length - 1] = {
    ...last,
    open,
    high: Math.max(open, target) + 0.2,
    low: Math.min(open, target) - 0.3,
    close: target,
  };
  return bars;
}

describe("confirmed market structure analysis", () => {
  it("identifies bullish structure from higher highs and higher lows", () => {
    const result = analyzeStructure(candles(1));
    expect(result.trend).toBe("BULLISH");
    expect(result.breakSide).toBe("BUY");
    expect(result.breakType).toBe("BOS");
  });

  it("identifies bearish structure from lower highs and lower lows", () => {
    const result = analyzeStructure(candles(-1));
    expect(result.trend).toBe("BEARISH");
    expect(result.breakSide).toBe("SELL");
    expect(result.breakType).toBe("BOS");
  });

  it("labels a break against the prior structure trend as CHoCH", () => {
    const downtrend = candles(-1, false);
    const structure = analyzeStructure(downtrend);
    const last = downtrend[downtrend.length - 1];
    const close = structure.swingHigh!.price + 1;
    downtrend[downtrend.length - 1] = {
      ...last,
      open: close - 0.2,
      high: close + 0.2,
      low: close - 0.3,
      close,
    };

    const result = analyzeStructure(downtrend);
    expect(result.trend).toBe("BEARISH");
    expect(result.breakSide).toBe("BUY");
    expect(result.breakType).toBe("CHoCH");
  });

  it("recognises a sell-side liquidity sweep and reclaim", () => {
    const base = candles(1, false);
    const structure = analyzeStructure(base);
    const last = base[base.length - 1];
    const close = (structure.swingHigh!.price + structure.swingLow!.price) / 2;
    base[base.length - 1] = {
      ...last,
      open: close + 0.2,
      high: close + 0.4,
      low: structure.swingLow!.price - 0.5,
      close,
    };

    expect(analyzeStructure(base).sweepSide).toBe("BUY");
  });

  it("rejects a candle that sweeps both sides of the confirmed range as ambiguous", () => {
    const bars = candles(1, false);
    const structure = analyzeStructure(bars);
    const last = bars[bars.length - 1];
    const close = (structure.swingHigh!.price + structure.swingLow!.price) / 2;
    bars[bars.length - 1] = {
      ...last,
      open: close,
      high: structure.swingHigh!.price + 0.5,
      low: structure.swingLow!.price - 0.5,
      close,
    };

    const result = analyzeStructure(bars);
    expect(result.breakSide).toBeNull();
    expect(result.sweepSide).toBeNull();
  });

  it("never treats the decision candle as a confirmed swing pivot", () => {
    const bars = candles(1);
    const result = analyzeStructure(bars);
    expect(result.swingHigh).not.toBeNull();
    expect(result.swingHigh!.index).toBeLessThan(bars.length - 1);
  });

  it("does not report a break while the decision candle remains inside confirmed swings", () => {
    const bars = candles(1, false);
    const structure = analyzeStructure(bars);
    const last = bars[bars.length - 1];
    const close = (structure.swingHigh!.price + structure.swingLow!.price) / 2;
    bars[bars.length - 1] = { ...last, open: close, high: close + 0.1, low: close - 0.1, close };
    expect(analyzeStructure(bars).breakSide).toBeNull();
  });
});
