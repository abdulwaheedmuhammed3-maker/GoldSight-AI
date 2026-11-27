import type { CanonicalQuote } from "../market-data/types";
import type { TradingSignal } from "./signal-engine";

export type OutcomeMilestone = "TP1" | "TP2" | "TP3" | "SL";
export type SetupOutcomeStatus = "ACTIVE" | "TP3_HIT" | "SL_HIT";

export interface SetupOutcome {
  readonly signal: TradingSignal;
  readonly status: SetupOutcomeStatus;
  readonly reachedTargets: readonly ("TP1" | "TP2" | "TP3")[];
  readonly lastEvaluatedSourceTimeMs: number;
  readonly createdAt: number;
  readonly closedAt: number | null;
}

export interface OutcomeEvent {
  readonly id: string;
  readonly setupId: string;
  readonly instrumentId: string;
  readonly side: "BUY" | "SELL";
  readonly milestone: OutcomeMilestone;
  readonly targetPrice: number;
  readonly observedPrice: number;
  readonly provider: string;
  readonly priceBasis: CanonicalQuote["priceBasis"];
  readonly sourceTimeMs: number;
  readonly receivedTimeMs: number;
}

export interface OutcomePersistence {
  loadSetups(): Promise<readonly SetupOutcome[]>;
  saveSetup(setup: SetupOutcome): Promise<void>;
  loadEvents(): Promise<readonly OutcomeEvent[]>;
  appendEvent(event: OutcomeEvent): Promise<void>;
}

export interface OutcomeNotification {
  notify(event: OutcomeEvent): Promise<void> | void;
}

export interface OutcomeMonitorOptions {
  readonly persistence?: OutcomePersistence;
  readonly notification?: OutcomeNotification;
  readonly now?: () => number;
  readonly maxQuoteAgeMs: (instrumentId: string, provider: string) => number;
}

export interface OutcomeMonitorSnapshot {
  readonly setups: readonly SetupOutcome[];
  readonly events: readonly OutcomeEvent[];
}

function validSignal(signal: TradingSignal): boolean {
  if (!signal.id || !signal.instrumentId || !signal.source) return false;
  if (!Number.isFinite(signal.quoteTimeMs) || !Number.isFinite(signal.entry) ||
      !Number.isFinite(signal.stopLoss)) return false;

  const { tp1, tp2, tp3 } = signal.takeProfits;
  if (![tp1, tp2, tp3].every((price) => Number.isFinite(price) && price > 0)) return false;

  if (signal.side === "BUY") {
    return signal.stopLoss < signal.entry &&
      signal.entry < tp1 && tp1 < tp2 && tp2 < tp3;
  }
  return signal.stopLoss > signal.entry &&
    signal.entry > tp1 && tp1 > tp2 && tp2 > tp3;
}

function targetFor(signal: TradingSignal, milestone: OutcomeMilestone): number {
  if (milestone === "SL") return signal.stopLoss;
  return signal.takeProfits[milestone.toLowerCase() as "tp1" | "tp2" | "tp3"];
}

/**
 * One outcome state machine per stored signal.
 * It consumes accepted canonical quotes, persists each milestone once, and
 * never evaluates a signal from another provider or a stale/future tick.
 */
export class OutcomeMonitor {
  private readonly setups = new Map<string, SetupOutcome>();
  private readonly events = new Map<string, OutcomeEvent>();
  private readonly listeners = new Set<(snapshot: OutcomeMonitorSnapshot) => void>();
  private readonly now: () => number;
  private readonly maxQuoteAgeMs: OutcomeMonitorOptions["maxQuoteAgeMs"];
  private readonly persistence?: OutcomePersistence;
  private readonly notification?: OutcomeNotification;

  constructor(options: OutcomeMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.maxQuoteAgeMs = options.maxQuoteAgeMs;
    this.persistence = options.persistence;
    this.notification = options.notification;
  }

  getSnapshot(): OutcomeMonitorSnapshot {
    return {
      setups: [...this.setups.values()].sort((a, b) => b.createdAt - a.createdAt),
      events: [...this.events.values()].sort((a, b) => b.sourceTimeMs - a.sourceTimeMs),
    };
  }

