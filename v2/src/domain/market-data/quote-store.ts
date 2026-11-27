import type {
  CanonicalQuote,
  InstrumentQuoteState,
  QuoteFreshness,
  QuotePersistence,
  QuoteStoreOptions,
} from "./types";

type Listener = (state: InstrumentQuoteState) => void;

const EMPTY_STATE = (instrumentId: string): InstrumentQuoteState => ({
  instrumentId,
  quote: null,
  freshness: "WAITING",
  connected: false,
  refreshing: false,
  version: 0,
  lastError: null,
  persistenceError: null,
  activeProvider: null,
  quoteAgeMs: null,
});

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validQuoteShape(quote: CanonicalQuote, now: number, maxFutureSkewMs: number): boolean {
  if (!quote.instrumentId.trim() || !quote.provider.trim() || !quote.providerSymbol.trim()) return false;
  if (!isFinitePositive(quote.price)) return false;
  if (!Number.isFinite(quote.sourceTimeMs) || quote.sourceTimeMs <= 0) return false;
  if (!Number.isFinite(quote.receivedTimeMs) || quote.receivedTimeMs <= 0) return false;
  if (quote.receivedTimeMs > now + maxFutureSkewMs) return false;
  if (quote.sourceTimeMs > quote.receivedTimeMs + maxFutureSkewMs) return false;
  if (!Number.isInteger(quote.digits) || quote.digits < 0 || quote.digits > 12) return false;

  if (quote.bid !== null && !isFinitePositive(quote.bid)) return false;
  if (quote.ask !== null && !isFinitePositive(quote.ask)) return false;
  if (quote.last !== null && !isFinitePositive(quote.last)) return false;
  if (quote.bid !== null && quote.ask !== null && quote.ask < quote.bid) return false;

  if (quote.priceBasis === "bid" && quote.bid !== quote.price) return false;
  if (quote.priceBasis === "last" && quote.last !== quote.price) return false;
  if (quote.priceBasis === "mid") {
    if (quote.bid === null || quote.ask === null) return false;
    const midpoint = (quote.bid + quote.ask) / 2;
    const tolerance = Math.max(Number.EPSILON * Math.abs(midpoint) * 8, 1e-10);
    if (Math.abs(midpoint - quote.price) > tolerance) return false;
  }
  if (quote.sequence !== null && (!Number.isSafeInteger(quote.sequence) || quote.sequence < 0)) return false;
  return true;
}

function isNewer(next: CanonicalQuote, previous: CanonicalQuote): boolean {
  if (next.provider !== previous.provider) return false;
  if (next.sourceTimeMs < previous.sourceTimeMs) return false;
  if (next.sourceTimeMs === previous.sourceTimeMs) {
    if (next.sequence !== null && previous.sequence !== null) {
      return next.sequence > previous.sequence;
    }
    // Without provider sequence semantics, equal-millisecond ticks are accepted
    // in adapter arrival order. Adapters should supply sequence whenever possible.
    return true;
  }
  return true;
}

/**
 * Shared per-instrument quote store.
 *
 * beginRefresh/failRefresh never clear the last valid quote. All UI surfaces
 * subscribe here instead of making independent quote requests.
 */
export class QuoteStore {
  private readonly states = new Map<string, InstrumentQuoteState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly maxAgeMs: QuoteStoreOptions["maxAgeMs"];
  private readonly persistence?: QuotePersistence;
  private readonly maxFutureSkewMs: number;

