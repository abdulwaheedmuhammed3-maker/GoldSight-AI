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
  MAX_FREE_LIVE_SUBSCRIPTIONS,
  readSelectedSiftingIoSymbols,
} from "./feed-preferences";
import { readSiftingIoCredential } from "./secure-credentials";
import { SIFTING_IO_INSTRUMENTS, type SiftingIoInstrument } from "./instrument-catalog";
export { SIFTING_IO_INSTRUMENTS };
export type { SiftingIoInstrument };

function readSavedSiftingIoSelection(): SiftingIoInstrument[] {
  return readSelectedSiftingIoSymbols();
}

/** The symbols used by the currently applied SiftingIO connection, not just saved preferences. */
export const FEED_CONNECTION_CHANGED_EVENT = "tradesight:feed-connection-changed";
let appliedSiftingIoSymbols: SiftingIoInstrument[] = [];

export function getAppliedSiftingIoSymbols(): SiftingIoInstrument[] {
  return [...appliedSiftingIoSymbols];
}

function announceFeedConnectionChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FEED_CONNECTION_CHANGED_EVENT));
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
  const validSelection = selectedSymbols
    .filter((symbol): symbol is SiftingIoInstrument =>
      (SIFTING_IO_INSTRUMENTS as readonly string[]).includes(symbol),
    )
    .slice(0, MAX_FREE_LIVE_SUBSCRIPTIONS);
  marketEngine.unregisterAdapter("SiftingIO Market Data");
  const adapter = new SiftingIoAdapter(apiKey, validSelection);
  marketEngine.registerAdapter(adapter);

  const connectionOrder = validSelection;
  appliedSiftingIoSymbols = [...validSelection];
  for (const symbol of connectionOrder) {
    marketEngine.connect(symbol, adapter.providerId);
  }
  announceFeedConnectionChanged();
}

/** A deliberate disconnect also prevents automatic reconnect on the next app launch. */
export function disconnectSiftingIoFeeds(): void {
  marketEngine.unregisterAdapter("SiftingIO Market Data");
  appliedSiftingIoSymbols = [];
  announceFeedConnectionChanged();
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