  subscribe(listener: (snapshot: OutcomeMonitorSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    const [setups, events] = await Promise.all([
      this.persistence.loadSetups(),
      this.persistence.loadEvents(),
    ]);
    for (const event of events) this.events.set(event.id, event);
    for (const setup of setups) {
      if (!validSignal(setup.signal)) continue;
      this.setups.set(setup.signal.id, setup);
    }
    this.publish();
  }

  register(signal: TradingSignal): boolean {
    if (!validSignal(signal) || this.setups.has(signal.id)) return false;
    const now = this.now();
    const setup: SetupOutcome = Object.freeze({
      signal,
      status: "ACTIVE",
      reachedTargets: [],
      lastEvaluatedSourceTimeMs: signal.quoteTimeMs,
      createdAt: now,
      closedAt: null,
    });
    this.setups.set(signal.id, setup);
    this.publish();
    if (this.persistence) {
      void this.persistence.saveSetup(setup).catch((error: unknown) => {
        console.error("TradeSight could not persist a new signal outcome", error);
      });
    }
    return true;
  }

  ingestQuote(quote: CanonicalQuote, receivedAtMs = this.now()): readonly OutcomeEvent[] {
    const age = receivedAtMs - quote.sourceTimeMs;
    if (
      !Number.isFinite(age) ||
      age < -5_000 ||
      age > this.maxQuoteAgeMs(quote.instrumentId, quote.provider) ||
      !Number.isFinite(quote.price) ||
      quote.price <= 0
    ) return [];

    const emitted: OutcomeEvent[] = [];
    for (const [setupId, current] of this.setups) {
      if (current.status !== "ACTIVE") continue;
      const signal = current.signal;
      if (
        signal.instrumentId !== quote.instrumentId ||
        signal.source !== quote.provider ||
        signal.priceBasis !== quote.priceBasis ||
        quote.sourceTimeMs <= signal.quoteTimeMs ||
        quote.sourceTimeMs <= current.lastEvaluatedSourceTimeMs
      ) continue;

      const nextReached = [...current.reachedTargets];
      let status: SetupOutcomeStatus = current.status;
      let closedAt: number | null = current.closedAt;
      const milestones: OutcomeMilestone[] = [];

      const stopHit = signal.side === "BUY"
        ? quote.price <= signal.stopLoss
        : quote.price >= signal.stopLoss;

      if (stopHit) {
        milestones.push("SL");
        status = "SL_HIT";
        closedAt = quote.sourceTimeMs;
      } else {
        for (const milestone of ["TP1", "TP2", "TP3"] as const) {
          if (nextReached.includes(milestone)) continue;
          const target = targetFor(signal, milestone);
          const targetHit = signal.side === "BUY"
            ? quote.price >= target
            : quote.price <= target;
          if (!targetHit) break;
          nextReached.push(milestone);
          milestones.push(milestone);
          if (milestone === "TP3") {
            status = "TP3_HIT";
            closedAt = quote.sourceTimeMs;
          }
        }
      }

      const updated: SetupOutcome = Object.freeze({
        ...current,
        status,
        reachedTargets: nextReached,
        lastEvaluatedSourceTimeMs: quote.sourceTimeMs,
        closedAt,
      });
      this.setups.set(setupId, updated);
      if (this.persistence) {
        void this.persistence.saveSetup(updated).catch((error: unknown) => {
          console.error("TradeSight could not persist setup outcome", error);
        });
      }

      for (const milestone of milestones) {
        const id = setupId + ":" + milestone;
        if (this.events.has(id)) continue;
        const event: OutcomeEvent = Object.freeze({
          id,
          setupId,
          instrumentId: signal.instrumentId,
          side: signal.side,
          milestone,
          targetPrice: targetFor(signal, milestone),
          observedPrice: quote.price,
          provider: quote.provider,
          priceBasis: quote.priceBasis,
          sourceTimeMs: quote.sourceTimeMs,
          receivedTimeMs: receivedAtMs,
        });
        this.events.set(id, event);
        emitted.push(event);
        if (this.persistence) {
          void this.persistence.appendEvent(event).catch((error: unknown) => {
            console.error("TradeSight could not persist outcome event", error);
          });
        }
        if (this.notification) {
          void Promise.resolve(this.notification.notify(event)).catch((error: unknown) => {
            console.error("TradeSight notification delivery failed", error);
          });
        }
      }
    }

    if (emitted.length > 0) this.publish();
    return emitted;
  }
}
