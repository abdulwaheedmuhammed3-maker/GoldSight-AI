import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { OutcomeEvent, OutcomeNotification } from "./outcome-monitor";

const CHANNEL_ID = "tradesight-trade-events";

function notificationId(eventId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < eventId.length; index += 1) {
    hash ^= eventId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2_000_000_000 + 1;
}

function eventTitle(event: OutcomeEvent): string {
  return event.milestone === "SL"
    ? event.instrumentId + " · Stop Loss hit"
    : event.instrumentId + " · " + event.milestone + " reached";
}

function eventBody(event: OutcomeEvent): string {
  const digits = event.instrumentId === "EURUSD" || event.instrumentId === "GBPUSD" ||
    event.instrumentId === "USDJPY" || event.instrumentId === "AUDUSD" ||
    event.instrumentId === "USDCAD" || event.instrumentId === "USDCHF" ||
    event.instrumentId === "NZDUSD" || event.instrumentId === "EURGBP" ? 5 : 2;
  const fmt = (value: number) => new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return event.side + " · " + event.milestone +
    " · observed " + fmt(event.observedPrice) +
    " · target " + fmt(event.targetPrice);
}

export class DeviceOutcomeNotification implements OutcomeNotification {
  async notify(event: OutcomeEvent): Promise<void> {
    const title = eventTitle(event);
    const body = eventBody(event);

    if (Capacitor.isNativePlatform()) {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== "granted") return;

      await LocalNotifications.schedule({
        notifications: [{
          id: notificationId(event.id),
          title,
          body,
          schedule: { at: new Date(Date.now() + 100) },
          channelId: CHANNEL_ID,
          autoCancel: true,
          foreground: true,
          isExactNotification: false,
          extra: { eventId: event.id, setupId: event.setupId, milestone: event.milestone },
        }],
      });
      return;
    }

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, tag: event.id });
    }
  }
}

export async function requestOutcomeNotificationPermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (Capacitor.isNativePlatform()) {
    const existing = await LocalNotifications.checkPermissions();
    const permission = existing.display === "granted"
      ? existing
      : await LocalNotifications.requestPermissions();

    if (permission.display !== "granted") return "denied";

    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "TradeSight trade alerts",
      description: "Notifications when a tracked setup reaches TP1, TP2, TP3 or Stop Loss.",
      importance: 4,
      vibration: true,
    });
    return "granted";
  }

  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return await Notification.requestPermission() === "granted" ? "granted" : "denied";
}
