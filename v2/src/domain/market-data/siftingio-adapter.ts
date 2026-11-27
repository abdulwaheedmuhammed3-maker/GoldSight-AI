import type { CanonicalQuote } from "./types";
import type { FeedCallbacks, FeedConnection, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";

interface SiftingFrame {
  f?: string;
  s?: string;
  p?: string | number;
  b?: string | number;
  B?: string | number;
  a?: string | number;
  A?: string | number;
  t?: string | number;
  op?: string;
  product?: string;
  symbols?: string[];
  code?: string | number;
  message?: string;
  tier?: string;
  max_subs?: number;
  max_conn?: number;
}

const PRODUCT_BY_SYMBOL: Record<string, "com" | "fx"> = {
  XAUUSD: "com",
  EURUSD: "fx",
  GBPUSD: "fx",
  USDJPY: "fx",
  AUDUSD: "fx",
  USDCAD: "fx",
  USDCHF: "fx",
  NZDUSD: "fx",
  EURGBP: "fx",
};

/**
 * SiftingIO subscription caps apply per market/product. A single WebSocket can
 * carry both FX and Commodities, so one market must not consume the other's
 * free-tier symbol allowance.
 */
export function buildSiftingIoSubscriptionPlan(
  symbols: readonly string[],
  maxSubscriptionsPerMarket: number | null,
): {
  batches: Array<{ product: "com" | "fx"; symbols: string[] }>;
  rejectedSymbols: string[];
} {
  const grouped = new Map<"com" | "fx", string[]>();
  for (const symbol of symbols) {
    const product = PRODUCT_BY_SYMBOL[symbol];
    if (!product) continue;
    const group = grouped.get(product) ?? [];
    group.push(symbol);
    grouped.set(product, group);
  }

  const batches: Array<{ product: "com" | "fx"; symbols: string[] }> = [];
  const rejectedSymbols: string[] = [];
  for (const [product, marketSymbols] of grouped) {
    const capacity = maxSubscriptionsPerMarket ?? marketSymbols.length;
    batches.push({ product, symbols: marketSymbols.slice(0, capacity) });
    rejectedSymbols.push(...marketSymbols.slice(capacity));
  }
  return { batches, rejectedSymbols };
}

/** Consume the one cached quote frame emitted when a WebSocket subscription starts. */
export function consumeSiftingIoInitialSnapshot(symbol: string, pendingSymbols: Set<string>): boolean {
  if (!pendingSymbols.has(symbol)) return false;
  pendingSymbols.delete(symbol);
  return true;
}

const TIMEFRAME_SECONDS: Record<string, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
};

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "boolean" || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function decimalPlaces(value: unknown): number {
  const raw = String(value ?? "");
  const dot = raw.indexOf(".");
  return dot < 0 ? 2 : Math.min(12, raw.length - dot - 1);
}

export function normalizeSiftingIoTick(
  message: SiftingFrame,
  receivedTimeMs: number,
  expectedInstrumentId?: string,
  transport: "WEBSOCKET" | "WEBSOCKET_SNAPSHOT" | "REST_SNAPSHOT" = "WEBSOCKET",
): CanonicalQuote | null {
  const instrumentId = String(message.s ?? "").toUpperCase();
  if (message.f !== "tick" || !(instrumentId in PRODUCT_BY_SYMBOL)) return null;
  if (expectedInstrumentId && instrumentId !== expectedInstrumentId) return null;

  const price = positiveNumber(message.p);
  const bid = positiveNumber(message.b);
  const ask = positiveNumber(message.a);
  const sourceTimeMs = parseTimestampMs(message.t);

  if (
    price === null || bid === null || ask === null || ask < bid ||
    sourceTimeMs === null ||
    sourceTimeMs > receivedTimeMs + 5_000 ||
    receivedTimeMs - sourceTimeMs > 30_000
  ) return null;

  return Object.freeze({
    instrumentId,
    provider: "SiftingIO Market Data",
    providerSymbol: instrumentId,
    transport,
    priceBasis: "last",
    price,
    bid,
    ask,
    last: price,
    sourceTimeMs,
    receivedTimeMs,
    sequence: null,
    digits: decimalPlaces(message.p),
  });
}

