import { COMMODITY_SYMBOLS, type CommoditySymbol, type SiftingIoInstrument } from "./instrument-catalog";

export const FEED_SELECTION_STORAGE_KEY = "tradesight-v2-sifting-symbols";
export const FEED_SELECTION_CHANGED_EVENT = "tradesight:feed-selection-changed";

export const SUPPORTED_FOREX_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "USDCHF",
  "NZDUSD",
  "EURGBP",
] as const;

export type SupportedForexSymbol = (typeof SUPPORTED_FOREX_SYMBOLS)[number];

export const MAX_FREE_LIVE_SUBSCRIPTIONS = 5;

/**
 * Keep Forex first in the default priority list while reserving one live slot
 * for Gold. Users can still choose any five supported symbols in Settings.
 */
const DEFAULT_HOME_SELECTION: SiftingIoInstrument[] = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "XAUUSD",
];

const PREVIOUS_DEFAULT_FOREX_ONLY = [
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
] as const;

const LEGACY_GOLD_FIRST_DEFAULT = [
  "XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD",
] as const;

const ALL_SUPPORTED_FEED_SYMBOLS: readonly string[] = [
  ...COMMODITY_SYMBOLS,
  ...SUPPORTED_FOREX_SYMBOLS,
];

function isSameFiveSymbolSelection(
  parsed: readonly unknown[],
  expected: readonly string[],
): boolean {
  if (parsed.length !== expected.length) return false;
  const actual = new Set(parsed.filter((value): value is string => typeof value === "string"));
  return actual.size === expected.length && expected.every((symbol) => actual.has(symbol));
}

/**
 * One provider connection has one shared subscription allowance across
 * commodities and Forex. Return a single priority-ordered five-symbol list.
 */
export function readSelectedSiftingIoSymbols(): SiftingIoInstrument[] {
  if (typeof window === "undefined") return [...DEFAULT_HOME_SELECTION];

  try {
    const raw = window.localStorage.getItem(FEED_SELECTION_STORAGE_KEY);
    if (!raw) return [...DEFAULT_HOME_SELECTION];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_HOME_SELECTION];

    // Migrate only the two known starter presets. Custom user selections keep
    // their chosen priority order, even when they contain the same symbols.
    const isKnownStarterPreset =
      isSameFiveSymbolSelection(parsed, PREVIOUS_DEFAULT_FOREX_ONLY) ||
      isSameFiveSymbolSelection(parsed, LEGACY_GOLD_FIRST_DEFAULT);
    const ordered = isKnownStarterPreset ? [...DEFAULT_HOME_SELECTION] : parsed;
    const selected: SiftingIoInstrument[] = [];

    for (const value of ordered) {
      if (
        typeof value === "string" &&
        ALL_SUPPORTED_FEED_SYMBOLS.includes(value) &&
        !selected.includes(value as SiftingIoInstrument)
      ) {
        selected.push(value as SiftingIoInstrument);
      }
    }

    const capped = selected.slice(0, MAX_FREE_LIVE_SUBSCRIPTIONS);
    if (isKnownStarterPreset || capped.length !== selected.length) {
      try {
        window.localStorage.setItem(FEED_SELECTION_STORAGE_KEY, JSON.stringify(capped));
      } catch {
        // Continue using the validated, capped in-memory priority order even
        // when browser storage is read-only, full or temporarily unavailable.
      }
    }
    return capped;
  } catch {
    return [...DEFAULT_HOME_SELECTION];
  }
}

export function readSelectedForexPairs(): SupportedForexSymbol[] {
  const selected = readSelectedSiftingIoSymbols();
  return selected.filter((symbol): symbol is SupportedForexSymbol =>
    SUPPORTED_FOREX_SYMBOLS.includes(symbol as SupportedForexSymbol),
  );
}

/** Selected commodity instruments, filtered from the same shared five-symbol priority list. */
export function readSelectedCommoditySymbols(): CommoditySymbol[] {
  return readSelectedSiftingIoSymbols().filter((symbol): symbol is CommoditySymbol =>
    COMMODITY_SYMBOLS.includes(symbol as CommoditySymbol),
  );
}

export function announceFeedSelectionChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FEED_SELECTION_CHANGED_EVENT));
  }
}

/**
 * Keep the user's selected priority order when connecting feed listeners.
 * Provider limits are allocated against connection order, not checkbox order.
 */
export function orderFeedSymbolsByPriority<T extends string>(
  prioritySymbols: readonly T[],
  allSymbols: readonly T[],
): T[] {
  const allowed = new Set(allSymbols);
  const seen = new Set<T>();
  const ordered: T[] = [];

  for (const symbol of [...prioritySymbols, ...allSymbols]) {
    if (allowed.has(symbol) && !seen.has(symbol)) {
      ordered.push(symbol);
      seen.add(symbol);
    }
  }
  return ordered;
}
