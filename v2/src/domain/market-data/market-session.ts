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

interface NewYorkClock {
  readonly weekday: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
  readonly minutes: number;
}

function newYorkClock(atMs: number): NewYorkClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday") as NewYorkClock["weekday"];
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  return { weekday, minutes: hour * 60 + minute };
}

/**
 * Baseline tradable sessions for TradeSight's supported instruments.
 * New York's IANA timezone handles US daylight-saving changes automatically.
 * Broker-specific exceptions and exchange holidays are not yet applied.
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

  const clock = newYorkClock(atMs);

  if (FOREX_INSTRUMENTS.has(instrumentId)) {
    const open = (
      (clock.weekday === "Sun" && clock.minutes >= 17 * 60) ||
      (["Mon", "Tue", "Wed", "Thu"].includes(clock.weekday)) ||
      (clock.weekday === "Fri" && clock.minutes < 17 * 60)
    );
    return {
      isOpen: open,
      kind: "FOREX_24_5",
      label: open ? "OPEN" : "CLOSED",
      detail: open
        ? "Forex session is open (Sunday 5:00 PM to Friday 5:00 PM New York time)."
        : "Forex weekend closure. The session reopens Sunday at 5:00 PM New York time.",
      timezone: "America/New_York",
    };
  }

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
