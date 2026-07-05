import { describe, it, expect } from "vitest";
import { ArpDeviceRegistry, STALE_THRESHOLD_MS, RETENTION_MS } from "./arpDeviceRegistry.js";
import type { ArpDeviceFields } from "./arpDeviceRegistry.js";

const baseDevice: ArpDeviceFields = {
  mac: "aabbccddeeff",
  macs: ["aabbccddeeff"],
  ips: ["192.168.1.50"],
  vendor: "Acme",
  location: "HQ",
  siteId: "hq",
  seenByHostname: "switch1",
  sourceDown: false,
};

describe("ArpDeviceRegistry", () => {
  it("keeps firstSeen fixed and advances lastSeen across repeated upserts", () => {
    const registry = new ArpDeviceRegistry();
    const t0 = 1_000_000;
    registry.upsert(baseDevice, t0);
    const t1 = t0 + 60_000;
    registry.upsert(baseDevice, t1);

    const [published] = registry.publish(t1);
    expect(published.firstSeen).toBe(new Date(t0).toISOString());
    expect(published.lastSeen).toBe(new Date(t1).toISOString());
  });

  it("marks a device stale after STALE_THRESHOLD_MS with no re-upsert", () => {
    const registry = new ArpDeviceRegistry();
    const t0 = 1_000_000;
    registry.upsert(baseDevice, t0);

    const justBefore = registry.publish(t0 + STALE_THRESHOLD_MS - 1);
    expect(justBefore[0].stale).toBe(false);

    const atExactly = registry.publish(t0 + STALE_THRESHOLD_MS);
    expect(atExactly[0].stale).toBe(false);

    const justAfter = registry.publish(t0 + STALE_THRESHOLD_MS + 1);
    expect(justAfter[0].stale).toBe(true);
  });

  it("evicts a device after RETENTION_MS with no re-upsert", () => {
    const registry = new ArpDeviceRegistry();
    const t0 = 1_000_000;
    registry.upsert(baseDevice, t0);

    const justBefore = registry.publish(t0 + RETENTION_MS - 1);
    expect(justBefore).toHaveLength(1);

    const justAfter = registry.publish(t0 + RETENTION_MS + 1);
    expect(justAfter).toHaveLength(0);

    // Confirms actual deletion, not just filtering: still empty on a later publish.
    expect(registry.publish(t0 + RETENTION_MS + 2)).toHaveLength(0);
  });

  it("re-upsert after going stale resets stale back to false and keeps firstSeen", () => {
    const registry = new ArpDeviceRegistry();
    const t0 = 1_000_000;
    registry.upsert(baseDevice, t0);
    const wentStale = registry.publish(t0 + STALE_THRESHOLD_MS + 1);
    expect(wentStale[0].stale).toBe(true);

    registry.upsert(baseDevice, t0 + STALE_THRESHOLD_MS + 2);
    const revived = registry.publish(t0 + STALE_THRESHOLD_MS + 2);
    expect(revived[0].stale).toBe(false);
    expect(revived[0].firstSeen).toBe(new Date(t0).toISOString());
  });

  it("get() returns the raw record fields for merge-enrichment use", () => {
    const registry = new ArpDeviceRegistry();
    registry.upsert(baseDevice, 1000);
    const rec = registry.get("aabbccddeeff");
    expect(rec?.ips).toEqual(["192.168.1.50"]);
  });
});
