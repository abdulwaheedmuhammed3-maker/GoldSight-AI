import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(async () => ({ display: "granted" })),
    createChannel: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
  },
}));

import { LocalNotifications } from "@capacitor/local-notifications";
import { DeviceOutcomeNotification } from "./notification-service";
import type { OutcomeEvent } from "./outcome-monitor";

const notification = new DeviceOutcomeNotification();

function event(milestone: OutcomeEvent["milestone"]): OutcomeEvent {
  return {
    id: "XAUUSD:BUY:5m:provider:123:" + milestone,
    setupId: "XAUUSD:BUY:5m:provider:123",
    instrumentId: "XAUUSD",
    side: "BUY",
    milestone,
    targetPrice: milestone === "SL" ? 2300 : milestone === "TP1" ? 2350 : milestone === "TP2" ? 2400 : 2450,
    observedPrice: 2360,
    provider: "SiftingIO Market Data",
    priceBasis: "last",
    observedPriceBasis: "bid",
    digits: 2,
    sourceTimeMs: 1_800_000_000_000,
    receivedTimeMs: 1_800_000_000_000,
  };
}

describe("DeviceOutcomeNotification", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["TP1", "TP2", "TP3", "SL"] as const)(
    "sends a device notification for %s",
    async (milestone) => {
      await notification.notify(event(milestone));

      expect(LocalNotifications.checkPermissions).toHaveBeenCalledOnce();
      expect(LocalNotifications.schedule).toHaveBeenCalledOnce();
      expect(LocalNotifications.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          notifications: [
            expect.objectContaining({
              title: milestone === "SL"
                ? "XAUUSD · Stop Loss hit"
                : "XAUUSD · " + milestone + " reached",
              extra: expect.objectContaining({ milestone }),
            }),
          ],
        }),
      );
    },
  );
});
