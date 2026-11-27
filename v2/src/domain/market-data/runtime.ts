import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { IndexedDbQuotePersistence } from "./indexeddb-quote-persistence";
import { MarketDataEngine } from "./market-data-engine";
import { QuoteStore } from "./quote-store";
import { OutcomeMonitor } from "../signals/outcome-monitor";
import { DeviceOutcomeNotification } from "../signals/notification-service";

const persistence = typeof indexedDB === "undefined"
  ? undefined
  : new IndexedDbQuotePersistence();

export const quoteStore = new QuoteStore({
  maxAgeMs: (instrumentId, provider) => {
    if (provider === "Binance Spot WebSocket" && instrumentId === "BTCUSD") return 5_000;
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
    if (provider === "Binance Spot WebSocket" && instrumentId === "BTCUSD") return 5_000;
    if (provider === "SiftingIO WebSocket" && instrumentId === "XAUUSD") return 30_000;
    return 15_000;
  },
});

marketEngine.addQuoteObserver((quote) => {
  outcomeMonitor.ingestQuote(quote, quote.receivedTimeMs);
});

let startup: Promise<void> | null = null;

export function startMarketDataRuntime(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    try {
      await quoteStore.hydrate();
      await marketEngine.hydrateCachedHistory([
        { instrumentId: "BTCUSD", providerId: "Binance Spot WebSocket" },
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
      await outcomeMonitor.hydrate();
    } catch (error) {
      // An IndexedDB problem must not prevent online feeds from starting.
      console.error("TradeSight could not restore local quote cache", error);
    }
    marketEngine.connect("BTCUSD", "Binance Spot WebSocket");
  })();
  return startup;
}
