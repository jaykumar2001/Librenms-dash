# Discovered-Device lastSeen / Staleness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track `firstSeen`/`lastSeen` per ARP/ND-discovered device, dim (don't remove) a device for 15 minutes after it stops appearing in polls, and fully remove it only after 24 hours — so a device that's briefly offline (e.g. powered down in a home lab) doesn't vanish from the topology instantly.

**Architecture:** A new backend-owned, in-memory `ArpDeviceRegistry` (module in `backend/src/jobs/arpDeviceRegistry.ts`) replaces the current pattern of overwriting the `arpDevices` array wholesale every poll cycle. `pollArpLinks` and `pollNdNeighbours` upsert into the registry (keeping `firstSeen`, refreshing `lastSeen`); `buildAndCacheTopology()` publishes the registry contents, evicting anything older than 24h and flagging anything older than 15min as `stale`. The frontend threads `stale`/`lastSeen` through the existing layout/render pipeline to dim stale nodes and show a "Last seen" tooltip row.

**Tech Stack:** TypeScript, Hono (backend), React + SVG (frontend), pnpm workspaces, vitest (new, for the registry's pure logic).

## Global Constraints

- No database. The app has no DB dependency anywhere (verified: no `pg`/similar in `backend/package.json`, no DB service in `docker-compose.yaml`). `firstSeen`/`lastSeen` reset on backend restart — same as the rest of the topology cache today. Do not introduce persistence.
- Stale threshold: **15 minutes** (`STALE_THRESHOLD_MS = 15 * 60 * 1000`).
- Retention/eviction threshold: **24 hours** (`RETENTION_MS = 24 * 60 * 60 * 1000`).
- Going stale fires **no** toast/event. Only a genuinely new device ("added") or a 24h-evicted device ("removed") fires an `AssetEvent`.
- Verify with `docker-compose up -d --build` per project convention (CLAUDE.md) — this is the final gate for every task, in addition to any faster per-task checks.
- Spec: `docs/superpowers/specs/2026-07-03-discovered-device-lastseen-staleness-design.md`

---

## Task 1: `ArpDiscoveredDevice` type + `ArpDeviceRegistry` module with unit tests

**Files:**
- Modify: `shared/types.ts:152-163`
- Create: `backend/src/jobs/arpDeviceRegistry.ts`
- Create: `backend/src/jobs/arpDeviceRegistry.test.ts`
- Modify: `backend/package.json` (add `vitest` devDependency + `test` script)

**Interfaces:**
- Produces: `ArpDeviceFields` (type alias, `Omit<ArpDiscoveredDevice, "firstSeen" | "lastSeen" | "stale">`), `ArpDeviceRegistry` class with `upsert(fields: ArpDeviceFields, now?: number): void`, `get(mac: string): ArpDeviceFields | undefined`, `publish(now?: number): ArpDiscoveredDevice[]`, plus the singleton `arpDeviceRegistry` instance and exported constants `STALE_THRESHOLD_MS`, `RETENTION_MS`. Task 2 imports all of these from `./arpDeviceRegistry.js`.

- [ ] **Step 1: Add `firstSeen`/`lastSeen`/`stale` to the shared type**

Edit `shared/types.ts`, in the `ArpDiscoveredDevice` interface (currently lines 152-163):

```ts
export interface ArpDiscoveredDevice {
  mac: string;
  macs: string[];
  ips: string[];
  vendor: string;
  location: string;
  siteId: string;
  seenByHostname: string;
  seenByInterface?: string;
  seenByIp?: string;
  seenByMac?: string;
  firstSeen: string; // ISO 8601
  lastSeen: string;  // ISO 8601
  stale: boolean;
}
```

- [ ] **Step 2: Add vitest to the backend package**

Run:
```bash
cd /home/jkumar/Librenms-dash && pnpm --filter backend add -D vitest
```

Then edit `backend/package.json`, add a `test` script to the `"scripts"` block:

```json
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --outdir=dist --packages=external --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\"",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Write the failing test file**

Create `backend/src/jobs/arpDeviceRegistry.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && npx vitest run`
Expected: FAIL — `Cannot find module './arpDeviceRegistry.js'` (module doesn't exist yet).

- [ ] **Step 5: Implement `ArpDeviceRegistry`**

Create `backend/src/jobs/arpDeviceRegistry.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npx vitest run`
Expected: PASS — 5 tests passing.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts backend/package.json backend/src/jobs/arpDeviceRegistry.ts backend/src/jobs/arpDeviceRegistry.test.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat: add ArpDeviceRegistry with firstSeen/lastSeen/stale tracking

Pure in-memory registry that upserts discovered devices by MAC instead
of overwriting the whole list each poll, so a device survives a brief
disappearance instead of vanishing instantly. Not yet wired into the
poller.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the registry into `poller.ts`

**Files:**
- Modify: `backend/src/jobs/poller.ts` (imports; `consolidateArpDevices`; `pollArpLinks`; `pollNdNeighbours`; `buildAndCacheTopology`)

**Interfaces:**
- Consumes: `arpDeviceRegistry`, `ArpDeviceFields`, `STALE_THRESHOLD_MS` (unused directly here, informational), `RETENTION_MS` (same) from `./arpDeviceRegistry.js` (Task 1).
- Produces: `buildAndCacheTopology()` continues to publish `TopologyResponse.arpDevices` (now with `firstSeen`/`lastSeen`/`stale` populated) — no signature change, so downstream consumers (routes, frontend) are unaffected by this task alone.

- [ ] **Step 1: Update imports**

In `backend/src/jobs/poller.ts`, line 9, remove the now-to-be-unused `ArpDiscoveredDevice` from the type import (it will no longer be referenced directly in this file once the steps below land) and add the registry import. Change:

```ts
import type { ArpLink, ArpDiscoveredDevice, DeviceRoute, AssetEvent, TopologyResponse, Site, DeviceSummary, NeighborLink } from "@librenms-dash/shared";
```

to:

```ts
import type { ArpLink, DeviceRoute, AssetEvent, TopologyResponse, Site, DeviceSummary, NeighborLink } from "@librenms-dash/shared";
import { arpDeviceRegistry } from "./arpDeviceRegistry.js";
import type { ArpDeviceFields } from "./arpDeviceRegistry.js";
```

- [ ] **Step 2: Change `consolidateArpDevices`'s return type**

In `backend/src/jobs/poller.ts`, the function signature (currently around line 688):

```ts
): ArpDiscoveredDevice[] {
```

becomes:

```ts
): ArpDeviceFields[] {
```

No other change inside `consolidateArpDevices` — its object literals (around lines 805-816) already only populate the `ArpDeviceFields` subset (`mac`, `macs`, `ips`, `vendor`, `location`, `siteId`, `seenByHostname`, `seenByInterface`, `seenByIp`, `seenByMac`), so this is purely a type-annotation fix.

- [ ] **Step 3: Replace the end of `pollArpLinks`**

In `backend/src/jobs/poller.ts`, replace this block (currently lines 651-674):

```ts
  // Preserve ND-only discovered devices (IPv6-only IPs) that pollNdNeighbours added.
  // pollArpLinks can't see them — they have no ARP (IPv4) presence — so without this
  // they get erased every cycle when we overwrite "arpDevices".
  const prevArpDevices = cache.get<ArpDiscoveredDevice[]>("arpDevices") ?? [];
  const consolidatedMacs = new Set(arpDevices.map(d => d.mac));
  const ndOnlyPrev = prevArpDevices.filter(
    d => !consolidatedMacs.has(d.mac) && d.ips.every(ip => ip.includes(":")),
  );
  const finalArpDevices = ndOnlyPrev.length > 0 ? [...arpDevices, ...ndOnlyPrev] : arpDevices;

  cache.set("arpLinks", arpLinks, TTL.PORTS);
  cache.set("arpDevices", finalArpDevices, TTL.PORTS);
  console.log(`[poller] Cached ${arpLinks.length} ARP links, ${finalArpDevices.length} discovered devices (${arpDevices.length} ARP + ${ndOnlyPrev.length} ND-only), ${arpLanIps.size} ARP-discovered LAN IPs from ${allArpEntries.length} ARP entries`);

  const currArpDevices = new Set(finalArpDevices.map(d => {
    const mac = d.mac.replace(/(.{2})(?=.)/g, "$1:");
    return `${mac} at ${d.location}`;
  }));
  prevAssets.arpDevices = diffAndLog("discovered-device", prevAssets.arpDevices, currArpDevices);
  // Always trigger a rebuild — on the first run diffAndLog skips the baseline check
  // and never sets topologyChangedInCycle, so flushTopologyChanged() would be a no-op,
  // leaving the topology with the stale arpLinks:[] that pollNdNeighbours wrote.
  topologyChangedInCycle = true;
  flushTopologyChanged();
}
```

with:

```ts
  for (const device of arpDevices) {
    arpDeviceRegistry.upsert(device);
  }

  cache.set("arpLinks", arpLinks, TTL.PORTS);
  console.log(`[poller] ARP: upserted ${arpDevices.length} discovered devices, ${arpLinks.length} links, ${arpLanIps.size} LAN IPs from ${allArpEntries.length} ARP entries`);

  // Always trigger a rebuild — on the first run diffAndLog (inside buildAndCacheTopology)
  // skips the baseline check and never sets topologyChangedInCycle, so
  // flushTopologyChanged() would be a no-op, leaving the topology with the stale
  // arpLinks:[] that pollNdNeighbours wrote.
  topologyChangedInCycle = true;
  flushTopologyChanged();
}
```

Registry retention (the old "preserve ND-only devices" carve-out) is no longer needed: `arpDeviceRegistry` naturally keeps every MAC it has ever upserted until 24h of silence, so devices only visible via ND are never erased just because this ARP pass didn't see them.

- [ ] **Step 4: Replace the ND-merge block in `pollNdNeighbours`**

In `backend/src/jobs/poller.ts`, replace this block (currently lines 957-989):

```ts
  // Merge ND-only unmanaged devices into existing arpDevices
  const existingArpDevices = cache.get<ArpDiscoveredDevice[]>("arpDevices") ?? [];
  const macToArpDevice = new Map(existingArpDevices.map((d) => [normalizeMac(d.mac), d]));

  const ndOnlyDevices: ArpDiscoveredDevice[] = [];
  for (const [mac, info] of ndUnmanaged) {
    const existing = macToArpDevice.get(mac);
    if (existing) {
      // Enrich existing ARP entry with IPv6 addresses
      const ipSet = new Set(existing.ips);
      for (const ip of info.ips) {
        if (!ipSet.has(ip)) { existing.ips.push(ip); ipSet.add(ip); }
      }
      continue;
    }
    const siteId = info.location.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    ndOnlyDevices.push({
      mac,
      macs: [mac],
      ips: [...info.ips],
      vendor: info.vendor || lookupVendor(mac),
      location: info.location,
      siteId,
      seenByHostname: info.seenByHostname,
      seenByInterface: info.seenByPort,
      seenByIp: undefined,
      seenByMac: undefined,
    });
  }

  if (ndOnlyDevices.length > 0) {
    cache.set("arpDevices", [...existingArpDevices, ...ndOnlyDevices], TTL.PORTS);
  }

  console.log(`[poller] ND: ${totalEntries} entries scanned, ${ndGlobalIpv6.size} managed devices enriched, ${ndOnlyDevices.length} ND-only unmanaged devices`);
  buildAndCacheTopology();
