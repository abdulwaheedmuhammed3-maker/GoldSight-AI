import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { IndexedDbQuotePersistence } from "./indexeddb-quote-persistence";
import { MarketDataEngine } from "./market-data-engine";
import { QuoteStore } from "./quote-store";
import { isSnapshotQuote } from "./types";
import { OutcomeMonitor } from "../signals/outcome-monitor";
import { DeviceOutcomeNotification } from "../signals/notification-service";
import { SignalScanner } from "../signals/signal-scanner";
import { SiftingIoAdapter } from "./siftingio-adapter";
import {
  FEED_SELECTION_STORAGE_KEY,
  orderFeedSymbolsByPriority,
} from "./feed-preferences";
import { readSiftingIoCredential } from "./secure-credentials";
import { SIFTING_IO_INSTRUMENTS, type SiftingIoInstrument } from "./instrument-catalog";
export { SIFTING_IO_INSTRUMENTS } from "./instrument-catalog";
export type { SiftingIoInstrument } from "./instrument-catalog";

const DEFAULT_SIFTING_IO_SELECTION: SiftingIoInstrument[] = [
  "XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD",
];

function readSavedSiftingIoSelection(): SiftingIoInstrument[] {
  if (typeof localStorage === "undefined") return [...DEFAULT_SIFTING_IO_SELECTION];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FEED_SELECTION_STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [...DEFAULT_SIFTING_IO_SELECTION];
    const valid = parsed.filter((value): value is SiftingIoInstrument =>
      typeof value === "string" && SIFTING_IO_INSTRUMENTS.includes(value as SiftingIoInstrument),
    );
    return valid.length > 0
      ? [...new Set(valid)].slice(0, 5)
      : [...DEFAULT_SIFTING_IO_SELECTION];
  } catch {
    return [...DEFAULT_SIFTING_IO_SELECTION];
  }
}

const persistence = typeof indexedDB === "undefined"
  ? undefined
  : new IndexedDbQuotePersistence();

export const quoteStore = new QuoteStore({
  maxAgeMs: (instrumentId, provider) => {
    if (provider === "Binance Spot" && instrumentId === "BTCUSD") return 5_000;
    if (provider === "SiftingIO Market Data") return 30_000;
    return 15_000;
  },
  persistence,
});

export const marketEngine = new MarketDataEngine(quoteStore, persistence);
marketEngine.registerAdapter(new BinanceSpotAdapter());

export const outcomeMonitor = new OutcomeMonitor({
  persistence,
  notification: new DeviceOutcomeNotification(),
  maxQuoteAgeMs: (instrumentId, provider) => {
    if (provider === "Binance Spot" && instrumentId === "BTCUSD") return 5_000;
    if (provider === "SiftingIO Market Data") return 30_000;
    return 15_000;
  },
});

marketEngine.addQuoteObserver((quote) => {
  if (isSnapshotQuote(quote)) return;
  outcomeMonitor.ingestQuote(quote, quote.receivedTimeMs);
});

export const signalScanner = new SignalScanner(marketEngine, quoteStore, outcomeMonitor);
signalScanner.start();

/** Replace the SiftingIO adapter and connect the user's selected instruments only. */
export function connectSiftingIoFeeds(apiKey: string, selectedSymbols: readonly string[]): void {
  const validSelection = selectedSymbols.filter((symbol): symbol is SiftingIoInstrument =>
    (SIFTING_IO_INSTRUMENTS as readonly string[]).includes(symbol),
  );
  marketEngine.unregisterAdapter("SiftingIO Market Data");
  const adapter = new SiftingIoAdapter(apiKey, validSelection);
  marketEngine.registerAdapter(adapter);

  const connectionOrder = orderFeedSymbolsByPriority(
    validSelection,
    validSelection,
  );
  for (const symbol of connectionOrder) {
    marketEngine.connect(symbol, adapter.providerId);
  }
}

/** A deliberate disconnect also prevents automatic reconnect on the next app launch. */
export function disconnectSiftingIoFeeds(): void {
  marketEngine.unregisterAdapter("SiftingIO Market Data");
}

let startup: Promise<void> | null = null;

export function startMarketDataRuntime(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    try {
      await quoteStore.hydrate();
    } catch (error) {
      console.error("TradeSight could not restore cached quotes", error);
    }

    try {
      await marketEngine.hydrateCachedHistory([
        { instrumentId: "BTCUSD", providerId: "Binance Spot" },
        ...SIFTING_IO_INSTRUMENTS.map((instrumentId) => ({
          instrumentId,
          providerId: "SiftingIO Market Data",
        })),
      ]);
    } catch (error) {
      console.error("TradeSight could not restore cached candle history", error);
    }

    try {
      await outcomeMonitor.hydrate();
    } catch (error) {
      console.error("TradeSight could not restore saved setup outcomes", error);
    }

    marketEngine.connect("BTCUSD", "Binance Spot");

    // The key is retrieved only from Android Keystore-backed storage.
    // Browser/PWA sessions intentionally do not persist this credential.
    try {
      const savedKey = await readSiftingIoCredential();
      if (savedKey) {
        connectSiftingIoFeeds(savedKey, readSavedSiftingIoSelection());
        console.info("TradeSight restored the saved SiftingIO feed connection.");
      }
    } catch (error) {
      console.warn("TradeSight could not restore the saved SiftingIO connection.", error);
    }
  })();
  return startup;
}
