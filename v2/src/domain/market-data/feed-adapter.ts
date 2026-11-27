import type { CanonicalQuote } from "./types";

export type FeedStatus = "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "ERROR";

export interface HistoricalCandle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
  /** False only for the in-progress provider bar returned during history bootstrap. */
  readonly closed?: boolean;
}

export interface CandlePersistence {
  loadCandles(instrumentId: string, timeframe: string, providerId: string): Promise<readonly HistoricalCandle[]>;
  saveCandles(instrumentId: string, timeframe: string, providerId: string, candles: readonly HistoricalCandle[]): Promise<void>;
}

export interface FeedCallbacks {
  onQuote(quote: CanonicalQuote): void;
  onStatus(status: FeedStatus, detail?: string): void;
}

export interface FeedConnection {
  close(): void;
}

export interface MarketFeedAdapter {
  readonly providerId: string;
  readonly supportedInstrumentIds: readonly string[];
  connect(instrumentId: string, callbacks: FeedCallbacks): FeedConnection;
  loadCandles?(
    instrumentId: string,
    timeframe: string,
    limit: number,
  ): Promise<readonly HistoricalCandle[]>;
}

export interface OutcomePersistence {
  loadSetups(): Promise<readonly import("../signals/outcome-monitor").SetupOutcome[]>;
  saveSetup(setup: import("../signals/outcome-monitor").SetupOutcome): Promise<void>;
  loadEvents(): Promise<readonly import("../signals/outcome-monitor").OutcomeEvent[]>;
  appendEvent(event: import("../signals/outcome-monitor").OutcomeEvent): Promise<void>;
}
