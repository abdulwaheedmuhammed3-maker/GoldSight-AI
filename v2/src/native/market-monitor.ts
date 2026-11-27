import { Capacitor, registerPlugin } from "@capacitor/core";

export interface MarketMonitorStatus {
  running: boolean;
  startedAtMs: number | null;
  stopReason: string | null;
}

export interface MarketMonitorPlugin {
  start(options?: { title?: string; body?: string }): Promise<MarketMonitorStatus>;
  stop(): Promise<MarketMonitorStatus>;
  getStatus(): Promise<MarketMonitorStatus>;
}

const NativeMarketMonitor = registerPlugin<MarketMonitorPlugin>("MarketMonitor");

export function isNativeMarketMonitorAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function startNativeMarketMonitor(): Promise<MarketMonitorStatus> {
  if (!isNativeMarketMonitorAvailable()) {
    throw new Error("Background monitoring service is available in the Android APK only.");
  }
  return NativeMarketMonitor.start({
    title: "TradeSight monitoring active",
    body: "Keeping the TradeSight app process active for live market monitoring.",
  });
}

export async function stopNativeMarketMonitor(): Promise<MarketMonitorStatus> {
  if (!isNativeMarketMonitorAvailable()) {
    throw new Error("Background monitoring service is available in the Android APK only.");
  }
  return NativeMarketMonitor.stop();
}

export async function getNativeMarketMonitorStatus(): Promise<MarketMonitorStatus> {
  if (!isNativeMarketMonitorAvailable()) {
    return { running: false, startedAtMs: null, stopReason: "Android APK required" };
  }
  return NativeMarketMonitor.getStatus();
}
