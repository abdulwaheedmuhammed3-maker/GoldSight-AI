import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { IndexedDbQuotePersistence } from "./indexeddb-quote-persistence";
import { MarketDataEngine } from "./market-data-engine";
import { QuoteStore } from "./quote-store";
import { OutcomeMonitor } from "../signals/outcome-monitor";
import { DeviceOutcomeNotification } from "../signals/notification-service";
import { SignalScanner } from "../signals/signal-scanner";

const persistence = typeof indexedDB === "undefined"
  ? undefined
  : new IndexedDbQuotePersistence();

export const quoteStore = new QuoteStore({
  maxAgeMs: (instrumentId, provider) => {
    if (provider === "Binance Spot" && instrumentId === "BTCUSD") return 5_000;
    if (provider === "SiftingIO WebSocket" && instrumentId === "XAUUSD") return 30_000;
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
    if (provider === "SiftingIO WebSocket" && instrumentId === "XAUUSD") return 30_000;
    return 15_000;
  },
});

marketEngine.addQuoteObserver((quote) => {
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
        { instrumentId: "XAUUSD", providerId: "SiftingIO WebSocket" },
        { instrumentId: "EURUSD", providerId: "SiftingIO WebSocket" },
        { instrumentId: "GBPUSD", providerId: "SiftingIO WebSocket" },
        { instrumentId: "USDJPY", providerId: "SiftingIO WebSocket" },
        { instrumentId: "AUDUSD", providerId: "SiftingIO WebSocket" },
        { instrumentId: "USDCAD", providerId: "SiftingIO WebSocket" },
        { instrumentId: "USDCHF", providerId: "SiftingIO WebSocket" },
        { instrumentId: "NZDUSD", providerId: "SiftingIO WebSocket" },
        { instrumentId: "EURGBP", providerId: "SiftingIO WebSocket" },
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
