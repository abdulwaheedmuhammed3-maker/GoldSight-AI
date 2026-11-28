import { COMMODITY_SYMBOLS, type CommoditySymbol } from "./instrument-catalog";

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

export const FEED_SELECTION_CHANGED_EVENT = "tradesight:feed-selection-changed";
export const FEED_SELECTION_STORAGE_KEY = "tradesight-v2-sifting-symbols";
export const MAX_FREE_LIVE_SUBSCRIPTIONS = 5;

const DEFAULT_HOME_FOREX_PAIRS: SupportedForexSymbol[] = [
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
];

const LEGACY_DEFAULT_SELECTION = [
  "XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD",
];

const ALL_SUPPORTED_FEED_SYMBOLS: readonly string[] = [
  ...COMMODITY_SYMBOLS,
  ...SUPPORTED_FOREX_SYMBOLS,
];

/**
 * One provider connection has one shared subscription allowance across
 * commodities and Forex. Return a single priority-ordered five-symbol list.
 */
export function readSelectedSiftingIoSymbols(): SiftingIoInstrument[] {
  if (typeof window === "undefined") return [...DEFAULT_HOME_FOREX_PAIRS];

  try {
    const raw = window.localStorage.getItem(FEED_SELECTION_STORAGE_KEY);
    if (!raw) return [...DEFAULT_HOME_FOREX_PAIRS];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_HOME_FOREX_PAIRS];

    const saved = new Set(
      parsed.filter((value): value is string => typeof value === "string"),
    );
    const isLegacyDefault =
      parsed.length === LEGACY_DEFAULT_SELECTION.length &&
      LEGACY_DEFAULT_SELECTION.every((symbol) => saved.has(symbol));
    const ordered = isLegacyDefault ? [...parsed, "USDCAD"] : parsed;
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
    if (isLegacyDefault || capped.length !== selected.length) {
      window.localStorage.setItem(FEED_SELECTION_STORAGE_KEY, JSON.stringify(capped));
    }
    return capped;
  } catch {
    return [...DEFAULT_HOME_FOREX_PAIRS];
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
