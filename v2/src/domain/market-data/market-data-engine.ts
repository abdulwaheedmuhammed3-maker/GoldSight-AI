import type { ActiveCandle } from "./candle-aggregator";
import { updateActiveCandle } from "./candle-aggregator";
import type { CandlePersistence, FeedConnection, FeedStatus, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";
import type { CanonicalQuote, InstrumentQuoteState } from "./types";
import { QuoteStore } from "./quote-store";

export type SupportedTimeframe = "5m" | "15m" | "1h" | "4h";
const TIMEFRAME_SECONDS: Record<SupportedTimeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
};

export interface InstrumentMarketState {
  readonly quote: InstrumentQuoteState;
  readonly feedStatus: FeedStatus;
  readonly detail: string | null;
}

export interface CachedFeedSource {
  readonly instrumentId: string;
  readonly providerId: string;
}

type MarketListener = (state: InstrumentMarketState) => void;
type AcceptedQuoteListener = (quote: CanonicalQuote) => void;

export class MarketDataEngine {
  private readonly adapters = new Map<string, MarketFeedAdapter>();
  private readonly connections = new Map<string, FeedConnection>();
  private readonly feedStates = new Map<string, { status: FeedStatus; detail: string | null }>();
  private readonly activeCandles = new Map<string, ActiveCandle>();
  private readonly history = new Map<string, readonly HistoricalCandle[]>();
  private readonly listeners = new Map<string, Set<MarketListener>>();
  private readonly timeframeListeners = new Map<string, Set<() => void>>();
  private readonly quoteObservers = new Set<AcceptedQuoteListener>();
  private readonly historyBootstraps = new Set<string>();

  constructor(readonly quotes: QuoteStore, private readonly candlePersistence?: CandlePersistence) {}

  addQuoteObserver(listener: AcceptedQuoteListener): () => void {
    this.quoteObservers.add(listener);
    return () => this.quoteObservers.delete(listener);
  }

  registerAdapter(adapter: MarketFeedAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  unregisterAdapter(providerId: string): void {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return;
    for (const instrumentId of adapter.supportedInstrumentIds) {
      this.disconnect(instrumentId);
    }
    this.adapters.delete(providerId);
  }

  subscribe(instrumentId: string, listener: MarketListener): () => void {
    const set = this.listeners.get(instrumentId) ?? new Set<MarketListener>();
    set.add(listener);
    this.listeners.set(instrumentId, set);
    listener(this.getState(instrumentId));
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(instrumentId);
    };
  }