```

with:

```ts
  // Merge ND-only unmanaged devices into the registry
  let ndOnlyNewCount = 0;
  let ndEnrichedCount = 0;
  for (const [mac, info] of ndUnmanaged) {
    const existing = arpDeviceRegistry.get(mac);
    if (existing) {
      // Enrich existing ARP-sourced record with IPv6 addresses
      const ipSet = new Set(existing.ips);
      const mergedIps = [...existing.ips];
      for (const ip of info.ips) {
        if (!ipSet.has(ip)) { mergedIps.push(ip); ipSet.add(ip); }
      }
      arpDeviceRegistry.upsert({ ...existing, ips: mergedIps });
      ndEnrichedCount++;
      continue;
    }
    const siteId = info.location.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    arpDeviceRegistry.upsert({
      mac,
      macs: [mac],
      ips: [...info.ips],
      vendor: info.vendor || lookupVendor(mac),
      location: info.location,
      siteId,
      seenByHostname: info.seenByHostname,
      seenByInterface: info.seenByPort,
      seenByIp: undefined,
      seenByMac: undefined,
    });
    ndOnlyNewCount++;
  }

  console.log(`[poller] ND: ${totalEntries} entries scanned, ${ndGlobalIpv6.size} managed devices enriched, ${ndOnlyNewCount} new ND-only devices, ${ndEnrichedCount} existing devices enriched with IPv6`);
  buildAndCacheTopology();
