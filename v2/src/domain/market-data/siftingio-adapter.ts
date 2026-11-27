import type { CanonicalQuote } from "./types";
import type { FeedCallbacks, FeedConnection, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";

interface SiftingFrame {
  f?: string;
  s?: string;
  p?: string | number;
  b?: string | number;
  a?: string | number;
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
    provider: "SiftingIO WebSocket",
    providerSymbol: instrumentId,
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
  readonly providerId = "SiftingIO WebSocket";
  readonly supportedInstrumentIds = Object.keys(PRODUCT_BY_SYMBOL);

  private readonly apiKey: string;
  private socket: WebSocket | null = null;
  private stopped = true;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryDelayMs = 1_000;
  private maxSubscriptions: number | null = null;
  private readonly callbacks = new Map<string, Set<FeedCallbacks>>();
  private readonly subscribed = new Set<string>();
  private readonly lastTickTime = new Map<string, number>();

  constructor(apiKey: string) {
    this.apiKey = apiKey.trim();
  }

  private activeSymbols(): string[] {
    return [...this.callbacks.entries()]
      .filter(([, listeners]) => listeners.size > 0)
      .map(([symbol]) => symbol);
  }

  private notify(symbol: string, status: "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "ERROR", detail?: string): void {
    for (const listener of this.callbacks.get(symbol) ?? []) listener.onStatus(status, detail);
  }

  private notifyAll(status: "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "ERROR", detail?: string): void {
    for (const symbol of this.activeSymbols()) this.notify(symbol, status, detail);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private subscriptionKey(symbol: string): string {
    return PRODUCT_BY_SYMBOL[symbol] + ":" + symbol;
  }

  private sendSubscriptions(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.authenticated) return;
    const active = this.activeSymbols();
    const max = this.maxSubscriptions ?? active.length;
    const allowed = active.slice(0, Math.max(0, max));

    for (const symbol of active.slice(max)) {
      this.notify(symbol, "ERROR", "The SiftingIO account subscription limit has been reached (" + max + " symbols). Disconnect another symbol or check the API plan.");
    }

    const groups = new Map<string, string[]>();
    for (const symbol of allowed) {
      if (this.subscribed.has(this.subscriptionKey(symbol))) continue;
      const product = PRODUCT_BY_SYMBOL[symbol];
      const list = groups.get(product) ?? [];
      list.push(symbol);
      groups.set(product, list);
    }

    for (const [product, symbols] of groups) {
      this.socket.send(JSON.stringify({ op: "subscribe", product, symbols }));
      for (const symbol of symbols) this.subscribed.add(this.subscriptionKey(symbol));
    }
  }

  private openSocket(): void {
    if (this.stopped || !this.apiKey || this.socket) return;
    this.notifyAll("CONNECTING");
    const url = new URL("wss://stream.sifting.io/ws/v1");
    url.searchParams.set("key", this.apiKey);
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.onopen = () => {
      this.authenticated = false;
      this.subscribed.clear();
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
          for (const symbol of message.symbols) {
            this.notify(String(symbol).toUpperCase(), "CONNECTED",
              message.max_subs ? "SiftingIO authenticated · subscription capacity " + message.max_subs : "SiftingIO subscription acknowledged.");
          }
          return;
        }

        if (message.f === "error") {
          const detail = "SiftingIO: " + String(message.code ?? "provider_error") + " · " + String(message.message ?? "Subscription rejected.");
          const rejected = Array.isArray(message.symbols) ? message.symbols : this.activeSymbols();
          for (const symbol of rejected) this.notify(String(symbol).toUpperCase(), "ERROR", detail);
          return;
        }

        if (message.f === "tick") {
          const symbol = String(message.s ?? "").toUpperCase();
          const quote = normalizeSiftingIoTick(message, Date.now(), symbol);
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

    socket.onerror = () => this.notifyAll("ERROR", "SiftingIO WebSocket error.");
    socket.onclose = () => {
      this.clearPing();
      this.socket = null;
      this.authenticated = false;
      this.subscribed.clear();
      if (this.stopped || this.activeSymbols().length === 0) return;
      this.notifyAll("DISCONNECTED", "SiftingIO stream disconnected; reconnecting.");
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
    callbacks.onStatus("CONNECTING");

    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.authenticated) {
      this.sendSubscriptions();
    } else if (!this.socket) {
      this.openSocket();
    }

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
        }

        if (this.activeSymbols().length === 0) {
          this.stopped = true;
          if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          this.clearPing();
          this.socket?.close();
          this.socket = null;
          this.authenticated = false;
          this.subscribed.clear();
        }
      },
    };
  }

  async loadCandles(
    instrumentId: string,
    timeframe: string,
    limit: number,
  ): Promise<readonly HistoricalCandle[]> {
    if (!(instrumentId in PRODUCT_BY_SYMBOL) || instrumentId === "XAUUSD" &&
        !(timeframe in TIMEFRAME_SECONDS) || !(timeframe in TIMEFRAME_SECONDS)) {
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
