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

/** Binance documents both the market-data-only host and stream.binance.com.
 * Port 443 is tried before 9443 because some mobile networks restrict 9443.
 */
export function buildBinanceWebSocketUrls(instrumentId: string): string[] {
  const providerSymbol = SYMBOLS[instrumentId];
  if (!providerSymbol) return [];
  const stream = providerSymbol.toLowerCase() + "@ticker";
  return [
    "wss://data-stream.binance.vision/ws/" + stream,
    "wss://stream.binance.com:443/ws/" + stream,
    "wss://stream.binance.com:9443/ws/" + stream,
  ];
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function sourceDigits(value: string): number {
  const decimal = value.indexOf(".");
  return decimal < 0 ? 0 : Math.min(12, value.length - decimal - 1);
}

interface BinanceRestTicker {
  symbol?: string;
  lastPrice?: string;
  bidPrice?: string;
  askPrice?: string;
  closeTime?: number;
}

export function normalizeBinanceRestTicker(
  instrumentId: string,
  message: BinanceRestTicker,
  receivedTimeMs: number,
): CanonicalQuote | null {
  const providerSymbol = SYMBOLS[instrumentId];
  if (!providerSymbol || message.symbol !== providerSymbol) return null;
  const price = parsePrice(message.lastPrice);
  const bid = parsePrice(message.bidPrice);
  const ask = parsePrice(message.askPrice);
  const sourceTimeMs = message.closeTime;

  if (
    !price || !bid || !ask || ask < bid ||
    typeof sourceTimeMs !== "number" || !Number.isSafeInteger(sourceTimeMs) ||
    sourceTimeMs <= 0 || sourceTimeMs > receivedTimeMs + 5_000 ||
    receivedTimeMs - sourceTimeMs > 30_000
  ) return null;

  return Object.freeze({
    instrumentId,
    provider: "Binance Spot",
    providerSymbol,
    transport: "REST_SNAPSHOT",
    priceBasis: "last",
    price,
    bid,
    ask,
    last: price,
    sourceTimeMs,
    receivedTimeMs,
    sequence: null,
    digits: Math.max(DIGITS, sourceDigits(message.lastPrice ?? "")),
  });
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
    provider: "Binance Spot",
    providerSymbol,
    transport: "WEBSOCKET",
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
 * Public BTCUSDT spot data. WebSocket is preferred; a public REST 24-hour
 * ticker snapshot is polled while the stream is unavailable.
 */
export class BinanceSpotAdapter implements MarketFeedAdapter {
  readonly providerId = "Binance Spot";
  readonly supportedInstrumentIds = ["BTCUSD"] as const;

  connect(instrumentId: string, callbacks: FeedCallbacks): FeedConnection {
    const urls = buildBinanceWebSocketUrls(instrumentId);
    const providerSymbol = SYMBOLS[instrumentId];
    if (urls.length === 0 || !providerSymbol) {
      callbacks.onStatus("ERROR", "Binance Spot does not support this instrument.");
      return { close: () => undefined };
    }

    let socket: WebSocket | null = null;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let restPollTimer: ReturnType<typeof setInterval> | null = null;
    let restRequest: AbortController | null = null;
    let retryDelayMs = 1_000;
    let endpointIndex = 0;
    let lastValidTickAt = 0;

    const clearAttemptTimers = () => {
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (watchdogTimer !== null) clearInterval(watchdogTimer);
      connectTimer = null;
      watchdogTimer = null;
    };

    const pollRestQuote = async () => {
      if (stopped || restRequest) return;
      const controller = new AbortController();
      restRequest = controller;

      try {
        const hosts = ["https://data-api.binance.vision", "https://api.binance.com"];
        for (const host of hosts) {
          if (stopped || controller.signal.aborted) return;
          try {
            const url = new URL("/api/v3/ticker/24hr", host);
            url.searchParams.set("symbol", providerSymbol);
            const response = await fetch(url, {
              headers: { Accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok) throw new Error("Binance REST quote returned HTTP " + response.status + ".");
            const payload: unknown = await response.json();
            if (!payload || typeof payload !== "object") throw new Error("Binance returned an invalid ticker snapshot.");
            const quote = normalizeBinanceRestTicker(instrumentId, payload as BinanceRestTicker, Date.now());
            if (!quote) throw new Error("Binance returned an invalid or stale BTC ticker snapshot.");
            if (stopped || controller.signal.aborted) return;
            callbacks.onQuote(quote);
            callbacks.onStatus("CONNECTED", "BTC spot reference snapshot supplied by Binance REST fallback.");
            return;
          } catch (error) {
            if (controller.signal.aborted) return;
            if (host === hosts[hosts.length - 1]) {
              callbacks.onStatus(
                "ERROR",
                error instanceof Error ? error.message : "Binance REST fallback is unavailable.",
              );
            }
          }
        }
      } finally {
        if (restRequest === controller) restRequest = null;
      }
    };

    const startRestFallback = () => {
      if (stopped || restPollTimer !== null) return;
      callbacks.onStatus("CONNECTING", "Loading a public BTC price snapshot while the live stream connects.");
      void pollRestQuote();
      restPollTimer = setInterval(() => void pollRestQuote(), 4_000);
    };

    const stopRestFallback = () => {
      if (restPollTimer !== null) clearInterval(restPollTimer);
      restPollTimer = null;
      restRequest?.abort();
      restRequest = null;
    };

    const open = () => {
      if (stopped || socket) return;
      const url = urls[endpointIndex];
      let opened = false;
      callbacks.onStatus(
        "CONNECTING",
        "Connecting to Binance public BTC spot feed via " + new URL(url).hostname + ".",
      );

      let attempt: WebSocket;
      try {
        attempt = new WebSocket(url);
      } catch (error) {
        endpointIndex = (endpointIndex + 1) % urls.length;
        callbacks.onStatus("ERROR", error instanceof Error ? error.message : "Could not create Binance WebSocket.");
        retryTimer = setTimeout(open, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        startRestFallback();
        return;
      }
      socket = attempt;

      connectTimer = setTimeout(() => {
        if (!opened && attempt.readyState === WebSocket.CONNECTING) {
          callbacks.onStatus("ERROR", "Binance connection timed out; trying another public endpoint.");
          attempt.close();
        }
      }, 10_000);

      watchdogTimer = setInterval(() => {
        if (attempt.readyState === WebSocket.OPEN &&
            lastValidTickAt > 0 &&
            Date.now() - lastValidTickAt > 15_000) {
          callbacks.onStatus("ERROR", "Binance stream stopped sending valid BTC ticks; reconnecting.");
          attempt.close();
        }
      }, 5_000);

      attempt.onopen = () => {
        opened = true;
        if (connectTimer !== null) clearTimeout(connectTimer);
        connectTimer = null;
        retryDelayMs = 1_000;
        lastValidTickAt = Date.now();
        callbacks.onStatus("CONNECTED", "Connected to Binance public spot stream.");
      };

      attempt.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (!parsed || typeof parsed !== "object") return;
          const quote = normalizeBinanceTicker(
            instrumentId,
            parsed as BinanceTickerMessage,
            Date.now(),
          );
          if (!quote) return;
          lastValidTickAt = Date.now();
          stopRestFallback();
          callbacks.onQuote(quote);
          callbacks.onStatus("CONNECTED", "Live BTC spot price supplied by Binance WebSocket.");
        } catch {
          // A malformed provider frame is ignored; last-known-good quote is retained.
        }
      };

      attempt.onerror = () => {
        callbacks.onStatus("ERROR", "Binance endpoint failed; TradeSight will try an alternate public endpoint.");
        try { attempt.close(); } catch { /* onclose performs failover */ }
      };

      attempt.onclose = () => {
        clearAttemptTimers();
        if (socket === attempt) socket = null;
        if (stopped) return;
        endpointIndex = (endpointIndex + 1) % urls.length;
        callbacks.onStatus(
          "DISCONNECTED",
          "Binance disconnected. Retrying through " + new URL(urls[endpointIndex]).hostname + ".",
        );
        startRestFallback();
        retryTimer = setTimeout(open, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      };
    };

    open();
    startRestFallback();

    return {
      close: () => {
        stopped = true;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        stopRestFallback();
        clearAttemptTimers();
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
