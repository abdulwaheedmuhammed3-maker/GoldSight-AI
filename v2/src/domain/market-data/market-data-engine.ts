import type { ActiveCandle } from "./candle-aggregator";
import { updateActiveCandle } from "./candle-aggregator";
import type { FeedConnection, FeedStatus, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";
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

type MarketListener = (state: InstrumentMarketState) => void;

export class MarketDataEngine {
  private readonly adapters = new Map<string, MarketFeedAdapter>();
  private readonly connections = new Map<string, FeedConnection>();
  private readonly feedStates = new Map<string, { status: FeedStatus; detail: string | null }>();
  private readonly activeCandles = new Map<string, ActiveCandle>();
  private readonly history = new Map<string, readonly HistoricalCandle[]>();
  private readonly listeners = new Map<string, Set<MarketListener>>();
  private readonly timeframeListeners = new Map<string, Set<() => void>>();

  constructor(readonly quotes: QuoteStore) {}

  registerAdapter(adapter: MarketFeedAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
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

  subscribeCandles(instrumentId: string, timeframe: SupportedTimeframe, listener: () => void): () => void {
    const key = this.key(instrumentId, timeframe);
    const set = this.timeframeListeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    this.timeframeListeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.timeframeListeners.delete(key);
    };
  }

  private key(instrumentId: string, timeframe: SupportedTimeframe): string {
    return instrumentId + ":" + timeframe;
  }

  private publish(instrumentId: string): void {
    const state = this.getState(instrumentId);
    for (const listener of this.listeners.get(instrumentId) ?? []) listener(state);
  }

  private publishCandles(instrumentId: string, timeframe: SupportedTimeframe): void {
    for (const listener of this.timeframeListeners.get(this.key(instrumentId, timeframe)) ?? []) listener();
  }

  getState(instrumentId: string): InstrumentMarketState {
    const state = this.feedStates.get(instrumentId) ?? { status: "DISCONNECTED" as const, detail: null };
    return {
      quote: this.quotes.getSnapshot(instrumentId),
      feedStatus: state.status,
      detail: state.detail,
    };
  }

  getCandles(instrumentId: string, timeframe: SupportedTimeframe): readonly HistoricalCandle[] {
    const historical = this.history.get(this.key(instrumentId, timeframe)) ?? [];
    const active = this.activeCandles.get(this.key(instrumentId, timeframe));
    if (!active) return historical;
    const activeBar: HistoricalCandle = {
      time: Math.floor(active.timeMs / 1_000),
      open: active.open,
      high: active.high,
      low: active.low,
      close: active.close,
    };
    const withoutActive = historical.filter((bar) => bar.time !== activeBar.time);
    return [...withoutActive, activeBar].sort((a, b) => a.time - b.time);
  }

  private applyQuote(quote: CanonicalQuote): void {
    const accepted = this.quotes.ingest(quote);
    if (!accepted) return;

    for (const [timeframe, seconds] of Object.entries(TIMEFRAME_SECONDS) as [SupportedTimeframe, number][]) {
      const key = this.key(quote.instrumentId, timeframe);
      const current = this.activeCandles.get(key) ?? null;
      const update = updateActiveCandle(current, quote, seconds);
      if (!update.accepted || !update.candle) continue;
      this.activeCandles.set(key, update.candle);
      this.publishCandles(quote.instrumentId, timeframe);
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
        if (status === "DISCONNECTED" || status === "ERROR") {
          this.quotes.setConnection(instrumentId, false);
        }
        this.publish(instrumentId);
      },
    });
    this.connections.set(instrumentId, connection);
  }

  async loadHistory(
    instrumentId: string,
    providerId: string,
    timeframe: SupportedTimeframe,
    limit = 240,
  ): Promise<readonly HistoricalCandle[]> {
    const adapter = this.adapters.get(providerId);
    if (!adapter?.loadCandles) return this.getCandles(instrumentId, timeframe);
    const key = this.key(instrumentId, timeframe);
    // Keep prior history and the live candle visible while verified history loads.
    const loaded = await adapter.loadCandles(instrumentId, timeframe, limit);
    const activeBar = [...loaded].reverse().find((bar) => bar.closed === false);
    const completedBars = loaded.filter((bar) => bar.closed !== false);
    this.history.set(key, completedBars);

    // Seed the in-progress OHLC bar from the provider's actual history response.
    // Then apply the canonical live tick so the chart close equals Market Watch.
    const latestQuote = this.quotes.getSnapshot(instrumentId).quote;
    if (activeBar && latestQuote) {
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

    // Apply any newer quote that arrived during the history request before publish.
    const newestQuote = this.quotes.getSnapshot(instrumentId).quote;
    const currentActive = this.activeCandles.get(key) ?? null;
    if (newestQuote && currentActive) {
      const newest = updateActiveCandle(currentActive, newestQuote, TIMEFRAME_SECONDS[timeframe]);
      if (newest.accepted && newest.candle) this.activeCandles.set(key, newest.candle);
    }

    this.publishCandles(instrumentId, timeframe);
    return this.getCandles(instrumentId, timeframe);
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
