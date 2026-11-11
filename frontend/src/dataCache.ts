// Local continuity cache for successfully fetched, non-secret application data.
// Cache entries are snapshots only; callers must mark restored provider data as stale/offline.
export function readDataCache<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw == null ? fallback : JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeDataCache(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable or full; never let cache failures break the app.
  }
}
