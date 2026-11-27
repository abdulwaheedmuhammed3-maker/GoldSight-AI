import type { CanonicalQuote, QuotePersistence } from "./types";

const DATABASE_NAME = "tradesight-v2-market-data";
const DATABASE_VERSION = 1;
const QUOTE_STORE = "quotes";

/** IndexedDB persistence for the web/PWA shell and Capacitor WebView. */
export class IndexedDbQuotePersistence implements QuotePersistence {
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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open local quote storage."));
      request.onblocked = () => reject(new Error("Local quote storage upgrade is blocked by another app tab."));
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
}