```

- [ ] **Step 5: Move staleness/eviction/diff logic into `buildAndCacheTopology`**

In `backend/src/jobs/poller.ts`, replace this line (currently line 189):

```ts
  const arpDevices = cache.get<ArpDiscoveredDevice[]>("arpDevices") ?? [];
```

with:

```ts
  const arpDevices = arpDeviceRegistry.publish();

  const currArpDevices = new Set(arpDevices.map(d => {
    const mac = d.mac.replace(/(.{2})(?=.)/g, "$1:");
    return `${mac} at ${d.location}`;
  }));
  prevAssets.arpDevices = diffAndLog("discovered-device", prevAssets.arpDevices, currArpDevices);
```

This is the fix for the eviction-toast gap identified during design review: the diff now runs against the registry's own post-eviction snapshot (computed inside `buildAndCacheTopology`, which every eviction passes through), instead of `pollArpLinks`'s local per-cycle snapshot which never observed eviction.

- [ ] **Step 6: Type-check the backend**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. (If `ArpDiscoveredDevice` or `normalizeMac` show as unused-import errors, remove them from the relevant import lines — `normalizeMac` is still used elsewhere in `pollNdNeighbours`/`pollArpLinks` for MAC lookups, so it should remain; only `ArpDiscoveredDevice` is expected to become unused, which Step 1 already handled.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/jobs/poller.ts
git commit -m "$(cat <<'EOF'
feat: wire ArpDeviceRegistry into poller, fix eviction-toast gap

pollArpLinks and pollNdNeighbours now upsert into the registry instead
of overwriting the arpDevices cache key each cycle. buildAndCacheTopology
publishes the registry (with staleness/eviction applied) and now owns
the discovered-device add/remove diff, so the "removed" toast actually
fires on 24h eviction instead of never firing.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Backend end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full workspace build**

Run: `cd /home/jkumar/Librenms-dash && docker-compose up -d --build`
Expected: build succeeds, container starts and stays up (`docker-compose ps` shows `librenms-dash` as `Up`).

- [ ] **Step 2: Confirm poller logs show the new registry-based flow**

Run: `docker-compose logs -f librenms-dash | grep -E "\[poller\] (ARP|ND):"`
Expected (within a few minutes, once poll cycles run): lines like
```
[poller] ARP: upserted N discovered devices, M links, K LAN IPs from ... ARP entries
[poller] ND: X entries scanned, Y managed devices enriched, Z new ND-only devices, W existing devices enriched with IPv6
```
No errors or unhandled rejections in the logs.

- [ ] **Step 3: Confirm the API payload carries the new fields**

Run: `curl -s http://localhost:3001/api/topology | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(JSON.stringify(d.arpDevices[0], null, 2))"`
Expected: the first discovered device object includes `firstSeen`, `lastSeen` (ISO 8601 strings) and `stale: false` (assuming it was just polled).

