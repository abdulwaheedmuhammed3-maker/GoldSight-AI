import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { IndexedDbQuotePersistence } from "./indexeddb-quote-persistence";
import { MarketDataEngine } from "./market-data-engine";
import { QuoteStore } from "./quote-store";
import { isSnapshotQuote } from "./types";
import { OutcomeMonitor } from "../signals/outcome-monitor";
import { DeviceOutcomeNotification } from "../signals/notification-service";
import { SignalScanner } from "../signals/signal-scanner";

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
        { instrumentId: "XAUUSD", providerId: "SiftingIO Market Data" },
        { instrumentId: "EURUSD", providerId: "SiftingIO Market Data" },
        { instrumentId: "GBPUSD", providerId: "SiftingIO Market Data" },
        { instrumentId: "USDJPY", providerId: "SiftingIO Market Data" },
        { instrumentId: "AUDUSD", providerId: "SiftingIO Market Data" },
        { instrumentId: "USDCAD", providerId: "SiftingIO Market Data" },
        { instrumentId: "USDCHF", providerId: "SiftingIO Market Data" },
        { instrumentId: "NZDUSD", providerId: "SiftingIO Market Data" },
        { instrumentId: "EURGBP", providerId: "SiftingIO Market Data" },
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
  })();
  return startup;
}
