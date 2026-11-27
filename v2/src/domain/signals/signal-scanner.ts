import type { MarketDataEngine, SupportedTimeframe } from "../market-data/market-data-engine";
import type { QuoteStore, } from "../market-data/quote-store";
import type { CanonicalQuote } from "../market-data/types";
import type { OutcomeMonitor } from "./outcome-monitor";
import { analyzeTradingSignal, type SignalRejectionCode, type TradingSignal } from "./signal-engine";

const TIMEFRAMES: readonly SupportedTimeframe[] = ["4h", "1h", "15m", "5m"];

export interface SignalScanRecord {
  readonly instrumentId: string;
  readonly scannedAt: number;
  readonly quoteTimeMs: number;
  readonly provider: string;
  readonly freshness: string;
  readonly status: "SIGNAL" | "NO_SETUP";
  readonly signalId: string | null;
  readonly rejectionCodes: readonly SignalRejectionCode[];
  readonly scanCount: number;
  readonly generatedCount: number;
}

export interface SignalScannerSnapshot {
  readonly records: readonly SignalScanRecord[];
  readonly totalScans: number;
  readonly totalSignals: number;
}

type ScannerListener = (snapshot: SignalScannerSnapshot) => void;

export class SignalScanner {
  private readonly records = new Map<string, SignalScanRecord>();
  private readonly listeners = new Set<ScannerListener>();
  private removeQuoteObserver: (() => void) | null = null;
  private totalScans = 0;
  private totalSignals = 0;

  constructor(
    private readonly market: MarketDataEngine,
    private readonly quotes: QuoteStore,
    private readonly outcomes: OutcomeMonitor,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.removeQuoteObserver) return;
    this.removeQuoteObserver = this.market.addQuoteObserver((quote) => this.scanQuote(quote));
  }

  stop(): void {
    this.removeQuoteObserver?.();
    this.removeQuoteObserver = null;
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
    const candles = {
      "4h": this.market.getCandles(quote.instrumentId, "4h", quote.provider),
      "1h": this.market.getCandles(quote.instrumentId, "1h", quote.provider),
      "15m": this.market.getCandles(quote.instrumentId, "15m", quote.provider),
      "5m": this.market.getCandles(quote.instrumentId, "5m", quote.provider),
    };

    const result = analyzeTradingSignal({
      instrumentId: quote.instrumentId,
      quoteState,
      candles,
      candleProvider: quote.provider,
      candlePriceBasis: quote.priceBasis,
      nowMs: scannedAt,
    });

    const previous = this.records.get(quote.instrumentId);
    const signalRegistered = result.signal ? this.outcomes.register(result.signal) : false;
    this.totalScans += 1;
    if (signalRegistered) this.totalSignals += 1;

    const record: SignalScanRecord = Object.freeze({
      instrumentId: quote.instrumentId,
      scannedAt,
      quoteTimeMs: quote.sourceTimeMs,
      provider: quote.provider,
      freshness: quoteState.freshness,
      status: result.status,
      signalId: result.signal?.id ?? null,
      rejectionCodes: result.diagnostics.rejectionCodes,
      scanCount: (previous?.scanCount ?? 0) + 1,
      generatedCount: (previous?.generatedCount ?? 0) + (signalRegistered ? 1 : 0),
    });
    this.records.set(quote.instrumentId, record);
    this.publish();
    return record;
  }
}