---

## Task 4: Frontend — thread `stale`/`lastSeen`, dim stale nodes, show "Last seen" in tooltip

**Files:**
- Modify: `frontend/src/hooks/useForceLayout.ts:68-79` (interface), `:365-380` (construction)
- Modify: `frontend/src/components/ArpDeviceNode.tsx`
- Modify: `frontend/src/components/DevicePopover.tsx` (export existing `formatTimestamp` helper)
- Modify: `frontend/src/components/LinkTooltip.tsx`
- Modify: `frontend/src/components/TopologyMap.tsx` (two `LinkTooltipData` construction sites for `arp-device`, and the `ArpDeviceNode` render call)

**Interfaces:**
- Consumes: `TopologyResponse.arpDevices[].stale: boolean` and `.lastSeen: string` (Task 2/3).
- Produces: `ArpDeviceLayoutNode.stale: boolean`, `.lastSeen: string` for `TopologyMap.tsx` to read; `LinkTooltipData.stale?: boolean`, `.lastSeen?: string` for `LinkTooltip.tsx` to render.

- [ ] **Step 1: Thread `stale`/`lastSeen` through `ArpDeviceLayoutNode`**

In `frontend/src/hooks/useForceLayout.ts`, the interface (currently lines 68-79):

```ts
export interface ArpDeviceLayoutNode {
  mac: string;
  ips: string[];
  vendor: string;
  siteId: string;
  seenByHostname: string;
  seenByInterface?: string;
  seenByIp?: string;
  seenByMac?: string;
  x: number;
  y: number;
}
```

