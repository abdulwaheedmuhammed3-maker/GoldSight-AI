import type { CanonicalQuote, QuotePersistence } from "./types";
import type { CandlePersistence, HistoricalCandle } from "./feed-adapter";

const DATABASE_NAME = "tradesight-v2-market-data";
const DATABASE_VERSION = 2;
const QUOTE_STORE = "quotes";
const CANDLE_STORE = "candles";

interface StoredCandleSet {
  key: string;
  instrumentId: string;
  providerId: string;
  timeframe: string;
  candles: readonly HistoricalCandle[];
  savedAt: number;
}

/** IndexedDB persistence for the web/PWA shell and Capacitor WebView. */
export class IndexedDbQuotePersistence implements QuotePersistence, CandlePersistence {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("IndexedDB is unavailable in this runtime."));
    }
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(QUOTE_STORE)) {
          database.createObjectStore(QUOTE_STORE, { keyPath: "instrumentId" });
        }
        if (!database.objectStoreNames.contains(CANDLE_STORE)) {
          database.createObjectStore(CANDLE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open local market-data storage."));
      request.onblocked = () => reject(new Error("Local market-data storage upgrade is blocked by another app tab."));
    });
    return this.databasePromise;
  }

  async loadAll(): Promise<readonly CanonicalQuote[]> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(QUOTE_STORE, "readonly");
      const request = transaction.objectStore(QUOTE_STORE).getAll();
      request.onsuccess = () => resolve(request.result as CanonicalQuote[]);
      request.onerror = () => reject(request.error ?? new Error("Could not load cached quotes."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Quote read transaction aborted."));
    });
  }

  async save(quote: CanonicalQuote): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(QUOTE_STORE, "readwrite");
      transaction.objectStore(QUOTE_STORE).put({ ...quote });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save cached quote."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Quote write transaction aborted."));
    });
  }

  async loadCandles(instrumentId: string, timeframe: string, providerId: string): Promise<readonly HistoricalCandle[]> {
    const database = await this.openDatabase();
    const key = instrumentId + ":" + timeframe + ":" + providerId;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(CANDLE_STORE, "readonly");
      const request = transaction.objectStore(CANDLE_STORE).get(key);
      request.onsuccess = () => {
        const stored = request.result as StoredCandleSet | undefined;
        resolve(Array.isArray(stored?.candles) ? stored.candles : []);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not load cached candle history."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Candle read transaction aborted."));
    });
  }

  async saveCandles(
    instrumentId: string,
    timeframe: string,
    providerId: string,
    candles: readonly HistoricalCandle[],
  ): Promise<void> {
    const database = await this.openDatabase();
    const key = instrumentId + ":" + timeframe + ":" + providerId;
    const record: StoredCandleSet = {
      key,
      instrumentId,
      timeframe,
      providerId,
      candles: candles.slice(-1_000).map((candle) => ({ ...candle, closed: true })),
      savedAt: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(CANDLE_STORE, "readwrite");
      transaction.objectStore(CANDLE_STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save candle history."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Candle write transaction aborted."));
    });
  }
}
