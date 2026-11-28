/**
 * Default tradable-session calendar for TradeSight's supported instruments.
 *
 * Crypto (BTCUSD) trades continuously. FX and spot gold use the common
 * New York-time broker schedule so DST changes are handled by the IANA zone:
 * FX: Sun 17:05–Fri 16:59, with a 6-minute weekday rollover break.
 * Gold: Sun 18:05–Fri 16:59, with a daily 16:59–18:05 maintenance break.
 *
 * Exact CFD hours and holiday exceptions can vary by broker/provider. This
 * calendar is a conservative default, not a claim about a user's execution broker.
 */
const FX_INSTRUMENTS = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
  "USDCHF", "NZDUSD", "EURGBP",
]);

type NewYorkClock = {
  weekday: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
  minuteOfDay: number;
};

function getNewYorkClock(timestampMs: number): NewYorkClock | null {
  if (!Number.isFinite(timestampMs)) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));

  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  if (
    !["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].includes(weekday ?? "") ||
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59
  ) return null;

  return {
    weekday: weekday as NewYorkClock["weekday"],
    minuteOfDay: hour * 60 + minute,
  };
}

/** Returns true only when the instrument is inside its scheduled trading session. */
export function isMarketSessionOpen(instrumentId: string, timestampMs = Date.now()): boolean {
  if (instrumentId === "BTCUSD") return true;

  const market = instrumentId === "XAUUSD"
    ? "GOLD"
    : FX_INSTRUMENTS.has(instrumentId)
      ? "FX"
      : null;
  if (!market) return false;

  const clock = getNewYorkClock(timestampMs);
  if (!clock || clock.weekday === "Sat") return false;

  const weeklyOpen = market === "GOLD" ? 18 * 60 + 5 : 17 * 60 + 5;
  const dailyClose = 16 * 60 + 59;
  const dailyReopen = market === "GOLD" ? 18 * 60 + 5 : 17 * 60 + 5;

  if (clock.weekday === "Sun") return clock.minuteOfDay >= weeklyOpen;
  if (clock.weekday === "Fri") return clock.minuteOfDay < dailyClose;
  if (clock.minuteOfDay >= dailyClose && clock.minuteOfDay < dailyReopen) return false;

  return true;
}