becomes:

```ts
export interface ArpDeviceLayoutNode {
  mac: string;
  ips: string[];
  vendor: string;
  siteId: string;
  seenByHostname: string;
  seenByInterface?: string;
  seenByIp?: string;
  seenByMac?: string;
  stale: boolean;
  lastSeen: string;
  x: number;
  y: number;
}
```

And its construction (currently lines 368-379):

```ts
        allArpDeviceNodes.push({
          mac: ad.mac,
          ips: ad.ips,
          vendor: ad.vendor,
          siteId: site.id,
          seenByHostname: ad.seenByHostname,
          seenByInterface: ad.seenByInterface,
          seenByIp: ad.seenByIp,
          seenByMac: ad.seenByMac,
          x: arpStartX + ARP_NODE_W / 2 + col * (ARP_NODE_W + ARP_NODE_GAP_X),
          y: arpStartY + ARP_SECTION_LABEL_H + ARP_SECTION_PAD + ARP_NODE_H / 2 + row * (ARP_NODE_H + ARP_NODE_GAP_Y),
        });
```

becomes:

```ts
        allArpDeviceNodes.push({
          mac: ad.mac,
          ips: ad.ips,
          vendor: ad.vendor,
          siteId: site.id,
          seenByHostname: ad.seenByHostname,
          seenByInterface: ad.seenByInterface,
          seenByIp: ad.seenByIp,
          seenByMac: ad.seenByMac,
          stale: ad.stale,
          lastSeen: ad.lastSeen,
          x: arpStartX + ARP_NODE_W / 2 + col * (ARP_NODE_W + ARP_NODE_GAP_X),
          y: arpStartY + ARP_SECTION_LABEL_H + ARP_SECTION_PAD + ARP_NODE_H / 2 + row * (ARP_NODE_H + ARP_NODE_GAP_Y),
        });
```

- [ ] **Step 2: Dim `ArpDeviceNode` when stale**

`node: ArpDeviceLayoutNode` already carries `stale` (from Step 1), so no prop-type change is needed — only the render logic changes.

In `frontend/src/components/ArpDeviceNode.tsx`, change (currently line 26):

```ts
  const active = isHovered || highlighted || searchMatch;
```

to:

```ts
  const active = isHovered || highlighted || searchMatch;
  const dimmed = node.stale && !active;
```

and change the box `<rect>` (currently lines 59-71):

```ts
      <rect
        x={x}
        y={y}
        width={BOX_W}
        height={BOX_H}
        rx={6}
        fill={active ? "#1e293b" : "#0f172a"}
        fillOpacity={searchMatch ? 0.95 : isHovered ? 0.88 : highlighted ? 0.8 : 0.65}
        stroke={searchMatch ? "#facc15" : "#fbbf24"}
        strokeWidth={searchMatch ? 2.5 : active ? 1.5 : 1}
        strokeOpacity={active ? 0.8 : 0.4}
        className={searchMatch ? "search-match-box" : undefined}
      />
```

to:

