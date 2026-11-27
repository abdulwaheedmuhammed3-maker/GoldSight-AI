import type { CanonicalQuote } from "./types";
import type { FeedCallbacks, FeedConnection, HistoricalCandle, MarketFeedAdapter } from "./feed-adapter";

interface BinanceTickerMessage {
  e?: string;
  E?: number;
  s?: string;
  c?: string;
  b?: string;
  a?: string;
  L?: number;
}

const SYMBOLS: Record<string, string> = { BTCUSD: "BTCUSDT" };
const DIGITS = 2;

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function sourceDigits(value: string): number {
  const decimal = value.indexOf(".");
  return decimal < 0 ? 0 : Math.min(12, value.length - decimal - 1);
}

export function normalizeBinanceTicker(
  instrumentId: string,
  message: BinanceTickerMessage,
  receivedTimeMs: number,
): CanonicalQuote | null {
  const providerSymbol = SYMBOLS[instrumentId];
  if (!providerSymbol || message.e !== "24hrTicker" || message.s !== providerSymbol) return null;
  const price = parsePrice(message.c);
  const bid = parsePrice(message.b);
  const ask = parsePrice(message.a);
  const sourceTimeMs = message.E;

  if (!price || !bid || !ask || ask < bid ||
      typeof sourceTimeMs !== "number" || !Number.isSafeInteger(sourceTimeMs) ||
      sourceTimeMs <= 0 || sourceTimeMs > receivedTimeMs + 5_000) {
    return null;
  }

  return Object.freeze({
    instrumentId,
    provider: "Binance Spot WebSocket",
    providerSymbol,
    priceBasis: "last",
    price,
    bid,
    ask,
    last: price,
    sourceTimeMs,
    receivedTimeMs,
    sequence: Number.isSafeInteger(message.L) && Number(message.L) >= 0 ? Number(message.L) : null,
    digits: Math.max(DIGITS, sourceDigits(message.c ?? "")),
  });
}

function normalizeHistoryRow(row: unknown): HistoricalCandle | null {
  if (!Array.isArray(row) || row.length < 7) return null;
  const [rawTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume, rawCloseTime] = row;
  const timeMs = Number(rawTime);
  const closeTime = Number(rawCloseTime);
  const open = parsePrice(String(rawOpen));
  const high = parsePrice(String(rawHigh));
  const low = parsePrice(String(rawLow));
  const close = parsePrice(String(rawClose));
  const volume = Number(rawVolume);
  const now = Date.now();

  if (!Number.isSafeInteger(timeMs) || !Number.isSafeInteger(closeTime) ||
      timeMs <= 0 || closeTime >= now || !open || !high || !low || !close ||
      !Number.isFinite(volume) || volume < 0 ||
      high < Math.max(open, close, low) || low > Math.min(open, close)) {
    return null;
  }
  return {
    time: Math.floor(timeMs / 1_000),
    open,
    high,
    low,
    close,
    volume,
    closed: closeTime < now,
  };
}

/**
 * Public BTCUSDT spot stream. Binance updates its 24-hour ticker stream once
 * per second; each accepted event exposes last, best bid, best ask and event time.
 */
export class BinanceSpotAdapter implements MarketFeedAdapter {
  readonly providerId = "Binance Spot WebSocket";
  readonly supportedInstrumentIds = ["BTCUSD"] as const;

  connect(instrumentId: string, callbacks: FeedCallbacks): FeedConnection {
    const providerSymbol = SYMBOLS[instrumentId];
    let socket: WebSocket | null = null;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelayMs = 1_000;

    const open = () => {
      if (stopped) return;
      callbacks.onStatus("CONNECTING");
      socket = new WebSocket(
        `wss://stream.binance.com:9443/ws/${providerSymbol.toLowerCase()}@ticker`,
      );

      socket.onopen = () => {
        retryDelayMs = 1_000;
        callbacks.onStatus("CONNECTED");
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (!parsed || typeof parsed !== "object") return;
          const quote = normalizeBinanceTicker(
            instrumentId,
            parsed as BinanceTickerMessage,
            Date.now(),
          );
          if (quote) callbacks.onQuote(quote);
        } catch {
          // A malformed provider frame is ignored; last-known-good quote is retained.
        }
      };

      socket.onerror = () => callbacks.onStatus("ERROR", "Binance stream error; retrying automatically.");
      socket.onclose = () => {
        if (stopped) return;
        callbacks.onStatus("DISCONNECTED", "Binance stream disconnected; reconnecting.");
        retryTimer = setTimeout(open, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      };
    };

    open();
    return {
      close: () => {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
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
    const providerSymbol = SYMBOLS[instrumentId];
    const interval = timeframe.toLowerCase();
    if (!providerSymbol || !["5m", "15m", "1h", "4h"].includes(interval)) {
      throw new Error("Binance candle history does not support this instrument/timeframe.");
    }

    const hosts = ["https://data-api.binance.vision", "https://api.binance.com"];
    let lastError: unknown = null;
    for (const host of hosts) {
      try {
        const url = new URL("/api/v3/klines", host);
        url.searchParams.set("symbol", providerSymbol);
        url.searchParams.set("interval", interval);
        url.searchParams.set("limit", String(Math.min(1_000, Math.max(1, Math.trunc(limit)))));
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Binance history returned HTTP ${response.status}.`);
        const body: unknown = await response.json();
        if (!Array.isArray(body)) throw new Error("Binance returned an invalid candle history payload.");
        const candles = body
          .map(normalizeHistoryRow)
          .filter((item): item is HistoricalCandle => item !== null)
          .sort((a, b) => a.time - b.time);
        if (!candles.length) throw new Error("Binance returned no completed valid candles.");
        return candles;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Binance candle history is unavailable.");
  }
}