/**
 * REST /v1/last/quote response for instruments such as commodities that are
 * not included in the market-wide snapshot endpoint. We use the real mid-price
 * (bid + ask) / 2 and label its basis explicitly; no last trade is fabricated.
 */
export function normalizeSiftingIoTopOfBookQuote(
  message: SiftingFrame,
  receivedTimeMs: number,
  expectedInstrumentId: string,
): CanonicalQuote | null {
  const instrumentId = String(message.s ?? "").toUpperCase();
  if (instrumentId !== expectedInstrumentId || !(instrumentId in PRODUCT_BY_SYMBOL)) return null;
  const bid = positiveNumber(message.b);
  const ask = positiveNumber(message.a);
  const sourceTimeMs = parseTimestampMs(message.t);
  if (
    bid === null || ask === null || ask < bid || sourceTimeMs === null ||
    sourceTimeMs > receivedTimeMs + 5_000 ||
    receivedTimeMs - sourceTimeMs > 30_000
  ) return null;

  const price = (bid + ask) / 2;
  return Object.freeze({
    instrumentId,
    provider: "SiftingIO Market Data",
    providerSymbol: instrumentId,
    transport: "REST_SNAPSHOT",
    priceBasis: "mid",
    price,
    bid,
    ask,
    last: null,
    sourceTimeMs,
    receivedTimeMs,
    sequence: null,
    digits: Math.max(decimalPlaces(message.b), decimalPlaces(message.a)),
  });
}

function normalizeCandle(
  row: unknown,
  timeframeSeconds: number,
  nowMs: number,
): HistoricalCandle | null {
  if (!row || typeof row !== "object") return null;
  const item = row as Record<string, unknown>;
  const rawTime = parseTimestampMs(item.t);
  const open = positiveNumber(item.o);
  const high = positiveNumber(item.h);
  const low = positiveNumber(item.l);
  const close = positiveNumber(item.c);
  const rawVolume = item.v === undefined ? 0 : Number(item.v);
  if (
    rawTime === null || open === null || high === null || low === null || close === null ||
    !Number.isFinite(rawVolume) || rawVolume < 0 ||
    high < Math.max(open, close, low) || low > Math.min(open, close) ||
    rawTime > nowMs + 5_000
  ) return null;

  const openTimeSeconds = Math.floor(rawTime / 1_000);
  return {
    time: openTimeSeconds,
    open,
    high,
    low,
    close,
    volume: rawVolume,
    closed: rawTime + timeframeSeconds * 1_000 <= nowMs,
  };
}

function aggregateFourHourCandles(
  hourly: readonly HistoricalCandle[],
  nowMs: number,
): readonly HistoricalCandle[] {
  const grouped = new Map<number, HistoricalCandle[]>();
  for (const candle of hourly) {
    const bucket = Math.floor(candle.time / 14_400) * 14_400;
    const group = grouped.get(bucket) ?? [];
    group.push(candle);
    grouped.set(bucket, group);
  }

  const result: HistoricalCandle[] = [];
  for (const [bucket, partsUnsorted] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const parts = [...partsUnsorted].sort((a, b) => a.time - b.time);
    const expectedCount = Math.min(4, Math.floor((nowMs / 1_000 - bucket) / 3_600) + 1);
    const expectedTimes = Array.from({ length: Math.max(0, expectedCount) }, (_, index) => bucket + index * 3_600);
    if (
      expectedTimes.length === 0 ||
      parts.length !== expectedTimes.length ||
      parts.some((part, index) => part.time !== expectedTimes[index])
    ) continue;

    result.push({
      time: bucket,
      open: parts[0].open,
      high: Math.max(...parts.map((part) => part.high)),
      low: Math.min(...parts.map((part) => part.low)),
      close: parts[parts.length - 1].close,
      volume: parts.reduce((sum, part) => sum + (part.volume ?? 0), 0),
      closed: expectedCount === 4 && parts.every((part) => part.closed !== false),
    });
  }
  return result;
}

