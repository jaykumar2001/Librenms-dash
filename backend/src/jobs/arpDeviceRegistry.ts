import type { ArpDiscoveredDevice } from "@librenms-dash/shared";

export type ArpDeviceFields = Omit<ArpDiscoveredDevice, "firstSeen" | "lastSeen" | "stale">;

interface ArpDeviceRecord extends ArpDeviceFields {
  firstSeen: number; // epoch ms
  lastSeen: number;  // epoch ms
}

export const STALE_THRESHOLD_MS = 15 * 60 * 1000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export class ArpDeviceRegistry {
  private records = new Map<string, ArpDeviceRecord>();

  upsert(fields: ArpDeviceFields, now: number = Date.now()): void {
    const existing = this.records.get(fields.mac);
    this.records.set(fields.mac, {
      ...fields,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    });
  }

  get(mac: string): ArpDeviceFields | undefined {
    return this.records.get(mac);
  }

  publish(now: number = Date.now()): ArpDiscoveredDevice[] {
    const result: ArpDiscoveredDevice[] = [];
    for (const [mac, rec] of this.records) {
      if (now - rec.lastSeen > RETENTION_MS) {
        this.records.delete(mac);
        continue;
      }
      result.push({
        ...rec,
        firstSeen: new Date(rec.firstSeen).toISOString(),
        lastSeen: new Date(rec.lastSeen).toISOString(),
        stale: now - rec.lastSeen > STALE_THRESHOLD_MS,
      });
    }
    return result;
  }
}

export const arpDeviceRegistry = new ArpDeviceRegistry();
