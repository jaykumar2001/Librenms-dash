interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

export const cache = new TTLCache();

export const TTL = {
  DEVICES: 15 * 60 * 1000,       // 15 min cache lifetime (polled every 5 min — see DEVICE_POLL_MS)
  LOCATIONS: 60 * 60 * 1000,     // 1 hour
  AVAILABILITY: 60 * 60 * 1000,  // 1 hour
  PORTS: 5 * 60 * 1000,          // 5 min
  DEVICE_IPS: 15 * 60 * 1000,    // 15 min
  ALERTS: 2 * 60 * 1000,         // 2 min
  HEALTH: 5 * 60 * 1000,         // 5 min
  GRAPH_PNG: 5 * 60 * 1000,      // 5 min
  ROUTES: 15 * 60 * 1000,        // 15 min (routes change only during LibreNMS discovery)
} as const;