  subscribeCandles(
    instrumentId: string,
    timeframe: SupportedTimeframe,
    providerId: string,
    listener: () => void,
  ): () => void {
    const key = this.key(instrumentId, timeframe, providerId);
    const set = this.timeframeListeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    this.timeframeListeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.timeframeListeners.delete(key);
    };
  }

  private key(instrumentId: string, timeframe: SupportedTimeframe, providerId: string): string {
    return instrumentId + ":" + timeframe + ":" + providerId;
  }

  private publish(instrumentId: string): void {
    const state = this.getState(instrumentId);
    for (const listener of this.listeners.get(instrumentId) ?? []) listener(state);
  }

  private publishCandles(instrumentId: string, timeframe: SupportedTimeframe, providerId: string): void {
    for (const listener of this.timeframeListeners.get(this.key(instrumentId, timeframe, providerId)) ?? []) listener();
  }

  getState(instrumentId: string): InstrumentMarketState {
    const state = this.feedStates.get(instrumentId) ?? { status: "DISCONNECTED" as const, detail: null };
    return {
      quote: this.quotes.getSnapshot(instrumentId),
      feedStatus: state.status,
      detail: state.detail,
    };
  }

  getCandles(
    instrumentId: string,
    timeframe: SupportedTimeframe,
    providerId: string,
  ): readonly HistoricalCandle[] {
    const key = this.key(instrumentId, timeframe, providerId);
    const historical = this.history.get(key) ?? [];
    const active = this.activeCandles.get(key);
    if (!active) return historical;
    const activeBar: HistoricalCandle = {
      time: Math.floor(active.timeMs / 1_000),
      open: active.open,
      high: active.high,
      low: active.low,
      close: active.close,
      closed: false,
    };
    const withoutActive = historical.filter((bar) => bar.time !== activeBar.time);
    return [...withoutActive, activeBar].sort((a, b) => a.time - b.time);
  }

  async hydrateCachedHistory(sources: readonly CachedFeedSource[]): Promise<void> {
    if (!this.candlePersistence) return;
    for (const { instrumentId, providerId } of sources) {
      for (const timeframe of Object.keys(TIMEFRAME_SECONDS) as SupportedTimeframe[]) {
        try {
          const cached = await this.candlePersistence.loadCandles(instrumentId, timeframe, providerId);
          if (cached.length === 0) continue;
          const valid = [...cached]
            .filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.open) &&
              Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close) &&
              bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0 &&
              bar.high >= Math.max(bar.open, bar.close, bar.low) &&
              bar.low <= Math.min(bar.open, bar.close, bar.high))
            .map((bar) => ({ ...bar, closed: true }))
            .sort((a, b) => a.time - b.time);
          if (valid.length > 0) {
            this.history.set(this.key(instrumentId, timeframe, providerId), valid.slice(-1_000));
            this.publishCandles(instrumentId, timeframe, providerId);
          }
        } catch (error) {
          console.warn("TradeSight could not restore cached candles", instrumentId, timeframe, providerId, error);
        }
      }
    }
  }

  private persistCompletedCandles(
    instrumentId: string,
    timeframe: SupportedTimeframe,
    providerId: string,
  ): void {
    if (!this.candlePersistence) return;
    const candles = this.history.get(this.key(instrumentId, timeframe, providerId)) ?? [];
    void this.candlePersistence.saveCandles(instrumentId, timeframe, providerId, candles).catch((error: unknown) => {
      console.warn("TradeSight could not persist candle history", instrumentId, timeframe, providerId, error);
    });
  }

  private appendCompletedCandle(
    instrumentId: string,
    timeframe: SupportedTimeframe,
    providerId: string,
    candle: ActiveCandle,
  ): void {
    const key = this.key(instrumentId, timeframe, providerId);
    const history = [...(this.history.get(key) ?? [])];
    const completed: HistoricalCandle = {
      time: Math.floor(candle.timeMs / 1_000),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      closed: true,
    };
    const index = history.findIndex((bar) => bar.time === completed.time);
    if (index >= 0) history[index] = completed;
    else history.push(completed);
    history.sort((a, b) => a.time - b.time);
    this.history.set(key, history.slice(-1_000));
    this.persistCompletedCandles(instrumentId, timeframe, providerId);
  }

  private applyQuote(quote: CanonicalQuote): void {
    const accepted = this.quotes.ingest(quote);
    if (!accepted) return;

    // Outcome monitors consume the same accepted canonical tick as the UI and candles.
    for (const observer of this.quoteObservers) observer(quote);

    for (const [timeframe, seconds] of Object.entries(TIMEFRAME_SECONDS) as [SupportedTimeframe, number][]) {
      const key = this.key(quote.instrumentId, timeframe, quote.provider);
      const current = this.activeCandles.get(key) ?? null;
      const update = updateActiveCandle(current, quote, seconds);
      if (!update.accepted || !update.candle) continue;
      if (update.rolledOver && current) {
        this.appendCompletedCandle(quote.instrumentId, timeframe, quote.provider, current);
      }
      this.activeCandles.set(key, update.candle);
      this.publishCandles(quote.instrumentId, timeframe, quote.provider);
    }
    this.publish(quote.instrumentId);
  }

  connect(instrumentId: string, providerId: string): void {
    const adapter = this.adapters.get(providerId);
    if (!adapter || !adapter.supportedInstrumentIds.includes(instrumentId)) {
      this.feedStates.set(instrumentId, { status: "ERROR", detail: "No configured provider supports this instrument." });
      this.publish(instrumentId);
      return;
    }

    this.connections.get(instrumentId)?.close();
    this.connections.delete(instrumentId);
    this.quotes.setActiveProvider(instrumentId, adapter.providerId);
    this.quotes.beginRefresh(instrumentId);
    this.feedStates.set(instrumentId, { status: "CONNECTING", detail: null });
    this.publish(instrumentId);

    const connection = adapter.connect(instrumentId, {
      onQuote: (quote) => this.applyQuote(quote),
      onStatus: (status, detail) => {
        this.feedStates.set(instrumentId, { status, detail: detail ?? null });
        if (status === "CONNECTED") {
          this.quotes.setConnection(instrumentId, true);
          void this.bootstrapHistory(instrumentId, adapter.providerId);
        } else if (status === "DISCONNECTED" || status === "ERROR") {
          this.quotes.setConnection(instrumentId, false);
        }
        this.publish(instrumentId);
      },
    });
    this.connections.set(instrumentId, connection);
  }

  private async bootstrapHistory(instrumentId: string, providerId: string): Promise<void> {
    const bootstrapKey = instrumentId + ":" + providerId;
    if (this.historyBootstraps.has(bootstrapKey)) return;
    this.historyBootstraps.add(bootstrapKey);

    // Fetch each timeframe sequentially to avoid bursting provider history APIs.
    for (const timeframe of Object.keys(TIMEFRAME_SECONDS) as SupportedTimeframe[]) {
      try {
        await this.loadHistory(instrumentId, providerId, timeframe, 160);
      } catch (error) {
        // Cached candles remain in the store; the scanner will report insufficient history.
        console.warn("TradeSight initial candle history is unavailable", instrumentId, providerId, timeframe, error);
      }
    }
  }

  async loadHistory(
    instrumentId: string,
    providerId: string,
    timeframe: SupportedTimeframe,
    limit = 240,
  ): Promise<readonly HistoricalCandle[]> {
    const key = this.key(instrumentId, timeframe, providerId);
    const adapter = this.adapters.get(providerId);
    if (!adapter?.loadCandles) return this.getCandles(instrumentId, timeframe, providerId);

    // Keep prior history for this provider visible while a replacement batch loads.
    const loaded = await adapter.loadCandles(instrumentId, timeframe, limit);
    const activeBar = [...loaded].reverse().find((bar) => bar.closed === false);
    const completedBars = loaded.filter((bar) => bar.closed !== false);
    this.history.set(key, completedBars);
    this.persistCompletedCandles(instrumentId, timeframe, providerId);

    // Seed from the same provider's active candle, then apply only a matching quote.
    const latestQuote = this.quotes.getSnapshot(instrumentId).quote;
    if (activeBar && latestQuote?.provider === providerId) {
      const seconds = TIMEFRAME_SECONDS[timeframe];
      const intervalMs = seconds * 1_000;
      const bucketTimeMs = Math.floor(latestQuote.sourceTimeMs / intervalMs) * intervalMs;
      const historyBarTimeMs = activeBar.time * 1_000;
      if (bucketTimeMs === historyBarTimeMs) {
        const seed: ActiveCandle = {
          instrumentId,
          provider: latestQuote.provider,
          priceBasis: latestQuote.priceBasis,
          timeframeSeconds: seconds,
          timeMs: historyBarTimeMs,
          open: activeBar.open,
          high: activeBar.high,
          low: activeBar.low,
          close: activeBar.close,
          lastTickTimeMs: latestQuote.sourceTimeMs - 1,
          lastSequence: null,
          tickCount: 0,
        };
        const seeded = updateActiveCandle(seed, latestQuote, seconds);
        if (seeded.accepted && seeded.candle) this.activeCandles.set(key, seeded.candle);
      }
    }

    // Apply any newer quote that arrived during the history request, but never another provider's tick.
    const newestQuote = this.quotes.getSnapshot(instrumentId).quote;
    const currentActive = this.activeCandles.get(key) ?? null;
    if (newestQuote?.provider === providerId && currentActive) {
      const newest = updateActiveCandle(currentActive, newestQuote, TIMEFRAME_SECONDS[timeframe]);
      if (newest.accepted && newest.candle) this.activeCandles.set(key, newest.candle);
    }

    this.publishCandles(instrumentId, timeframe, providerId);
    return this.getCandles(instrumentId, timeframe, providerId);
  }

  disconnect(instrumentId: string): void {
    this.connections.get(instrumentId)?.close();
    this.connections.delete(instrumentId);
    this.quotes.setConnection(instrumentId, false);
    this.feedStates.set(instrumentId, { status: "DISCONNECTED", detail: "Feed disconnected; last valid price is retained." });
    this.publish(instrumentId);
  }

  disconnectAll(): void {
    for (const instrumentId of [...this.connections.keys()]) this.disconnect(instrumentId);
  }
}
