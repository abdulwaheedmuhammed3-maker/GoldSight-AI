import { Capacitor, registerPlugin } from "@capacitor/core";

interface SecureCredentialsPlugin {
  saveSiftingIoKey(options: { apiKey: string }): Promise<{ saved: boolean }>;
  getSiftingIoKey(): Promise<{ apiKey: string | null }>;
  clearSiftingIoKey(): Promise<{ cleared: boolean }>;
}

const SecureCredentials = registerPlugin<SecureCredentialsPlugin>("SecureCredentials");

/** Secure credential persistence is available only in the native Android app. */
export function canPersistMarketCredentials(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function saveSiftingIoCredential(apiKey: string): Promise<void> {
  if (!canPersistMarketCredentials()) {
    throw new Error("Secure key storage is available in the installed Android app only.");
  }
  const result = await SecureCredentials.saveSiftingIoKey({ apiKey });
  if (!result.saved) throw new Error("Android did not confirm that the SiftingIO key was saved.");
}

export async function readSiftingIoCredential(): Promise<string | null> {
  if (!canPersistMarketCredentials()) return null;
  const result = await SecureCredentials.getSiftingIoKey();
  return typeof result.apiKey === "string" && result.apiKey.trim()
    ? result.apiKey
    : null;
}

export async function clearSiftingIoCredential(): Promise<void> {
  if (!canPersistMarketCredentials()) return;
  await SecureCredentials.clearSiftingIoKey();
}
