import type { CanonicalQuote } from "./types";
import type { FeedCallbacks, FeedConnection, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";

interface SiftingTick {
  f?: string;
  s?: string;
  p?: string | number;
  b?: string | number;
  a?: string | number;
  t?: string | number;
  op?: string;
  code?: string | number;
  message?: string;
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
  message: SiftingTick,
  receivedTimeMs: number,
): CanonicalQuote | null {
  if (message.f !== "tick" || String(message.s ?? "").toUpperCase() !== "XAUUSD") return null;

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
    instrumentId: "XAUUSD",
    provider: "SiftingIO WebSocket",
    providerSymbol: "XAUUSD",
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

    const closed = expectedCount === 4 && parts.every((part) => part.closed !== false);
    result.push({
      time: bucket,
      open: parts[0].open,
      high: Math.max(...parts.map((part) => part.high)),
      low: Math.min(...parts.map((part) => part.low)),
      close: parts[parts.length - 1].close,
      volume: parts.reduce((sum, part) => sum + (part.volume ?? 0), 0),
      closed,
    });
  }
  return result;
}

/**
 * Direct XAUUSD stream. The API key is held only by this adapter instance
 * (memory only); it is never written to IndexedDB or localStorage.
 */
export class SiftingIoAdapter implements MarketFeedAdapter {
  readonly providerId = "SiftingIO WebSocket";
  readonly supportedInstrumentIds = ["XAUUSD"] as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey.trim();
  }

  connect(instrumentId: string, callbacks: FeedCallbacks): FeedConnection {
    let socket: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let retryDelayMs = 1_000;
    let lastProviderTickMs = 0;

    if (instrumentId !== "XAUUSD" || !this.apiKey) {
      callbacks.onStatus("ERROR", "A SiftingIO API key is required for XAUUSD.");
      return { close: () => undefined };
    }

    const clearPing = () => {
      if (pingTimer !== null) clearInterval(pingTimer);
      pingTimer = null;
    };

    const open = () => {
      if (stopped) return;
      callbacks.onStatus("CONNECTING");
      const url = new URL("wss://stream.sifting.io/ws/v1");
      url.searchParams.set("key", this.apiKey);
      socket = new WebSocket(url.toString());

      socket.onopen = () => {
        retryDelayMs = 1_000;
        socket?.send(JSON.stringify({ op: "subscribe", product: "com", symbols: ["XAUUSD"] }));
        clearPing();
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "ping" }));
          }
        }, 25_000);
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (!parsed || typeof parsed !== "object") return;
          const message = parsed as SiftingTick;

          if (message.op === "subscribe") {
            callbacks.onStatus("CONNECTED");
            return;
          }
          if (message.op === "error" || message.code) {
            callbacks.onStatus("ERROR", "SiftingIO rejected the stream subscription or API key.");
            return;
          }

          const receivedAt = Date.now();
          const quote = normalizeSiftingIoTick(message, receivedAt);
          if (!quote || quote.sourceTimeMs <= lastProviderTickMs) return;
          lastProviderTickMs = quote.sourceTimeMs;
          callbacks.onQuote(quote);
        } catch {
          // Ignore malformed frames without clearing the last accepted quote.
        }
      };

      socket.onerror = () => callbacks.onStatus("ERROR", "SiftingIO WebSocket error.");
      socket.onclose = () => {
        clearPing();
        if (stopped) return;
        callbacks.onStatus("DISCONNECTED", "SiftingIO stream disconnected; retrying.");
        reconnectTimer = setTimeout(open, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      };
    };

    open();
    return {
      close: () => {
        stopped = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        clearPing();
        socket?.close();
        socket = null;
      },
    };
  }

  async loadCandles(
    instrumentId: string,
    timeframe: string,
    limit: number,
  ): Promise<readonly HistoricalCandle[]> {
    if (instrumentId !== "XAUUSD" || !(timeframe in TIMEFRAME_SECONDS)) {
      throw new Error("SiftingIO candle history supports XAUUSD on 5m, 15m, 1h and 4h.");
    }

    const sourceTimeframe = timeframe === "4h" ? "1h" : timeframe;
    const sourceSeconds = TIMEFRAME_SECONDS[sourceTimeframe];
    const sourceLimit = Math.min(2_000, Math.max(45, limit * (timeframe === "4h" ? 4 : 1) + 8));
    const now = Date.now();
    const start = new Date(now - sourceSeconds * sourceLimit * 2_000).toISOString();
    const end = new Date(now).toISOString();

    const url = new URL("https://api.sifting.io/v1/hist/commodities/XAUUSD/bars");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("interval", sourceTimeframe);
    url.searchParams.set("limit", String(sourceLimit));
    url.searchParams.set("order", "desc");

    const response = await fetch(url, {
      headers: {
        "X-API-Key": this.apiKey,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("SiftingIO candle history returned HTTP " + response.status + ".");

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error("SiftingIO returned an invalid candle history payload.");
    }

    const hourlyOrNative = (payload as { data: unknown[] }).data
      .map((row) => normalizeCandle(row, sourceSeconds, now))
      .filter((bar): bar is HistoricalCandle => bar !== null)
      .sort((a, b) => a.time - b.time);

    const candles = timeframe === "4h"
      ? aggregateFourHourCandles(hourlyOrNative, now)
      : hourlyOrNative;
    if (!candles.length) throw new Error("SiftingIO returned no valid XAUUSD candles for this timeframe.");
    return candles;
  }
}