/**
 * Shared SiftingIO stream adapter. Multiple instruments share one WebSocket,
 * which matters for tiers that permit only one concurrent connection.
 *
 * API key is kept in this instance only. The server requires it in the WS URL.
 */
export class SiftingIoAdapter implements MarketFeedAdapter {
  readonly providerId = "SiftingIO Market Data";
  readonly supportedInstrumentIds = Object.keys(PRODUCT_BY_SYMBOL);

  private readonly apiKey: string;
  private readonly streamSymbols: Set<string>;
  private socket: WebSocket | null = null;
  private stopped = true;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  private restRequest: AbortController | null = null;
  private retryDelayMs = 1_000;
  private maxSubscriptions: number | null = null;
  private readonly callbacks = new Map<string, Set<FeedCallbacks>>();
  private readonly subscribed = new Set<string>();
  private readonly pendingInitialSnapshots = new Set<string>();
  private readonly lastTickTime = new Map<string, number>();


  /**
   * Selected symbols are the high-frequency WebSocket watchlist. Every other
   * active FX pair is covered by a batched six-minute REST market snapshot.
   */
  constructor(apiKey: string, streamSymbols: readonly string[] = []) {
    this.apiKey = apiKey.trim();
    this.streamSymbols = new Set(streamSymbols.filter((symbol) => symbol in PRODUCT_BY_SYMBOL));
  }

  private activeSymbols(): string[] {
    return [...this.callbacks.entries()]
      .filter(([, listeners]) => listeners.size > 0)
      .map(([symbol]) => symbol);
  }

  private notify(symbol: string, status: "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "ERROR", detail?: string): void {
    for (const listener of this.callbacks.get(symbol) ?? []) listener.onStatus(status, detail);
  }

  private notifyStreamSymbols(status: "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "ERROR", detail?: string): void {
    for (const symbol of this.activeStreamSymbols()) this.notify(symbol, status, detail);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private subscriptionKey(symbol: string): string {
    return PRODUCT_BY_SYMBOL[symbol] + ":" + symbol;
  }

  private activeStreamSymbols(): string[] {
    return this.activeSymbols().filter((symbol) => this.streamSymbols.has(symbol));
  }

  private isStreamingSymbol(symbol: string): boolean {
    return this.streamSymbols.has(symbol) &&
      this.authenticated &&
      this.socket?.readyState === WebSocket.OPEN &&
      this.subscribed.has(this.subscriptionKey(symbol));
  }

  private sendSubscriptions(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.authenticated) return;
    const plan = buildSiftingIoSubscriptionPlan(this.activeStreamSymbols(), this.maxSubscriptions);

    for (const symbol of plan.rejectedSymbols) {
      this.notify(symbol, "ERROR", "WebSocket limit reached. Falling back to SiftingIO REST snapshots.");
      this.subscribed.delete(this.subscriptionKey(symbol));
    }
    if (plan.rejectedSymbols.length > 0) void this.pollRestSnapshots();

    for (const batch of plan.batches) {
      const symbols = batch.symbols.filter((symbol) =>
        !this.subscribed.has(this.subscriptionKey(symbol)) && !this.pendingInitialSnapshots.has(symbol),
      );
      if (symbols.length === 0) continue;
      // SiftingIO sends one cached quote for every symbol immediately after
      // subscribe. Mark them before send because that frame can precede the ACK.
      for (const symbol of symbols) this.pendingInitialSnapshots.add(symbol);
      this.socket.send(JSON.stringify({ op: "subscribe", product: batch.product, symbols }));
    }
  }

