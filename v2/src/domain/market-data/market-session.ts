export type MarketSessionKind = "CRYPTO_24_7" | "FOREX_24_5" | "SPOT_GOLD" | "UNCONFIGURED";

export interface MarketSessionStatus {
  readonly isOpen: boolean;
  readonly kind: MarketSessionKind;
  readonly label: string;
  readonly detail: string;
  readonly timezone: "America/New_York" | "UTC";
}

const FOREX_INSTRUMENTS = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
  "USDCHF", "NZDUSD", "EURGBP",
]);

interface MarketClock {
  readonly weekday: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
  readonly minutes: number;
}

function utcClock(atMs: number): MarketClock {
  const date = new Date(atMs);
  const weekdays: readonly MarketClock["weekday"][] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    weekday: weekdays[date.getUTCDay()],
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
}

function newYorkClock(atMs: number): MarketClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday") as MarketClock["weekday"];
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  return { weekday, minutes: hour * 60 + minute };
}

/**
 * Baseline tradable sessions for TradeSight's supported instruments.
 * New York's IANA timezone handles Gold's US daylight-saving changes automatically.
 * Spot-gold broker-specific exceptions and exchange holidays are not yet applied.
 * SiftingIO's forex calendar has no holiday/half-day exceptions.
 */
export function getMarketSessionStatus(
  instrumentId: string,
  atMs = Date.now(),
): MarketSessionStatus {
  if (instrumentId === "BTCUSD") {
    return {
      isOpen: true,
      kind: "CRYPTO_24_7",
      label: "24/7",
      detail: "Crypto market is open continuously, including weekends.",
      timezone: "UTC",
    };
  }

  if (instrumentId !== "XAUUSD" && !FOREX_INSTRUMENTS.has(instrumentId)) {
    return {
      isOpen: false,
      kind: "UNCONFIGURED",
      label: "SESSION UNKNOWN",
      detail: "No trading session is configured for this instrument; signal generation is disabled.",
      timezone: "UTC",
    };
  }

  if (FOREX_INSTRUMENTS.has(instrumentId)) {
    // SiftingIO's published forex market calendar uses a UTC weekly anchor.
    const clock = utcClock(atMs);
    const open = (
      (clock.weekday === "Sun" && clock.minutes >= 21 * 60) ||
      (["Mon", "Tue", "Wed", "Thu"].includes(clock.weekday)) ||
      (clock.weekday === "Fri" && clock.minutes < 21 * 60)
    );
    return {
      isOpen: open,
      kind: "FOREX_24_5",
      label: open ? "OPEN" : "CLOSED",
      detail: open
        ? "Forex session is open (Sunday 21:00 UTC to Friday 21:00 UTC, per SiftingIO's weekly schedule)."
        : "Forex weekend closure. SiftingIO's weekly schedule reopens Sunday at 21:00 UTC.",
      timezone: "UTC",
    };
  }

  const clock = newYorkClock(atMs);
  const goldOpen = (
    (clock.weekday === "Sun" && clock.minutes >= 18 * 60) ||
    (["Mon", "Tue", "Wed", "Thu"].includes(clock.weekday) &&
      (clock.minutes < 17 * 60 || clock.minutes >= 18 * 60)) ||
    (clock.weekday === "Fri" && clock.minutes < 17 * 60)
  );
  const dailyBreak = ["Mon", "Tue", "Wed", "Thu"].includes(clock.weekday) &&
    clock.minutes >= 17 * 60 && clock.minutes < 18 * 60;

  return {
    isOpen: goldOpen,
    kind: "SPOT_GOLD",
    label: goldOpen ? "OPEN" : "CLOSED",
    detail: goldOpen
      ? "Spot gold session is open (Sunday 6:00 PM to Friday 5:00 PM New York time)."
      : dailyBreak
        ? "Spot gold daily maintenance break. Trading resumes at 6:00 PM New York time."
        : "Spot gold weekend closure. The session reopens Sunday at 6:00 PM New York time.",
    timezone: "America/New_York",
  };
}
