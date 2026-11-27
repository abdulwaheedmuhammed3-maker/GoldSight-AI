import { useEffect, useState } from "react";
import type { HistoricalCandle } from "../domain/market-data/feed-adapter";
import type { InstrumentMarketState, SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { marketEngine, quoteStore } from "../domain/market-data/runtime";
import type { InstrumentQuoteState } from "../domain/market-data/types";

export function useInstrumentMarketState(instrumentId: string): InstrumentMarketState {
  const [state, setState] = useState<InstrumentMarketState>(() => marketEngine.getState(instrumentId));
  useEffect(() => marketEngine.subscribe(instrumentId, setState), [instrumentId]);
  return state;
}

export function useCanonicalQuote(instrumentId: string): InstrumentQuoteState {
  const [state, setState] = useState<InstrumentQuoteState>(() => quoteStore.getSnapshot(instrumentId));
  useEffect(() => quoteStore.subscribe(instrumentId, setState), [instrumentId]);
  return state;
}

export function useCandles(
  instrumentId: string,
  timeframe: SupportedTimeframe,
): readonly HistoricalCandle[] {
  const [candles, setCandles] = useState<readonly HistoricalCandle[]>(
    () => marketEngine.getCandles(instrumentId, timeframe),
  );

  useEffect(() => {
    const refresh = () => setCandles(marketEngine.getCandles(instrumentId, timeframe));
    const unsubscribe = marketEngine.subscribeCandles(instrumentId, timeframe, refresh);
    refresh();
    return unsubscribe;
  }, [instrumentId, timeframe]);

  return candles;
}