```ts
      <rect
        x={x}
        y={y}
        width={BOX_W}
        height={BOX_H}
        rx={6}
        fill={active ? "#1e293b" : "#0f172a"}
        fillOpacity={searchMatch ? 0.95 : isHovered ? 0.88 : highlighted ? 0.8 : dimmed ? 0.3 : 0.65}
        stroke={searchMatch ? "#facc15" : "#fbbf24"}
        strokeWidth={searchMatch ? 2.5 : active ? 1.5 : 1}
        strokeOpacity={active ? 0.8 : dimmed ? 0.2 : 0.4}
        className={searchMatch ? "search-match-box" : undefined}
      />
```

Also add `stale?: boolean;` — no, `stale` is a required field on `ArpDeviceLayoutNode` (set in Step 1), so `node.stale` is always defined; no prop-type change needed on `Props` since `node: ArpDeviceLayoutNode` already carries it.

- [ ] **Step 3: Export the existing relative-time formatter**

In `frontend/src/components/DevicePopover.tsx`, the private helper (currently around lines 30-43):

```ts
function formatTimestamp(ts: string): string {
```

becomes:

```ts
export function formatTimestamp(ts: string): string {
```

(No other change — reused as-is to avoid duplicating relative-time logic (DRY). It already handles ISO 8601 strings correctly since `ts.replace(" ", "T")` is a no-op when "T" is already present.)

- [ ] **Step 4: Add `stale`/`lastSeen` to `LinkTooltipData` and render a conditional row**

In `frontend/src/components/LinkTooltip.tsx`, add to the `LinkTooltipData` interface (currently lines 27-30):

```ts
  // ARP discovered device
  interface?: string;
  vendor?: string;
  sourceMac?: string;
```

becomes:

```ts
  // ARP discovered device
  interface?: string;
  vendor?: string;
  sourceMac?: string;
  stale?: boolean;
  lastSeen?: string;
```

Add the import at the top (line 1):

```ts
import { Copyable } from "./Copyable";
```

becomes:

```ts
import { Copyable } from "./Copyable";
import { formatTimestamp } from "./DevicePopover";
```

And in the `arp-device` table body, add a "Last seen" row after the MAC row (currently line 94):

```ts
            <Row label="MAC" value={data.mac ?? "—"} mono copyable />
          </tbody>
        </table>
      ) : data.type === "arp" ? (
```

becomes:

```ts
            <Row label="MAC" value={data.mac ?? "—"} mono copyable />
            {data.stale && data.lastSeen && <Row label="Last seen" value={formatTimestamp(data.lastSeen)} />}
          </tbody>
        </table>
      ) : data.type === "arp" ? (
```

- [ ] **Step 5: Pass `stale`/`lastSeen` from `TopologyMap.tsx` into both tooltip builders and the node**

In `frontend/src/components/TopologyMap.tsx`, the connector-line hover tooltip (currently lines 1182-1197):

```ts
                  onMouseEnter={(e) => showLinkTooltip(key, {
                    type: "arp-device",
                    screenX: e.clientX,
                    screenY: e.clientY,
                    sourceHostname: ad.seenByHostname,
                    targetHostname: ad.mac,
                    sourceDisplayName: displayName(ad.seenByHostname),
                    targetDisplayName: ad.vendor || "Unknown device",
                    color: ARP_COLOR,
                    sourceIp: ad.seenByIp ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
                    targetIps: ad.ips,
                    mac: formatMac(ad.mac),
                    interface: ad.seenByInterface,
                    sourceMac: ad.seenByMac ? formatMac(ad.seenByMac) : undefined,
                    vendor: ad.vendor,
                  })}
```

becomes:

```ts
                  onMouseEnter={(e) => showLinkTooltip(key, {
                    type: "arp-device",
                    screenX: e.clientX,
                    screenY: e.clientY,
                    sourceHostname: ad.seenByHostname,
                    targetHostname: ad.mac,
                    sourceDisplayName: displayName(ad.seenByHostname),
                    targetDisplayName: ad.vendor || "Unknown device",
                    color: ARP_COLOR,
                    sourceIp: ad.seenByIp ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
                    targetIps: ad.ips,
                    mac: formatMac(ad.mac),
                    interface: ad.seenByInterface,
                    sourceMac: ad.seenByMac ? formatMac(ad.seenByMac) : undefined,
                    vendor: ad.vendor,
                    stale: ad.stale,
                    lastSeen: ad.lastSeen,
                  })}
```

