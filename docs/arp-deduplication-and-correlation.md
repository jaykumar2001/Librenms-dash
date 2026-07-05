# ARP Deduplication and Correlation Design

This document describes how the backend resolves, deduplicates, and correlates managed devices, ARP-discovered (unmanaged) devices, and the links between them.

## Overview

The pipeline runs inside `pollArpLinks` (called from `pollPortsAndIps`), `pollNdNeighbours`, and `consolidateArpDevices`. It produces three outputs for the topology response:

| Output          | Type                    | Storage                                    | Contents                                              |
|-----------------|-------------------------|---------------------------------------------|--------------------------------------------------------|
| `arpLinks`      | `ArpLink[]`             | `cache.set("arpLinks", ...)`, 5-min TTL     | Peer relationships between two managed devices        |
| `arpDevices`    | `ArpDiscoveredDevice[]` | `ArpDeviceRegistry` (in-memory Map, keyed by MAC, no TTL expiry — see Stage 5) | Consolidated unmanaged devices seen in ARP/ND, with `firstSeen`/`lastSeen`/`stale` |
| `arpLanIps`     | `Map<string, string>`   | `cache.set("arpLanIps", ...)`, 5-min TTL    | LAN IP override for managed devices polled via overlay |

`arpDevices` is **not** a plain TTL-cached key (unlike the other two) — as of 2026-07-03 it's backed by `ArpDeviceRegistry` (`backend/src/jobs/arpDeviceRegistry.ts`), which persists devices by MAC across poll cycles instead of being rebuilt from scratch each time. See Stage 5.

---

## Stage 0 — Managed Device Filtering

**File:** `backend/src/jobs/poller.ts` → `pollDevicesAndLocations`

- Devices with `disabled === 1` are excluded from the active set before caching.
- They are still stored separately under `allDevicesForExclusion`. This ensures their IPs and interface MACs are always included in the managed exclusion sets, preventing them from re-appearing as unmanaged discovered devices.

---

## Stage 1 — Exclusion Set Construction

Before any ARP analysis, two per-location exclusion sets are built so that managed infrastructure is never treated as an unmanaged discovered device.

### 1a — Managed IPs by location (`managedIpsByLocation`)

For every device in `allDevicesForExclusion`:
- Add `device.ip`
- Add every `ipv4_address` from that device's cached `/ip` response

Scoped per location because LAN subnets can overlap across sites (e.g. `192.168.1.0/24` at both BLR and GGN are physically separate networks).

### 1b — Managed MACs by location (`managedMacsByLocation`)

Two sub-steps:

1. **ARP-derived:** Walk all collected ARP entries. If an entry's IP matches a managed IP at that location, add its normalized MAC to the location's set.
2. **Interface-derived:** For every device in `allDevicesForExclusion`, add all `ifPhysAddress` values from its port cache. This ensures a managed device's own interfaces never appear as ghost discovered devices, even if their IP endpoint fails or returns an overlay address.

---

## Stage 2 — ARP Link Building (Managed ↔ Managed)

**File:** `backend/src/jobs/poller.ts` → `pollArpLinks`

Links represent peer visibility between two managed devices on the same physical LAN.

### Pass 1 — IP-based matching

For each unique local IP owned by a managed device:
1. Fetch `/resources/ip/arp/<ip>` from LibreNMS.
2. For each ARP entry returned, look up `entry.device_id` → `seeingHostname`.
3. If `seeingHostname` differs from the IP owner and both are in the same location, a link candidate exists.
4. Deduplicate using a canonical key: `[ownerHostname, seeingHostname].sort().join("<>")`. Bidirectional duplicates (A sees B, B sees A) collapse into one link.

### Pass 2 — MAC-based matching

Catches managed devices whose `/ip` endpoint fails or 404s. For each ARP entry across the full corpus:
1. Normalize `entry.mac_address` and look it up in `macToHostname` (built from interface MACs of all active devices).
2. If the MAC owner differs from the seer and they share a location, create a link.
3. Use the same `linkSet` as Pass 1 — no duplicate is added if Pass 1 already covered the pair.

### Exclusions (both passes)

| Exclusion | Reason |
|-----------|--------|
| Overlay/VPN IPs (`isExcludedArpIp`) | ZeroTier, WireGuard, etc. are logical, not physical |
| Docker bridge IPs (`isDockerIp`) | Container-internal traffic |
| Excluded interfaces (`isExcludedIface`) | Loopback, `docker0`, overlay tunnels |
| Cross-location pairs | LAN subnets overlap; cross-site ARP is not meaningful |

