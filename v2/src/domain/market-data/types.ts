export type PriceBasis = "last" | "bid" | "mid" | "mark";
export type QuoteFreshness = "LIVE" | "STALE" | "OFFLINE" | "WAITING";

export interface CanonicalQuote {
  readonly instrumentId: string;
  readonly provider: string;
  readonly providerSymbol: string;
  readonly priceBasis: PriceBasis;
  /** The one price displayed by the watchlist, instrument header and chart marker. */
  readonly price: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly sourceTimeMs: number;
  readonly receivedTimeMs: number;
  /** Monotonic provider sequence when the source exposes one. */
  readonly sequence: number | null;
  readonly digits: number;
}

export interface QuotePersistence {
  loadAll(): Promise<readonly CanonicalQuote[]>;
  save(quote: CanonicalQuote): Promise<void>;
}

export interface InstrumentQuoteState {
  readonly instrumentId: string;
  readonly quote: CanonicalQuote | null;
  readonly freshness: QuoteFreshness;
  readonly connected: boolean;
  readonly refreshing: boolean;
  readonly version: number;
  readonly lastError: string | null;
  readonly persistenceError: string | null;
  readonly activeProvider: string | null;
  readonly quoteAgeMs: number | null;
}

export interface QuoteStoreOptions {
  /** Per-instrument/provider freshness limits are injected by instrument config. */
  readonly maxAgeMs: (instrumentId: string, provider: string) => number;
  readonly now?: () => number;
  readonly persistence?: QuotePersistence;
  readonly maxFutureSkewMs?: number;
}