  private startRestSnapshotPolling(): void {
    if (this.stopped || this.restPollTimer !== null) return;
    // Defer the first batch until Settings has attached all instrument listeners.
    void Promise.resolve().then(() => this.pollRestSnapshots());
    this.restPollTimer = setInterval(() => void this.pollRestSnapshots(), 6 * 60_000);
  }

  private async pollRestSnapshots(): Promise<void> {
    if (this.stopped || this.restRequest) return;
    const restSymbols = this.activeSymbols().filter((symbol) => !this.isStreamingSymbol(symbol));
    if (restSymbols.length === 0) return;

    const controller = new AbortController();
    this.restRequest = controller;
    try {
      const fxSymbols = restSymbols.filter((symbol) => PRODUCT_BY_SYMBOL[symbol] === "fx");
      const commoditySymbols = restSymbols.filter((symbol) => PRODUCT_BY_SYMBOL[symbol] === "com");

      if (fxSymbols.length > 0) {
        try {
          const url = new URL("https://api.sifting.io/v1/snapshot/forex");
          url.searchParams.set("symbols", fxSymbols.join(","));
          const response = await fetch(url, {
            headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("SiftingIO Forex snapshot returned HTTP " + response.status + ".");
          const payload: unknown = await response.json();
          const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
            ? (payload as { data: SiftingFrame[] }).data
            : null;
          if (!data) throw new Error("SiftingIO returned an invalid Forex snapshot payload.");

          const receivedSymbols = new Set<string>();
          for (const item of data) {
            const symbol = String(item.s ?? "").toUpperCase();
            if (!fxSymbols.includes(symbol)) continue;
            // A WebSocket stream may have become active while this REST request
            // was in flight. Never let its older snapshot overwrite a live tick.
            if (this.isStreamingSymbol(symbol)) {
              receivedSymbols.add(symbol);
              continue;
            }
            const quote = normalizeSiftingIoTick({ ...item, f: "tick" }, Date.now(), symbol, "REST_SNAPSHOT");
            if (!quote) continue;
            receivedSymbols.add(symbol);
            for (const listener of this.callbacks.get(symbol) ?? []) listener.onQuote(quote);
            this.notify(symbol, "CONNECTED", "REST snapshot · refreshes every 6 minutes.");
          }
          for (const symbol of fxSymbols) {
            if (!receivedSymbols.has(symbol)) {
              this.notify(symbol, "ERROR", "No fresh quote for this pair in the latest SiftingIO Forex snapshot.");
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const detail = error instanceof Error ? error.message : "SiftingIO Forex snapshot is unavailable.";
          for (const symbol of fxSymbols) this.notify(symbol, "ERROR", detail);
        }
      }

      // SiftingIO's market-wide snapshot endpoint currently excludes commodities.
      // Use the documented single-symbol top-of-book endpoint for an unstreamed XAUUSD.
      for (const symbol of commoditySymbols) {
        if (controller.signal.aborted || this.stopped) return;
        if (this.isStreamingSymbol(symbol)) continue;
        try {
          const url = new URL(
            "https://api.sifting.io/v1/last/quote/commodities/" + encodeURIComponent(symbol),
          );
          const response = await fetch(url, {
            headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("SiftingIO " + symbol + " quote returned HTTP " + response.status + ".");
          const payload: unknown = await response.json();
          if (!payload || typeof payload !== "object") throw new Error("SiftingIO returned an invalid " + symbol + " quote.");
          const quote = normalizeSiftingIoTopOfBookQuote(payload as SiftingFrame, Date.now(), symbol);
          if (!quote) throw new Error("SiftingIO returned a stale or invalid " + symbol + " quote.");
          for (const listener of this.callbacks.get(symbol) ?? []) listener.onQuote(quote);
          this.notify(symbol, "CONNECTED", "REST midpoint snapshot · refreshes every 6 minutes.");
        } catch (error) {
          if (controller.signal.aborted) return;
          this.notify(
            symbol,
            "ERROR",
            error instanceof Error ? error.message : "SiftingIO commodity quote is unavailable.",
          );
        }
      }
    } finally {
      if (this.restRequest === controller) this.restRequest = null;
    }
  }

  private openSocket(): void {
    if (this.stopped || !this.apiKey || this.socket) return;
    this.notifyStreamSymbols("CONNECTING", "Connecting selected pairs to SiftingIO WebSocket.");
    const url = new URL("wss://stream.sifting.io/ws/v1");
    url.searchParams.set("key", this.apiKey);
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.onopen = () => {
      this.authenticated = false;
      this.subscribed.clear();
      this.pendingInitialSnapshots.clear();
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
      }, 25_000);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== "object") return;
        const message = parsed as SiftingFrame;

        if (message.f === "ack" && message.op === "auth") {
          this.authenticated = true;
          this.retryDelayMs = 1_000;
          this.maxSubscriptions = Number.isSafeInteger(message.max_subs) && Number(message.max_subs) > 0
            ? Number(message.max_subs)
            : null;
          this.sendSubscriptions();
          return;
        }

        if (message.f === "ack" && message.op === "subscribe" && Array.isArray(message.symbols)) {
          for (const rawSymbol of message.symbols) {
            const symbol = String(rawSymbol).toUpperCase();
            this.subscribed.add(this.subscriptionKey(symbol));
            this.notify(symbol, "CONNECTED", "WebSocket · tick-by-tick streaming.");
          }
          return;
        }

        if (message.f === "error") {
          const detail = "SiftingIO: " + String(message.code ?? "provider_error") + " · " + String(message.message ?? "Subscription rejected.");
          const affected = Array.isArray(message.symbols)
            ? message.symbols
            : message.product === "fx" || message.product === "com"
              ? this.activeStreamSymbols().filter((symbol) => PRODUCT_BY_SYMBOL[symbol] === message.product)
              : this.activeStreamSymbols();
          for (const rawSymbol of affected) {
            const symbol = String(rawSymbol).toUpperCase();
            this.subscribed.delete(this.subscriptionKey(symbol));
            this.pendingInitialSnapshots.delete(symbol);
            this.notify(symbol, "ERROR", detail + " REST snapshot fallback remains available.");
          }
          void this.pollRestSnapshots();
          return;
        }

        if (message.f === "tick") {
          const symbol = String(message.s ?? "").toUpperCase();
          // Consume the cached subscription frame even if it later fails
          // validation or timestamp ordering; only the next frame is a live tick.
          const transport = consumeSiftingIoInitialSnapshot(symbol, this.pendingInitialSnapshots)
            ? "WEBSOCKET_SNAPSHOT"
            : "WEBSOCKET";
          const quote = normalizeSiftingIoTick(message, Date.now(), symbol, transport);
          if (!quote) return;
          const previousTime = this.lastTickTime.get(symbol) ?? 0;
          if (quote.sourceTimeMs <= previousTime) return;
          this.lastTickTime.set(symbol, quote.sourceTimeMs);
          for (const listener of this.callbacks.get(symbol) ?? []) listener.onQuote(quote);
        }
      } catch {
        // Malformed provider frames never clear the last-known-good quote.
      }
    };

    socket.onerror = () => this.notifyStreamSymbols("ERROR", "SiftingIO WebSocket error.");
    socket.onclose = () => {
      this.clearPing();
      this.socket = null;
      this.authenticated = false;
      this.subscribed.clear();
      this.pendingInitialSnapshots.clear();
      if (this.stopped || this.activeStreamSymbols().length === 0) return;
      this.notifyStreamSymbols("DISCONNECTED", "SiftingIO stream disconnected; REST snapshots continue while WebSocket reconnects.");
      void this.pollRestSnapshots();
      const delay = this.retryDelayMs;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket();
      }, delay);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
    };
  }

