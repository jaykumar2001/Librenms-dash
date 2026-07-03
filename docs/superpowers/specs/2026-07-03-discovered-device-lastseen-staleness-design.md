# Discovered-Device lastSeen / Staleness Tracking

**Date:** 2026-07-03
**Status:** Approved

## Problem

`ArpDiscoveredDevice` (ARP/ND-discovered, unmanaged devices shown in the topology) carries no timestamp of any kind. The `arpDevices` array is fully rebuilt from the live ARP/ND snapshot every poll cycle, so a device that misses a single cycle — e.g. powered off temporarily in a home-lab scenario — simply vanishes from the topology instantly, with no record it was ever seen or how long ago.

## Goals

1. Track `firstSeen` / `lastSeen` per discovered device.
2. Don't drop a device from the topology the instant one poll cycle misses it — keep it visible (dimmed) for a grace period, then remove it.
3. Surface "last seen" in the UI for devices that have gone stale.

## Non-Goals

- Cross-restart persistence. The app has no database (verified: no DB dependency in `backend/package.json`, no DB service in `docker-compose.yaml` — LibreNMS's API is the source of truth, everything else lives in an in-memory `TTLCache`). Introducing a database is out of scope for this feature; `firstSeen`/`lastSeen` reset on backend restart, consistent with how `arpDevices`/`assetEvents` already behave.
- "First seen" UI display. The field is persisted (cheap, and useful later) but not shown in the tooltip in this iteration.
- Per-source (ARP vs ND) staleness thresholds. A single wall-clock threshold is used instead of tracking "was this MAC reconfirmed in the most recent pass of each poll type."

---

## Design

### 1. Backend: persistent registry replaces per-cycle overwrite

**`backend/src/jobs/poller.ts`** — new module-level store:

```ts
interface ArpDeviceRecord extends Omit<ArpDiscoveredDevice, "firstSeen" | "lastSeen" | "stale"> {
  firstSeen: number; // epoch ms
  lastSeen: number;  // epoch ms
}

const arpDeviceRegistry = new Map<string, ArpDeviceRecord>(); // keyed by normalized MAC

function upsertArpDevice(fields: Omit<ArpDeviceRecord, "firstSeen" | "lastSeen">) {
  const now = Date.now();
  const existing = arpDeviceRegistry.get(fields.mac);
  arpDeviceRegistry.set(fields.mac, {
    ...fields,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  });
}
```

**`pollArpLinks`** (`poller.ts:632` area): after `consolidateArpDevices` produces this cycle's ARP-visible devices, call `upsertArpDevice()` for each instead of writing the array directly to `cache`. Devices absent from this cycle's ARP snapshot are left untouched in the registry — their `lastSeen` just ages.

**`pollNdNeighbours`** (`poller.ts:890` area): same treatment for each `ndUnmanaged` entry — call `upsertArpDevice()`.

**Removes existing special-case code**: the "preserve ND-only discovered devices" carve-out (`poller.ts:651-659` — `prevArpDevices`, `consolidatedMacs`, `ndOnlyPrev`, `finalArpDevices`) exists only because today's code has no proper merge-by-MAC. The registry retains ND-only devices naturally, so this ~10-line block is deleted, not extended.

### 2. Staleness computation & eviction

Done once per cycle in `buildAndCacheTopology()`:

```ts
const STALE_THRESHOLD_MS = 15 * 60 * 1000;      // 3x ND poll cycle (TTL.PORTS = 5min)
const RETENTION_MS = 24 * 60 * 60 * 1000;        // full removal

const now = Date.now();
const arpDevices: ArpDiscoveredDevice[] = [];
for (const [mac, rec] of arpDeviceRegistry) {
  if (now - rec.lastSeen > RETENTION_MS) {
    arpDeviceRegistry.delete(mac);
    continue;
  }
  arpDevices.push({
    ...rec,
    firstSeen: new Date(rec.firstSeen).toISOString(),
    lastSeen: new Date(rec.lastSeen).toISOString(),
    stale: now - rec.lastSeen > STALE_THRESHOLD_MS,
  });
}
```

- **15-minute stale threshold** (3× the 5-minute ND poll cycle) avoids flicker for ND-only devices, which would otherwise be falsely marked stale between their own poll passes.
- **24-hour retention** before full removal from the registry and the published `arpDevices` array.

### 3. Side effect: `AssetEvent` toast behavior improves for free

`diffAndLog("discovered-device", ...)` (`poller.ts:669`) diffs the published `arpDevices` set cycle-to-cycle to fire "added"/"removed" toasts. Since the published array now includes stale-but-retained devices, "removed" only fires on actual 24h eviction (not on a single missed cycle), and "added" only fires on a genuinely first-ever sighting (not every time a stale device gets reconfirmed within the 24h window). No additional code needed — this falls out of the data model change.

### 4. Shared types

**`shared/types.ts`** — `ArpDiscoveredDevice` gains:

```ts
export interface ArpDiscoveredDevice {
  // ...existing fields unchanged...
  firstSeen: string;  // ISO 8601
  lastSeen: string;   // ISO 8601
  stale: boolean;
}
```

### 5. Frontend

**`frontend/src/hooks/useForceLayout.ts`**: thread `stale` and `lastSeen` through `ArpDeviceLayoutNode` (`:68-71`) and its construction (`:369-371`), the same way `vendor`/`mac`/`ips` already flow from `TopologyResponse.arpDevices` into the layout node.

**`frontend/src/components/ArpDeviceNode.tsx`**: add a `stale?: boolean` prop. When `stale && !active`, reduce `fillOpacity`/`strokeOpacity` below their current baseline (box ~0.65 → ~0.3, border ~0.4 → ~0.2). Hovering (`isHovered`) restores full visibility exactly like the existing `active` branch — a stale device is still fully inspectable, just visually deprioritized when not interacted with.

**`frontend/src/components/TopologyMap.tsx`** (where `LinkTooltipData` is built for a hovered `ArpDeviceNode`, `~1186-1228`) and **`frontend/src/components/LinkTooltip.tsx`**: add a "Last seen" `Row`, rendered only when `stale` is true. Format as relative time ("3h ago") with the exact ISO timestamp in a `title` attribute for precision on hover.

**No changes** to `AssetEventToast.tsx` — it renders whatever `AssetEvent`s arrive over SSE; part 3's change to *when* those fire is transparent to it.

---

## Data Flow (After)

```
pollArpLinks / pollNdNeighbours (independent cadences)
  → upsertArpDevice() per discovered MAC: keep firstSeen, refresh lastSeen + fields
  → arpDeviceRegistry (module-level Map, in-memory, no cross-restart persistence)

buildAndCacheTopology() (every cycle)
  → evict registry entries with lastSeen > 24h old
  → compute stale = lastSeen > 15min old
  → publish ArpDiscoveredDevice[] with firstSeen/lastSeen/stale into TopologyResponse

SSE topology-changed → frontend setQueryData → useForceLayout threads stale/lastSeen
  → ArpDeviceNode dims when stale, LinkTooltip shows "Last seen: Xh ago"
```

---

## Files Changed

| File | Change |
|------|--------|
| `shared/types.ts` | `ArpDiscoveredDevice` gains `firstSeen`, `lastSeen`, `stale` |
| `backend/src/jobs/poller.ts` | New `arpDeviceRegistry` + `upsertArpDevice()`; `pollArpLinks`/`pollNdNeighbours` upsert instead of overwrite; `buildAndCacheTopology()` computes staleness/eviction; removes ND-only-preservation carve-out |
| `frontend/src/hooks/useForceLayout.ts` | Thread `stale`/`lastSeen` into `ArpDeviceLayoutNode` |
| `frontend/src/components/ArpDeviceNode.tsx` | `stale` prop dims the node when not hovered/highlighted |
| `frontend/src/components/TopologyMap.tsx` | Pass `stale`/`lastSeen` into `LinkTooltipData` for discovered-device hover |
| `frontend/src/components/LinkTooltip.tsx` | Conditional "Last seen" row |

---

## Testing

- **Backend unit test**: exercise `upsertArpDevice()` / the eviction logic directly (inject/mock `Date.now()`) — assert `firstSeen` stays fixed across repeated upserts of the same MAC, `lastSeen` advances, `stale` flips at the 15-minute boundary, and the entry is deleted at the 24-hour boundary.
- **Manual verification**: `docker-compose up -d --build`, confirm a live device renders normally, and confirm (via temporarily patching the stale/retention constants down for a local test run, or waiting out a real cycle) that a device that stops appearing in ARP/ND dims after 15 minutes and is removed after 24 hours, with the tooltip showing a correct relative "last seen" time.

## Trade-offs

- **No cross-restart persistence**: a backend restart resets all `firstSeen`/`lastSeen` history, same as the rest of the topology cache today. Accepted — adding a database is out of scope (see Non-Goals).
- **Single wall-clock stale threshold, not per-source**: an ARP-only device could theoretically be flagged stale a little later than the instant it truly vanishes (up to 15 min), since the threshold is sized for the slower ND cadence. Simpler than tracking per-source "reconfirmed this cycle" state; acceptable for v1.
- **Registry grows unbounded between evictions**: in practice bounded by the number of distinct MACs seen on the network in any 24h window, which is the same order of magnitude as today's `arpDevices` array — no new unbounded-growth risk.