And the node hover tooltip builder (currently lines 1216-1231):

```ts
            const tooltip = (e: { clientX: number; clientY: number }): LinkTooltipData => ({
              type: "arp-device",
              screenX: e.clientX,
              screenY: e.clientY,
              sourceHostname: ad.seenByHostname,
              targetHostname: ad.mac,
              sourceDisplayName: displayName(ad.seenByHostname),
              targetDisplayName: ad.vendor || "Unknown device",
              color: ARP_COLOR,
              sourceIp: ad.seenByIp ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
              targetIps: ad.ips,
              mac: formatMac(ad.mac),
              interface: ad.seenByInterface,
              sourceMac: ad.seenByMac ? formatMac(ad.seenByMac) : undefined,
              vendor: ad.vendor,
            });
```

becomes:

```ts
            const tooltip = (e: { clientX: number; clientY: number }): LinkTooltipData => ({
              type: "arp-device",
              screenX: e.clientX,
              screenY: e.clientY,
              sourceHostname: ad.seenByHostname,
              targetHostname: ad.mac,
              sourceDisplayName: displayName(ad.seenByHostname),
              targetDisplayName: ad.vendor || "Unknown device",
              color: ARP_COLOR,
              sourceIp: ad.seenByIp ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
              targetIps: ad.ips,
              mac: formatMac(ad.mac),
              interface: ad.seenByInterface,
              sourceMac: ad.seenByMac ? formatMac(ad.seenByMac) : undefined,
              vendor: ad.vendor,
              stale: ad.stale,
              lastSeen: ad.lastSeen,
            });
```

The `<ArpDeviceNode node={ad} ... />` call (currently line 1233-1241) needs no change — `node` is already the full `ArpDeviceLayoutNode`, which now carries `stale` (Step 1), and `ArpDeviceNode` reads `node.stale` directly (Step 2).

- [ ] **Step 6: Type-check the frontend**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useForceLayout.ts frontend/src/components/ArpDeviceNode.tsx frontend/src/components/DevicePopover.tsx frontend/src/components/LinkTooltip.tsx frontend/src/components/TopologyMap.tsx
git commit -m "$(cat <<'EOF'
feat: dim stale discovered devices and show last-seen in tooltip

Threads stale/lastSeen from the topology payload through the layout
hook into ArpDeviceNode (dimmed when stale, still fully interactive on
hover) and LinkTooltip (a "Last seen" row shown only for stale
devices). Reuses DevicePopover's existing relative-time formatter.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full-stack manual verification in the browser

**Files:** none (verification only)

- [ ] **Step 1: Build and start**

Run: `cd /home/jkumar/Librenms-dash && docker-compose up -d --build`
Expected: build succeeds, container up.

- [ ] **Step 2: Confirm live devices render unchanged**

Open the app in a browser, enable the "Discovered" layer, hover a discovered device that's currently live. Confirm: node renders at normal opacity (not dimmed), tooltip does NOT show a "Last seen" row (since `stale` is false for a freshly-polled device).

- [ ] **Step 3: Confirm dimming and tooltip for a stale device**

This requires either waiting ~15 minutes for a real device to stop responding, or a quick local smoke test: temporarily lower `STALE_THRESHOLD_MS` in `backend/src/jobs/arpDeviceRegistry.ts` to e.g. `10 * 1000` (10 seconds), rebuild (`docker-compose up -d --build`), wait ~10 seconds without that device's poll refreshing (or just observe any device that hasn't been re-confirmed yet on first startup, since the registry starts empty and the first poll cycle's devices won't be "stale" until 10s pass without a second poll). Confirm: the node dims, and hovering shows a "Last seen: Xs ago"-style row. **Revert the temporary threshold change** back to `15 * 60 * 1000` before finishing, and rebuild once more to confirm the revert is clean.

- [ ] **Step 4: Confirm no regressions in existing features**

Spot-check: managed-device nodes, LLDP/CDP links, overlay links, and the existing ARP connector lines all still render and hover correctly (unrelated to this change, but touched files are shared with other tooltip/layout code).
