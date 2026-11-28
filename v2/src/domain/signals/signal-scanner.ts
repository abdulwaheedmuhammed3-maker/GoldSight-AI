import type { MarketDataEngine } from "../market-data/market-data-engine";
import type { QuoteStore } from "../market-data/quote-store";
import type { CanonicalQuote } from "../market-data/types";
import { isSnapshotQuote } from "../market-data/types";
import { getMarketSessionStatus } from "../market-data/market-session";
import type { OutcomeMonitor } from "./outcome-monitor";
import {
  analyzeTradingSignal,
  SIGNAL_TIMEFRAMES,
  type SignalEngineInput,
  type SignalEngineResult,
  type SignalRejectionCode,
  type SignalTimeframe,
} from "./signal-engine";

export interface SignalTimeframeScan {
  readonly timeframe: SignalTimeframe;
  readonly status: "SIGNAL" | "NO_SETUP";
  readonly signalId: string | null;
  readonly rejectionCodes: readonly SignalRejectionCode[];
}

export interface SignalScanRecord {
  readonly instrumentId: string;
  readonly scannedAt: number;
  readonly quoteTimeMs: number;
  readonly provider: string;
  readonly freshness: string;
  readonly status: "SIGNAL" | "NO_SETUP" | "MARKET_CLOSED" | "WAITING_FOR_TICK";
  readonly signalId: string | null;
  readonly signalIds: readonly string[];
  readonly timeframeResults: readonly SignalTimeframeScan[];
  readonly rejectionCodes: readonly SignalRejectionCode[];
  readonly scanCount: number;
  readonly generatedCount: number;
  readonly sessionDetail: string | null;
}

export interface SignalScannerSnapshot {
  readonly records: readonly SignalScanRecord[];
  readonly totalScans: number;
  readonly totalSignals: number;
}

type ScannerListener = (snapshot: SignalScannerSnapshot) => void;
type SignalAnalyzer = (input: SignalEngineInput) => SignalEngineResult;

const SCANNED_INSTRUMENTS: readonly { instrumentId: string; provider: string }[] = [
  { instrumentId: "BTCUSD", provider: "Binance Spot" },
  { instrumentId: "XAUUSD", provider: "SiftingIO Market Data" },
  { instrumentId: "EURUSD", provider: "SiftingIO Market Data" },
  { instrumentId: "GBPUSD", provider: "SiftingIO Market Data" },
  { instrumentId: "USDJPY", provider: "SiftingIO Market Data" },
  { instrumentId: "AUDUSD", provider: "SiftingIO Market Data" },
  { instrumentId: "USDCAD", provider: "SiftingIO Market Data" },
  { instrumentId: "USDCHF", provider: "SiftingIO Market Data" },
  { instrumentId: "NZDUSD", provider: "SiftingIO Market Data" },
  { instrumentId: "EURGBP", provider: "SiftingIO Market Data" },
];

export class SignalScanner {
  private readonly records = new Map<string, SignalScanRecord>();
  private readonly listeners = new Set<ScannerListener>();
  private removeQuoteObserver: (() => void) | null = null;
  private sessionCheckTimer: ReturnType<typeof setInterval> | null = null;
  private totalScans = 0;
  private totalSignals = 0;

  constructor(
    private readonly market: MarketDataEngine,
    private readonly quotes: QuoteStore,
    private readonly outcomes: OutcomeMonitor,
    private readonly now: () => number = Date.now,
    private readonly analyze: SignalAnalyzer = analyzeTradingSignal,
  ) {}

  start(): void {
    if (this.removeQuoteObserver) return;
    this.refreshMarketSessions();
    this.sessionCheckTimer = setInterval(() => this.refreshMarketSessions(), 15_000);
    this.removeQuoteObserver = this.market.addQuoteObserver((quote) => {
      // Provider snapshots keep the watchlist populated, but are not
      // suitable for tick-driven signal generation or trade outcome monitoring.
      if (isSnapshotQuote(quote)) return;
      this.scanQuote(quote);
    });
  }

  stop(): void {
    this.removeQuoteObserver?.();
    this.removeQuoteObserver = null;
    if (this.sessionCheckTimer !== null) clearInterval(this.sessionCheckTimer);
    this.sessionCheckTimer = null;
  }

