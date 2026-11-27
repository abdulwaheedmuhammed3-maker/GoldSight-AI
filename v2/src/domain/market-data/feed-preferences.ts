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

const DEFAULT_HOME_FOREX_PAIRS: SupportedForexSymbol[] = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
];

const LEGACY_DEFAULT_SELECTION = [
  "XAUUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
];

export function readSelectedForexPairs(): SupportedForexSymbol[] {
  if (typeof window === "undefined") return [...DEFAULT_HOME_FOREX_PAIRS];

  try {
    const raw = window.localStorage.getItem(FEED_SELECTION_STORAGE_KEY);
    if (!raw) return [...DEFAULT_HOME_FOREX_PAIRS];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_HOME_FOREX_PAIRS];

    const saved = new Set(
      parsed.filter((value): value is string => typeof value === "string"),
    );

    // Migrate the original first-run selection (Gold + four FX pairs) to
    // the intended five-pair home watchlist by adding USDCAD.
    const isLegacyDefault =
      parsed.length === LEGACY_DEFAULT_SELECTION.length &&
      LEGACY_DEFAULT_SELECTION.every((symbol) => saved.has(symbol));

    if (isLegacyDefault) {
      saved.add("USDCAD");
      window.localStorage.setItem(
        FEED_SELECTION_STORAGE_KEY,
        JSON.stringify([...parsed, "USDCAD"]),
      );
    }

    const selectedInSavedOrder: SupportedForexSymbol[] = [];
    for (const value of parsed) {
      if (
        typeof value === "string" &&
        SUPPORTED_FOREX_SYMBOLS.includes(value as SupportedForexSymbol) &&
        !selectedInSavedOrder.includes(value as SupportedForexSymbol)
      ) {
        selectedInSavedOrder.push(value as SupportedForexSymbol);
      }
    }
    return selectedInSavedOrder.slice(0, 5);
  } catch {
    return [...DEFAULT_HOME_FOREX_PAIRS];
  }
}

export function announceFeedSelectionChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FEED_SELECTION_CHANGED_EVENT));
  }
}