---

## Stage 3 — ARP Discovered Device Consolidation

**File:** `backend/src/jobs/poller.ts` → `consolidateArpDevices`

Unmanaged devices (not in LibreNMS) that appear in ARP tables are consolidated into deduplicated `ArpDiscoveredDevice` records. The key challenge is that a single physical device may appear under multiple MACs (e.g. two NICs) or multiple IPs (DHCP churn, dual-stack aliases), observed by several scanners.

### Phase 1 — Valid pair collection

Walk all ARP entries. For each entry, a `(mac, ip)` pair is accepted only if:

- Source `device_id` belongs to an active (non-disabled) device
- MAC is not `000000000000`, `FFFFFFFFFFFF`
- MAC passes the bogus-pattern check (no all-zero suffix, no all-same-byte pattern)
- IP is not `0.0.0.0`
- IP is not in an overlay or excluded subnet
- Interface is not excluded (`isExcludedIface`)
- Neither the IP nor the MAC appears in the managed exclusion sets for that location

Pairs are scoped to a location. Exact `(location, mac, ip)` duplicates are collapsed immediately.

### Phase 2 — Union-Find merging

Within each location, a path-compressed union-find merges entries that share a MAC **or** an IP:

```
Keys: "mac:<normalized-hex>" and "ip:<addr>"
Rule: union(mac-key, ip-key) for every (mac, ip) pair
```

This handles:
- Same device seen at two IPs → both IPs end up in one component
- Same IP observed with two different MACs → both MACs merge into one component
- Transitive chains: MAC₁ ↔ IP₁ ↔ MAC₂ → single device with two MACs and one IP

Merging is **location-scoped** to prevent cross-site false merges from overlapping subnets.

### Phase 3 — Component grouping

After union-find, entries are grouped by their root node. Each component accumulates:
- `macs: Set<string>` — all normalized MACs in the component
- `ips: Set<string>` — all IPs in the component
- `deviceId` / `portId` from the first pair that formed the component (used for `seenBy*` metadata)

### Phase 4 — Representative MAC selection

One `ArpDiscoveredDevice` is emitted per component. The best MAC is chosen by:

1. **Prefer globally-administered over locally-administered** (bit 1 of first byte unset = OUI-registered hardware address)
2. **Among globals, prefer MACs with a known OUI vendor** (via OUI database lookup)

IPs are sorted numerically. Output fields:

| Field              | Source                                                    |
|--------------------|-----------------------------------------------------------|
| `mac`              | Best MAC (above selection)                                |
| `macs`             | All MACs in component                                     |
| `ips`              | All IPs in component, numerically sorted                  |
| `vendor`           | OUI lookup on best MAC                                    |
| `location`         | Site name                                                 |
| `siteId`           | URL-safe slug of location                                 |
| `seenByHostname`   | Managed device that first observed this component         |
| `seenByInterface`  | Interface name on the seer (`portIdToIfName`)             |
| `seenByIp`         | Local IP of the seer's port (`portIdToIp`)                |
| `seenByMac`        | MAC of the seer's port (`portIdToMac`)                    |

---

## Stage 4 — ARP LAN IP Discovery

**File:** `backend/src/jobs/poller.ts` → `pollArpLinks` (after consolidation)

Managed devices polled exclusively via overlay (VPN) may have no usable LAN IP in their `/ip` response. To resolve this:

1. Scan all ARP entries for MACs that match a managed device's interface MAC (`macToHostname`).
2. If the associated IP is not an overlay, docker-bridge, or excluded subnet IP, record it as that device's LAN IP in `arpLanIps`.

**Used in:** `topology.ts:63–65` — if a managed device's computed `lanIp` falls in an overlay range, it is replaced with the ARP-discovered LAN IP.

---

## Stage 5 — Staleness & Retention

**File:** `backend/src/jobs/arpDeviceRegistry.ts`, wired into `pollArpLinks` / `pollNdNeighbours` / `buildAndCacheTopology` in `poller.ts`

