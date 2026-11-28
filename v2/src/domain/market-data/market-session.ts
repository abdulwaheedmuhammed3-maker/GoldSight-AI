import { COMMODITY_SYMBOLS } from "./instrument-catalog";

export type MarketSessionKind = "CRYPTO_24_7" | "FOREX_24_5" | "SPOT_GOLD" | "COMMODITY_CFD" | "UNCONFIGURED";

export interface MarketSessionStatus {
  readonly isOpen: boolean;
  readonly kind: MarketSessionKind;
  readonly label: string;
  readonly detail: string;
  readonly timezone: "America/New_York" | "UTC";
}

const FOREX_INSTRUMENTS = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD",
  "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
]);

type Weekday = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
interface MarketClock {
  readonly weekday: Weekday;
  readonly minutes: number;
}

function utcClock(atMs: number): MarketClock | null {
  if (!Number.isFinite(atMs)) return null;
  const date = new Date(atMs);
  const weekdays: readonly Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdays[date.getUTCDay()];
  if (!weekday) return null;
  return { weekday, minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
}

function newYorkClock(atMs: number): MarketClock | null {
  if (!Number.isFinite(atMs)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(atMs));
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = value("weekday") as Weekday;
    const hour = Number(value("hour"));
    const minute = Number(value("minute"));
    if (
      !["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].includes(weekday) ||
      !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59
    ) return null;
    return { weekday, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

function closed(
  kind: MarketSessionKind,
  detail: string,
  timezone: MarketSessionStatus["timezone"],
): MarketSessionStatus {
  return { isOpen: false, kind, label: "CLOSED", detail, timezone };
}

function open(
  kind: MarketSessionKind,
  detail: string,
  timezone: MarketSessionStatus["timezone"],
): MarketSessionStatus {
  return { isOpen: true, kind, label: "OPEN", detail, timezone };
}

/**
 * Reference sessions used to prevent signal generation on closed markets.
 *
 * Forex follows SiftingIO's documented Sunday 21:00 UTC to Friday 21:00 UTC
 * weekly schedule. SiftingIO also documents four UTC trading-session windows;
 * those are intraday sessions, not market closures, so they do not pause scans.
 *
 * Gold and the other supported commodity references use a broad New York
 * reference schedule: Sunday 18:00 to Friday 17:00, with a weekday 17:00–18:00
 * maintenance break. This is a scanner guard, not broker-specific execution
 * hours. Exness CFD sessions and holiday exceptions can differ by instrument.
 */
export function getMarketSessionStatus(
  instrumentId: string,
  atMs = Date.now(),
): MarketSessionStatus {
  if (instrumentId === "BTCUSD") {
    return open(
      "CRYPTO_24_7",
      "Crypto market is open continuously, including weekends.",
      "UTC",
    );
  }

  if (FOREX_INSTRUMENTS.has(instrumentId)) {
    const clock = utcClock(atMs);
    if (!clock) {
      return closed("FOREX_24_5", "The current time could not be validated; scanning is paused.", "UTC");
    }
    const isOpen = (
      (clock.weekday === "Sun" && clock.minutes >= 21 * 60) ||
      ["Mon", "Tue", "Wed", "Thu"].includes(clock.weekday) ||
      (clock.weekday === "Fri" && clock.minutes < 21 * 60)
    );
    return isOpen
      ? open("FOREX_24_5", "Forex session is open (Sunday 21:00 UTC to Friday 21:00 UTC, per SiftingIO's published weekly schedule).", "UTC")
      : closed("FOREX_24_5", "Forex weekend closure. The SiftingIO reference schedule reopens Sunday at 21:00 UTC.", "UTC");
  }

  if ((COMMODITY_SYMBOLS as readonly string[]).includes(instrumentId)) {
    const kind = instrumentId === "XAUUSD" ? "SPOT_GOLD" : "COMMODITY_CFD";
    const marketName = instrumentId === "XAUUSD" ? "Spot gold" : "Commodity reference";
    const clock = newYorkClock(atMs);
    if (!clock) {
      return closed(kind, "The current time could not be validated; scanning is paused.", "America/New_York");
    }
    const weekday = clock.weekday;
    const minutes = clock.minutes;
    const weekdayOpen = ["Mon", "Tue", "Wed", "Thu"].includes(weekday);
    const isOpen = (
      (weekday === "Sun" && minutes >= 18 * 60) ||
      (weekdayOpen && (minutes < 17 * 60 || minutes >= 18 * 60)) ||
      (weekday === "Fri" && minutes < 17 * 60)
    );
    if (isOpen) {
      return open(
        kind,
        marketName + " reference session is open (Sunday 18:00 to Friday 17:00 New York time). Exness and other broker-specific CFD hours may differ.",
        "America/New_York",
      );
    }
    const isDailyBreak = weekdayOpen && minutes >= 17 * 60 && minutes < 18 * 60;
    return closed(
      kind,
      isDailyBreak
        ? marketName + " daily maintenance break. The reference session resumes at 18:00 New York time."
        : marketName + " weekend closure. The reference session resumes Sunday at 18:00 New York time.",
      "America/New_York",
    );
  }

  return closed(
    "UNCONFIGURED",
    "No trading session is configured for this instrument; signal generation is disabled.",
    "UTC",
  );
}

/** Convenience predicate for callers that only need a yes/no session gate. */
export function isMarketSessionOpen(instrumentId: string, timestampMs = Date.now()): boolean {
  return getMarketSessionStatus(instrumentId, timestampMs).isOpen;
}