  constructor(options: QuoteStoreOptions) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs;
    this.persistence = options.persistence;
    this.maxFutureSkewMs = options.maxFutureSkewMs ?? 5_000;
  }

  getSnapshot(instrumentId: string): InstrumentQuoteState {
    const base = this.states.get(instrumentId) ?? EMPTY_STATE(instrumentId);
    const quote = base.quote;
    if (!quote) return { ...base, freshness: "WAITING", quoteAgeMs: null };

    const age = Math.max(0, this.now() - quote.sourceTimeMs);
    const threshold = Math.max(0, this.maxAgeMs(instrumentId, quote.provider));
    let freshness: QuoteFreshness;

    if (base.activeProvider && quote.provider !== base.activeProvider) {
      freshness = "STALE";
    } else if (!base.connected) {
      freshness = "OFFLINE";
    } else if (age > threshold) {
      freshness = "STALE";
    } else {
      freshness = "LIVE";
    }
    return { ...base, freshness, quoteAgeMs: age };
  }

  subscribe(instrumentId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(instrumentId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(instrumentId, listeners);
    listener(this.getSnapshot(instrumentId));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(instrumentId);
    };
  }

  private publish(instrumentId: string): void {
    const state = this.getSnapshot(instrumentId);
    for (const listener of this.listeners.get(instrumentId) ?? []) listener(state);
  }

  setActiveProvider(instrumentId: string, provider: string): void {
    const current = this.states.get(instrumentId) ?? EMPTY_STATE(instrumentId);
    this.states.set(instrumentId, {
      ...current,
      activeProvider: provider,
      connected: false,
      refreshing: true,
      lastError: null,
    });
    this.publish(instrumentId);
  }

  setConnection(instrumentId: string, connected: boolean): void {
    const current = this.states.get(instrumentId) ?? EMPTY_STATE(instrumentId);
    this.states.set(instrumentId, { ...current, connected });
    this.publish(instrumentId);
  }

  beginRefresh(instrumentId: string): void {
    const current = this.states.get(instrumentId) ?? EMPTY_STATE(instrumentId);
    this.states.set(instrumentId, { ...current, refreshing: true, lastError: null });
    this.publish(instrumentId);
  }

  failRefresh(instrumentId: string, message: string): void {
    const current = this.states.get(instrumentId) ?? EMPTY_STATE(instrumentId);
    this.states.set(instrumentId, {
      ...current,
      connected: false,
      refreshing: false,
      lastError: message,
    });
    this.publish(instrumentId);
  }

  ingest(quote: CanonicalQuote): boolean {
    const now = this.now();
    if (!validQuoteShape(quote, now, this.maxFutureSkewMs)) return false;

    const current = this.states.get(quote.instrumentId) ?? EMPTY_STATE(quote.instrumentId);
    if (current.activeProvider && current.activeProvider !== quote.provider) return false;
    const explicitProviderSwitch = Boolean(
      current.quote &&
      current.quote.provider !== quote.provider &&
      current.activeProvider === quote.provider
    );
    if (current.quote && !explicitProviderSwitch && !isNewer(quote, current.quote)) return false;

    const immutableQuote = Object.freeze({ ...quote });
    this.states.set(quote.instrumentId, {
      ...current,
      quote: immutableQuote,
      activeProvider: current.activeProvider ?? quote.provider,
      connected: true,
      refreshing: false,
      version: current.version + 1,
      lastError: null,
      persistenceError: null,
    });
    this.publish(quote.instrumentId);

    // Persist accepted ticks in order. A disk failure is reported separately;
    // it must not make the accepted in-memory live quote disappear.
    if (this.persistence) this.queuePersistence(quote.instrumentId, immutableQuote);
    return true;
  }

  private queuePersistence(instrumentId: string, quote: CanonicalQuote): void {
    const previous = this.persistQueues.get(instrumentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistence!.save(quote))
      .then(() => {
        const current = this.states.get(instrumentId);
        if (current) {
          this.states.set(instrumentId, { ...current, persistenceError: null });
          this.publish(instrumentId);
        }
      })
      .catch((error: unknown) => {
        const current = this.states.get(instrumentId);
        if (current) {
          this.states.set(instrumentId, {
            ...current,
            persistenceError: error instanceof Error ? error.message : "Local quote persistence failed",
          });
          this.publish(instrumentId);
        }
      });
    this.persistQueues.set(instrumentId, next);
  }

  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    const quotes = await this.persistence.loadAll();
    const latest = new Map<string, CanonicalQuote>();
    for (const quote of quotes) {
      if (!validQuoteShape(quote, this.now(), this.maxFutureSkewMs)) continue;
      const previous = latest.get(quote.instrumentId);
      if (!previous || quote.sourceTimeMs > previous.sourceTimeMs ||
          (quote.sourceTimeMs === previous.sourceTimeMs &&
           quote.sequence !== null && previous.sequence !== null &&
           quote.sequence > previous.sequence)) {
        latest.set(quote.instrumentId, Object.freeze({ ...quote }));
      }
    }
    for (const [instrumentId, quote] of latest) {
      const current = this.states.get(instrumentId) ?? EMPTY_STATE(instrumentId);
      this.states.set(instrumentId, {
        ...current,
        quote,
        activeProvider: current.activeProvider ?? quote.provider,
        connected: false,
        refreshing: false,
        version: current.version + 1,
      });
      this.publish(instrumentId);
    }
  }
}