A discovered device is no longer dropped the instant it misses a single poll cycle (e.g. a device that's briefly powered off). `ArpDeviceRegistry` is a persistent `Map<mac, record>`:

- **`upsert(fields, now)`** — called once per matching device on every `pollArpLinks` and `pollNdNeighbours` run. Preserves `firstSeen` from the prior record if one exists; always advances `lastSeen` to `now`; replaces all other fields with the current snapshot (ARP is authoritative when both ARP and ND see the same MAC in the same cycle — ND enrichment only adds IPv6 addresses to an existing ARP-sourced record, via `get()` + spread, never wholesale-replaces it).
- **`publish(now)`** — called from `buildAndCacheTopology()` every cycle. For each record: if `now - lastSeen > 24h` (`RETENTION_MS`), delete it and omit from the result. Otherwise emit it with `stale: now - lastSeen > 15min` (`STALE_THRESHOLD_MS`) and `firstSeen`/`lastSeen` converted to ISO 8601 strings.

15 minutes is 3× the 5-minute poll cadence (see the topology-dataflow project memory / `DEVICE_POLL_MS`/`TTL.PORTS` in `poller.ts`) — long enough that a device isn't flagged stale just from ordinary poll timing jitter.

**Frontend:** a `stale` device's node dims (`ArpDeviceNode.tsx`) but stays fully interactive on hover; its tooltip (`LinkTooltip.tsx`) shows a "Last seen" row only while stale.

**Add/remove notifications:** the `discovered-device` asset-change diff (which drives the toast notifications in `AssetEventToast.tsx`) is computed inside `buildAndCacheTopology()`, against the registry's *post-eviction* published array — not inside `pollArpLinks` against its own per-cycle snapshot. This means: a brand-new MAC fires "added" once; a device going stale fires nothing (it's still in the published array, just dimmed); only actual 24h eviction fires "removed".

---

## LLDP/CDP Neighbor Link Deduplication

**File:** `backend/src/routes/topology.ts:104–131`

Neighbor links from LibreNMS's LLDP/CDP data are deduplicated using a canonical key:

```
key = [local_device_id, remote_device_id].sort().join("-")
    + ":" + [local_port_id, remote_port_id].sort().join("-")
```

This collapses A→B and B→A entries for the same physical port pair into a single `NeighborLink`. Excluded interfaces are filtered before the key is computed.

---

## Data Flow Summary

```
LibreNMS API
    │
    ├─ /devices              → active devices + allDevicesForExclusion
    ├─ /devices/:h/ports     → ports, MACs, traffic rates
    ├─ /devices/:h/ip        → IP assignments
    ├─ /resources/ip/arp/:ip → ARP table per managed IP   ─┐
    └─ /resources/ip/arp/all → full ARP corpus            ─┘
                                                            │
                                          ┌─────────────────▼──────────────────┐
                                          │  Stage 1: Build exclusion sets      │
                                          │  (managedIpsByLocation,             │
                                          │   managedMacsByLocation)            │
                                          └─────────────────┬──────────────────┘
                                                            │
                                          ┌─────────────────▼──────────────────┐
                                          │  Stage 2: ARP link building         │
                                          │  Pass 1 (IP-based) +               │
                                          │  Pass 2 (MAC-based fallback)        │
                                          │  → arpLinks[]                       │
                                          └─────────────────┬──────────────────┘
                                                            │
                                          ┌─────────────────▼──────────────────┐
                                          │  Stage 3: Consolidate discovered    │
                                          │  Phase 1: filter pairs              │
                                          │  Phase 2: union-find per location   │
                                          │  Phase 3: group by component        │
                                          │  Phase 4: pick best MAC             │
                                          │  → ArpDeviceRegistry.upsert() per   │
                                          │    device (ARP path); ND path also  │
                                          │    upserts/enriches the same        │
                                          │    registry from pollNdNeighbours   │
                                          └─────────────────┬──────────────────┘
                                                            │
                                          ┌─────────────────▼──────────────────┐
                                          │  Stage 4: ARP LAN IP discovery      │
                                          │  → arpLanIps (Map<hostname, ip>)    │
                                          └─────────────────┬──────────────────┘
                                                            │
                                          ┌─────────────────▼──────────────────┐
                                          │  Stage 5: buildAndCacheTopology()   │
                                          │  → ArpDeviceRegistry.publish():     │
                                          │    evict if lastSeen > 24h,         │
                                          │    stale if lastSeen > 15min        │
                                          │  → arpDevices[] in TopologyResponse │
                                          └────────────────────────────────────┘
```
