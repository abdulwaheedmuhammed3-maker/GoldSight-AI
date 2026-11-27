import type { CanonicalQuote, QuotePersistence } from "./types";
import type { CandlePersistence, HistoricalCandle, OutcomePersistence } from "./feed-adapter";
import type { OutcomeEvent, SetupOutcome } from "../signals/outcome-monitor";

const DATABASE_NAME = "tradesight-v2-market-data";
const DATABASE_VERSION = 3;
const QUOTE_STORE = "quotes";
const CANDLE_STORE = "candles";
const SETUP_STORE = "setups";
const OUTCOME_EVENT_STORE = "outcomeEvents";

interface StoredCandleSet {
  key: string;
  instrumentId: string;
  providerId: string;
  timeframe: string;
  candles: readonly HistoricalCandle[];
  savedAt: number;
}

/** IndexedDB persistence for the web/PWA shell and Capacitor WebView. */
export class IndexedDbQuotePersistence implements QuotePersistence, CandlePersistence, OutcomePersistence {
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
        if (!database.objectStoreNames.contains(SETUP_STORE)) {
          database.createObjectStore(SETUP_STORE, { keyPath: "signal.id" });
        }
        if (!database.objectStoreNames.contains(OUTCOME_EVENT_STORE)) {
          database.createObjectStore(OUTCOME_EVENT_STORE, { keyPath: "id" });
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

  async loadSetups(): Promise<readonly SetupOutcome[]> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SETUP_STORE, "readonly");
      const request = transaction.objectStore(SETUP_STORE).getAll();
      request.onsuccess = () => resolve(request.result as SetupOutcome[]);
      request.onerror = () => reject(request.error ?? new Error("Could not load saved setup outcomes."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Setup outcome read transaction aborted."));
    });
  }

  async saveSetup(setup: SetupOutcome): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SETUP_STORE, "readwrite");
      transaction.objectStore(SETUP_STORE).put({ ...setup });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save setup outcome."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Setup outcome write transaction aborted."));
    });
  }

  async loadEvents(): Promise<readonly OutcomeEvent[]> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTCOME_EVENT_STORE, "readonly");
      const request = transaction.objectStore(OUTCOME_EVENT_STORE).getAll();
      request.onsuccess = () => resolve(request.result as OutcomeEvent[]);
      request.onerror = () => reject(request.error ?? new Error("Could not load notification history."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Notification history read transaction aborted."));
    });
  }

  async appendEvent(event: OutcomeEvent): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTCOME_EVENT_STORE, "readwrite");
      // put() makes the event idempotent if a process retries after a crash.
      transaction.objectStore(OUTCOME_EVENT_STORE).put({ ...event });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not persist outcome event."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Outcome event transaction aborted."));
    });
  }
}