  connect(instrumentId: string, callbacks: FeedCallbacks): FeedConnection {
    if (!this.apiKey) {
      callbacks.onStatus("ERROR", "A SiftingIO API key is required.");
      return { close: () => undefined };
    }
    if (!(instrumentId in PRODUCT_BY_SYMBOL)) {
      callbacks.onStatus("ERROR", "SiftingIO does not list this instrument in the current adapter.");
      return { close: () => undefined };
    }

    this.stopped = false;
    const listeners = this.callbacks.get(instrumentId) ?? new Set<FeedCallbacks>();
    listeners.add(callbacks);
    this.callbacks.set(instrumentId, listeners);

    if (this.streamSymbols.has(instrumentId)) {
      callbacks.onStatus("CONNECTING", "Connecting selected pair to SiftingIO WebSocket.");
      if (this.socket && this.socket.readyState === WebSocket.OPEN && this.authenticated) {
        this.sendSubscriptions();
      } else if (!this.socket) {
        this.openSocket();
      }
    } else {
      callbacks.onStatus("CONNECTING", "Waiting for the next SiftingIO REST snapshot.");
    }
    this.startRestSnapshotPolling();

    return {
      close: () => {
        const current = this.callbacks.get(instrumentId);
        current?.delete(callbacks);
        if (current && current.size === 0) this.callbacks.delete(instrumentId);

        const stillNeeded = this.callbacks.has(instrumentId);
        const key = this.subscriptionKey(instrumentId);
        if (!stillNeeded && this.subscribed.has(key) && this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({
            op: "unsubscribe",
            product: PRODUCT_BY_SYMBOL[instrumentId],
            symbols: [instrumentId],
          }));
          this.subscribed.delete(key);
          this.pendingInitialSnapshots.delete(instrumentId);
        }

        if (this.activeSymbols().length === 0) {
          this.stopped = true;
          if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          if (this.restPollTimer !== null) clearInterval(this.restPollTimer);
          this.restPollTimer = null;
          this.restRequest?.abort();
          this.restRequest = null;
          this.clearPing();
          this.socket?.close();
          this.socket = null;
          this.authenticated = false;
          this.subscribed.clear();
          this.pendingInitialSnapshots.clear();
        }
      },
    };
  }

  async loadCandles(
    instrumentId: string,
    timeframe: string,
    limit: number,
  ): Promise<readonly HistoricalCandle[]> {
    if (!(instrumentId in PRODUCT_BY_SYMBOL) || !(timeframe in TIMEFRAME_SECONDS)) {
      throw new Error("SiftingIO candle history does not support this symbol/timeframe.");
    }

    const sourceTimeframe = timeframe === "4h" ? "1h" : timeframe;
    const sourceSeconds = TIMEFRAME_SECONDS[sourceTimeframe];
    const sourceLimit = Math.min(2_000, Math.max(45, limit * (timeframe === "4h" ? 4 : 1) + 8));
    const now = Date.now();
    const start = new Date(now - sourceSeconds * sourceLimit * 2_000).toISOString();
    const end = new Date(now).toISOString();

    const url = new URL("https://api.sifting.io/v1/hist/" +
      (PRODUCT_BY_SYMBOL[instrumentId] === "com" ? "commodities/" : "forex/") +
      instrumentId + "/bars");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("interval", sourceTimeframe);
    url.searchParams.set("limit", String(sourceLimit));
    url.searchParams.set("order", "desc");

    const response = await fetch(url, {
      headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("SiftingIO candle history returned HTTP " + response.status + ".");

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error("SiftingIO returned an invalid candle history payload.");
    }

    const sourceBars = (payload as { data: unknown[] }).data
      .map((row) => normalizeCandle(row, sourceSeconds, now))
      .filter((bar): bar is HistoricalCandle => bar !== null)
      .sort((a, b) => a.time - b.time);

    const candles = timeframe === "4h" ? aggregateFourHourCandles(sourceBars, now) : sourceBars;
    if (!candles.length) throw new Error("SiftingIO returned no valid candles for " + instrumentId + ".");
    return candles;
  }
}
