export type JournalSide = "BUY" | "SELL";
export type JournalOutcome = "WIN" | "LOSS" | "BREAKEVEN";
export type JournalTimeframe = "5m" | "15m" | "1h" | "4h";

export interface TradeJournalDraft {
  readonly instrumentId: string;
  readonly side: JournalSide;
  readonly timeframe: JournalTimeframe;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly stopLoss: number;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly notes: string;
  readonly source?: "MANUAL" | "SIGNAL";
  readonly signalId?: string | null;
}

export interface TradeJournalRecord extends TradeJournalDraft {
  readonly id: string;
  readonly riskDistance: number;
  readonly resultR: number;
  readonly outcome: JournalOutcome;
  readonly createdAtMs: number;
  readonly source: "MANUAL" | "SIGNAL";
  readonly signalId: string | null;
}

export interface TradeJournalRepository {
  list(): Promise<readonly TradeJournalRecord[]>;
  save(record: TradeJournalRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

const DB_NAME = "tradesight-v2-journal";
const DB_VERSION = 1;
const STORE_NAME = "trades";

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function createTradeJournalRecord(
  draft: TradeJournalDraft,
  options: { id?: string; nowMs?: number } = {},
): TradeJournalRecord {
  const instrumentId = draft.instrumentId.trim().toUpperCase();
  if (!/^[A-Z0-9._-]{3,20}$/.test(instrumentId)) {
    throw new Error("Choose a valid instrument.");
  }
  if (!["BUY", "SELL"].includes(draft.side)) {
    throw new Error("Choose BUY or SELL.");
  }
  if (!["5m", "15m", "1h", "4h"].includes(draft.timeframe)) {
    throw new Error("Choose a supported timeframe.");
  }
  if (![draft.entryPrice, draft.exitPrice, draft.stopLoss].every(positiveFinite)) {
    throw new Error("Entry, exit and stop-loss prices must be positive numbers.");
  }
  if (!Number.isFinite(draft.openedAtMs) || !Number.isFinite(draft.closedAtMs) ||
      draft.openedAtMs <= 0 || draft.closedAtMs < draft.openedAtMs) {
    throw new Error("The close time must be after the opening time.");
  }

  const riskDistance = Math.abs(draft.entryPrice - draft.stopLoss);
  if (!positiveFinite(riskDistance)) {
    throw new Error("Entry and stop-loss must be different.");
  }
  if (draft.side === "BUY" && draft.stopLoss >= draft.entryPrice) {
    throw new Error("For a BUY trade, stop-loss must be below entry.");
  }
  if (draft.side === "SELL" && draft.stopLoss <= draft.entryPrice) {
    throw new Error("For a SELL trade, stop-loss must be above entry.");
  }

  const signedMove = draft.side === "BUY"
    ? draft.exitPrice - draft.entryPrice
    : draft.entryPrice - draft.exitPrice;
  const resultR = signedMove / riskDistance;
  if (!Number.isFinite(resultR)) {
    throw new Error("The calculated R result is invalid.");
  }

  const id = options.id ?? (
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "trade-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );

  return Object.freeze({
    ...draft,
    id,
    instrumentId,
    notes: draft.notes.trim().slice(0, 2_000),
    riskDistance,
    resultR,
    outcome: resultR > 1e-9 ? "WIN" : resultR < -1e-9 ? "LOSS" : "BREAKEVEN",
    createdAtMs: options.nowMs ?? Date.now(),
    source: draft.source ?? "MANUAL",
    signalId: draft.signalId ?? null,
  });
}

export class IndexedDbTradeJournalRepository implements TradeJournalRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("Local trade storage is unavailable in this browser."));
    }
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("closedAtMs", "closedAtMs", { unique: false });
          store.createIndex("instrumentId", "instrumentId", { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open local trade storage."));
      request.onblocked = () => reject(new Error("Close other TradeSight tabs to finish the journal storage update."));
    });
    return this.databasePromise;
  }

  async list(): Promise<readonly TradeJournalRecord[]> {
    const db = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const records = (request.result as TradeJournalRecord[])
          .filter((record) => record && typeof record.id === "string" &&
            positiveFinite(record.entryPrice) && positiveFinite(record.exitPrice) &&
            Number.isFinite(record.resultR))
          .sort((a, b) => b.closedAtMs - a.closedAtMs);
        resolve(records);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not load trade journal."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Trade journal read was interrupted."));
    });
  }

  async save(record: TradeJournalRecord): Promise<void> {
    const db = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ ...record });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save this trade."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Trade save was interrupted."));
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete this trade."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Trade deletion was interrupted."));
    });
  }
}

export const tradeJournalRepository = new IndexedDbTradeJournalRepository();
