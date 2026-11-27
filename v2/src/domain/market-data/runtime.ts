import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { IndexedDbQuotePersistence } from "./indexeddb-quote-persistence";
import { MarketDataEngine } from "./market-data-engine";
import { QuoteStore } from "./quote-store";

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

let startup: Promise<void> | null = null;

export function startMarketDataRuntime(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    try {
      await quoteStore.hydrate();
      await marketEngine.hydrateCachedHistory([
        "XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY",
        "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
      ]);
    } catch (error) {
      // An IndexedDB problem must not prevent online feeds from starting.
      console.error("TradeSight could not restore local quote cache", error);
    }
    marketEngine.connect("BTCUSD", "Binance Spot WebSocket");
  })();
  return startup;
}