  /** Keep closed/open labels current even when a provider stops sending ticks. */
  private refreshMarketSessions(): void {
    const checkedAt = this.now();
    for (const instrument of SCANNED_INSTRUMENTS) {
      const session = getMarketSessionStatus(instrument.instrumentId, checkedAt);
      const previous = this.records.get(instrument.instrumentId);
      if (session.isOpen && previous && previous.status !== "MARKET_CLOSED") continue;

      const status = session.isOpen ? "WAITING_FOR_TICK" : "MARKET_CLOSED";
      const detail = session.isOpen
        ? "Market session is open. Waiting for the next fresh live tick."
        : session.detail;
      if (previous?.status === status && previous.sessionDetail === detail) continue;

      this.records.set(instrument.instrumentId, Object.freeze({
        instrumentId: instrument.instrumentId,
        scannedAt: checkedAt,
        quoteTimeMs: previous?.quoteTimeMs ?? 0,
        provider: previous?.provider ?? instrument.provider,
        freshness: previous?.freshness ?? "WAITING",
        status,
        signalId: null,
        signalIds: [],
        timeframeResults: [],
        rejectionCodes: [],
        scanCount: previous?.scanCount ?? 0,
        generatedCount: previous?.generatedCount ?? 0,
        sessionDetail: detail,
      }));
    }
    this.publish();
  }

  subscribe(listener: ScannerListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SignalScannerSnapshot {
    return {
      records: [...this.records.values()].sort((a, b) => b.scannedAt - a.scannedAt),
      totalScans: this.totalScans,
      totalSignals: this.totalSignals,
    };
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  scanQuote(quote: CanonicalQuote): SignalScanRecord {
    const scannedAt = this.now();
    const quoteState = this.quotes.getSnapshot(quote.instrumentId);
    const previous = this.records.get(quote.instrumentId);
    const session = getMarketSessionStatus(quote.instrumentId, scannedAt);

    if (!session.isOpen) {
      const record: SignalScanRecord = Object.freeze({
        instrumentId: quote.instrumentId,
        scannedAt,
        quoteTimeMs: quote.sourceTimeMs,
        provider: quote.provider,
        freshness: quoteState.freshness,
        status: "MARKET_CLOSED",
        signalId: null,
        signalIds: [],
        timeframeResults: [],
        rejectionCodes: [],
        scanCount: previous?.scanCount ?? 0,
        generatedCount: previous?.generatedCount ?? 0,
        sessionDetail: session.detail,
      });
      this.records.set(quote.instrumentId, record);
      this.publish();
      return record;
    }

    const candles = {
      "4h": this.market.getCandles(quote.instrumentId, "4h", quote.provider),
      "1h": this.market.getCandles(quote.instrumentId, "1h", quote.provider),
      "15m": this.market.getCandles(quote.instrumentId, "15m", quote.provider),
      "5m": this.market.getCandles(quote.instrumentId, "5m", quote.provider),
    };

    const baseInput: SignalEngineInput = {
      instrumentId: quote.instrumentId,
      quoteState,
      candles,
      candleProvider: quote.provider,
      candlePriceBasis: quote.priceBasis,
      nowMs: scannedAt,
    };

    const results = SIGNAL_TIMEFRAMES.map((timeframe) => ({
      timeframe,
      result: this.analyze({ ...baseInput, targetTimeframe: timeframe }),
    }));

    const signalIds: string[] = [];
    let generatedNow = 0;

    for (const { result } of results) {
      if (!result.signal) continue;
      signalIds.push(result.signal.id);
      if (this.outcomes.register(result.signal)) {
        generatedNow += 1;
        this.totalSignals += 1;
      }
    }

    this.totalScans += 1;
    const timeframeResults: SignalTimeframeScan[] = results.map(({ timeframe, result }) => ({
      timeframe,
      status: result.status,
      signalId: result.signal?.id ?? null,
      rejectionCodes: result.diagnostics.rejectionCodes,
    }));
    const rejectionCodes = [...new Set(timeframeResults.flatMap((item) => item.rejectionCodes))];

    const record: SignalScanRecord = Object.freeze({
      instrumentId: quote.instrumentId,
      scannedAt,
      quoteTimeMs: quote.sourceTimeMs,
      provider: quote.provider,
      freshness: quoteState.freshness,
      status: signalIds.length > 0 ? "SIGNAL" : "NO_SETUP",
      signalId: signalIds[0] ?? null,
      signalIds,
      timeframeResults,
      rejectionCodes,
      scanCount: (previous?.scanCount ?? 0) + 1,
      generatedCount: (previous?.generatedCount ?? 0) + generatedNow,
      sessionDetail: null,
    });
    this.records.set(quote.instrumentId, record);
    this.publish();
    return record;
  }
}
