# Generic Overlay Network Model

## Problem

The current overlay system hardcodes three types (`zerotier | wireguard | tailscale`), builds full-mesh links across all members of a type regardless of subnet, and requires manual CIDR configuration. Adding a new overlay type requires changes in 4+ files. The model cannot represent hub-spoke topologies (plain WireGuard) or auto-discover overlay interfaces.

## Design Decisions

1. **Per-subnet linking** — only devices sharing the same subnet get linked (replaces full-mesh-per-type)
2. **Declarative definitions + generic engine** — `OverlayDefinition` interface for per-type data, `OverlayEngine` class for all shared behavior
3. **Two-pass auto-discovery** — Pass 1: interface pattern match seeds subnets; Pass 2: subnet sweep catches non-standard interface names (e.g., `vpn-office` instead of `wg0`)
4. **Interface-based scope** — no routing protocol discovery (BGP/OSPF are a future concern; the `SubnetGroup[]` output format is a universal contract a future `RoutingEngine` could also produce)
5. **Topology modes** — `mesh` (ZeroTier, Tailscale, Tinc, GRE) vs `hub-spoke` (WireGuard, OpenVPN, IPSec, PPTP), with sensible defaults per type
6. **Hub detection** — lowest IP in subnet group by default, overridable via env var
7. **Ambiguous patterns** — `tun*` classified as generic "tunnel" type, overridable via `OVERLAY_RECLASSIFY`

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 OverlayEngine                    │
│                                                  │
│  ┌──────────────┐   ┌──────────────────────────┐ │
│  │   Registry    │   │      Pipeline            │ │
│  │              │   │                          │ │
│  │ Definition[] │──▶│ discover()               │ │
│  │  (patterns,  │   │   Pass 1: pattern match  │ │
│  │   colors,    │   │   Pass 2: subnet sweep   │ │
│  │   topology)  │   │                          │ │
│  │              │   │ groupBySubnet()           │ │
│  │ + env        │   │   key: (type, subnet)    │ │
│  │   overrides  │   │                          │ │
│  └──────────────┘   │ buildLinks()             │ │
│                     │   mesh: all pairs         │ │
│                     │   hub-spoke: hub↔spokes   │ │
│                     └──────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Core Types

### OverlayDefinition (backend only)

Static configuration for an overlay type. Lives in the backend (`overlayEngine.ts`) because it contains `RegExp` which cannot be serialized to JSON. The frontend receives per-type metadata via `SubnetGroup` fields (`overlayType`, `color`, `label`, `topology`).

```typescript
interface OverlayDefinition {
  type: string;                          // "zerotier", "wireguard", "tunnel", etc.
  ifPattern: RegExp;                     // Interface name pattern
  color: string;                         // Display color (hex)
  label: string;                         // Human-readable name
  topology: 'mesh' | 'hub-spoke';        // Link building strategy
}
```

### OverlayMember (backend only)

A discovered overlay interface on a specific device. Internal to the engine pipeline — not sent to the frontend. Produced by discovery, consumed by grouping. The `members` field on `SubnetGroup` is omitted from the API response (used only for link building).

```typescript
interface OverlayMember {
  hostname: string;
  ifName: string;                        // "zt0", "wg1", "vpn-office"
  ip: string;                            // Overlay IP address
  prefixLen: number;                     // From LnmsDeviceIp.ipv4_prefixlen
  subnet: string;                        // Computed CIDR: "10.147.17.0/24"
  overlayType: string;                   // Matched overlay type
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}
```

### SubnetGroup (shared)

Replaces the current `OverlayGroup`. Scoped to one (type, subnet) pair instead of one type. The `members` field is used internally by the engine for link building; only the serializable fields (`overlayType`, `subnet`, `color`, `label`, `topology`, `hub`, `links`) are sent in the API response.

```typescript
interface SubnetGroup {
  overlayType: string;                   // "zerotier"
  subnet: string;                        // "10.147.17.0/24" (single CIDR)
  color: string;                         // From definition
  label: string;                         // "ZeroTier (10.147.17.0/24)"
  topology: 'mesh' | 'hub-spoke';
  hub?: string;                          // hostname of hub device (if hub-spoke)
  members?: OverlayMember[];             // backend-only, omitted from API response
  links: OverlayLink[];
}
```

### OverlayLink

Gains `subnet` field. `type` field renamed to `overlayType` and widened to `string`.

```typescript
interface OverlayLink {
  overlayType: string;
  subnet: string;
  from: string;
  to: string;
  fromIp: string;
  toIp: string;
  fromIface?: string;
  toIface?: string;
}
```

### OverlayPortSummary

`overlayType` widened from `OverlayType` union to `string`.

```typescript
interface OverlayPortSummary {
  ifName: string;
  overlayType: string;
  ip: string;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}
```

### TopologyResponse

`overlays` field type changes from `OverlayGroup[]` to `SubnetGroup[]`.

The `OverlayType` union type and `OverlayGroup` interface are removed entirely.

## Built-in Registry

Ordered by specificity — more specific patterns first, ambiguous patterns last. First match wins.

```typescript
const BUILTIN_DEFINITIONS: OverlayDefinition[] = [
  { type: 'zerotier',  ifPattern: /^zt/i,              color: '#9333ea', label: 'ZeroTier',  topology: 'mesh' },
  { type: 'tailscale', ifPattern: /^tailscale/i,        color: '#06b6d4', label: 'Tailscale', topology: 'mesh' },
  { type: 'wireguard', ifPattern: /^wg/i,              color: '#dc2626', label: 'WireGuard', topology: 'hub-spoke' },
  { type: 'gre',       ifPattern: /^gre/i,             color: '#6366f1', label: 'GRE',       topology: 'mesh' },
  { type: 'ipsec',     ifPattern: /^(?:ipsec|vti)/i,   color: '#ec4899', label: 'IPSec',     topology: 'hub-spoke' },
  { type: 'tinc',      ifPattern: /^tinc/i,            color: '#14b8a6', label: 'Tinc',      topology: 'mesh' },
  { type: 'pptp',      ifPattern: /^pp(?:tp|p)/i,      color: '#8b5cf6', label: 'PPTP',      topology: 'hub-spoke' },
  { type: 'tunnel',    ifPattern: /^tun/i,             color: '#f59e0b', label: 'Tunnel',    topology: 'hub-spoke' },
  { type: 'tap',       ifPattern: /^tap/i,             color: '#10b981', label: 'TAP',       topology: 'hub-spoke' },
];
```

Only types whose interfaces exist in the LibreNMS data produce `SubnetGroup` entries. A deployment with only ZeroTier and WireGuard will only see those two — the others are inert.

## OverlayEngine

### Constructor

```typescript
class OverlayEngine {
  constructor(options?: {
    extra?: OverlayDefinition[];          // additional custom definitions
    reclassify?: string;                  // OVERLAY_RECLASSIFY env value
    extraSubnets?: string;                // OVERLAY_EXTRA env value
    topologyOverride?: string;            // OVERLAY_TOPOLOGY env value
    hubOverride?: string;                 // OVERLAY_HUB env value
  });
}
```

Merges built-in definitions with `extra` definitions (custom definitions take precedence if `type` collides). Parses env-var-style override strings into internal maps.

### Pipeline Methods

```typescript
// Full pipeline: discover → group → link
process(
  devicePorts: Map<string, LnmsPort[]>,
  deviceIps: Map<string, LnmsDeviceIp[]>,
): SubnetGroup[];

// Step 1: Two-pass discovery
discover(
  devicePorts: Map<string, LnmsPort[]>,
  deviceIps: Map<string, LnmsDeviceIp[]>,
): OverlayMember[];

// Step 2: Group by (overlayType, subnet)
groupBySubnet(members: OverlayMember[]): SubnetGroup[];

// Step 3: Build mesh or hub-spoke links within each group
buildLinks(groups: SubnetGroup[]): SubnetGroup[];
```

### Utility Methods

```typescript
// Classify a single port by interface name (for getOverlayPortSummaries)
classifyPort(port: LnmsPort): string | null;

// Check if an IP belongs to any discovered/configured overlay subnet
isOverlayIp(ip: string): boolean;

// Get the active definitions (for frontend legend)
getDefinitions(): OverlayDefinition[];
```

## Two-Pass Discovery

### Pass 1 — Pattern Match

For each device's ports, test `ifName` against all registry patterns (first match wins). Resolve IP and prefix length from `LnmsDeviceIp` entries:

1. Direct `port_id` → IP mapping
2. First overlay IP on device matching the classified type
3. Any IP on the port
4. Skip member if no IP found

Compute subnet CIDR from IP + `ipv4_prefixlen` (e.g., `10.147.17.5` + prefix `24` → `10.147.17.0/24`).

Apply reclassify rules: if the member's `(type, ip)` matches a reclassify rule (e.g., `wg@100.64.0.0/10 → tailscale`), change the type. This replaces the current hardcoded Tailscale-CGNAT exclusion.

Record each `(type, subnet)` pair as a "known overlay subnet."

### Pass 2 — Subnet Sweep

For each known `(type, subnet)` from Pass 1 and from `OVERLAY_EXTRA` config:

- Scan ALL devices not already members of this subnet group
- For each of their IPs, check if it falls within the subnet
- If so, emit an `OverlayMember` that inherits the overlay type

This catches non-standard interface names (e.g., `vpn-office`, `utun3`, `nordlynx`) that wouldn't match any pattern but have IPs on a known overlay subnet.

## Link Building

For each `SubnetGroup`:

**Mesh** (`topology === 'mesh'`):
```
for each pair (i, j) where i < j:
  emit OverlayLink(members[i], members[j])
→ n*(n-1)/2 links
```

**Hub-spoke** (`topology === 'hub-spoke'`):
```
hub = hubOverride for (type, subnet)
      ?? member with lowest IP in subnet
for each member != hub:
  emit OverlayLink(hub, member)
→ (n-1) links
set group.hub = hub.hostname
```

**Point-to-point** (GRE with /30 subnet): mesh with 2 members produces exactly 1 link — no special case needed.

## Environment Configuration

```bash
# Override topology mode for a type
OVERLAY_TOPOLOGY=wireguard:mesh

# Specify hub for a (type, subnet) pair
OVERLAY_HUB=wireguard@10.10.0.0/24:10.10.0.1

# Reclassify interfaces matching a pattern+subnet to a different type
OVERLAY_RECLASSIFY=wg@100.64.0.0/10:tailscale

# Manually seed overlay subnets (no standard interface names in environment)
OVERLAY_EXTRA=wireguard:10.10.0.0/24,openvpn:10.8.0.0/24

# Legacy variables (backward compatible — parsed as OVERLAY_EXTRA entries)
ZEROTIER_SUBNETS=10.147.17.0/24
WIREGUARD_SUBNETS=10.10.0.0/24
TAILSCALE_SUBNETS=100.64.0.0/10
```

## Files Changed

| File | Change |
|------|--------|
| `shared/types.ts` | Remove `OverlayType` union and `OverlayGroup`. Add `OverlayDefinition`, `OverlayMember`, `SubnetGroup`. Update `OverlayLink` (add `subnet`, rename `type` → `overlayType`, widen to `string`). Update `OverlayPortSummary.overlayType` to `string`. Update `TopologyResponse.overlays` to `SubnetGroup[]`. Update `Port.overlayType` to `string`. |
| `backend/src/librenms/overlayEngine.ts` **(new)** | `OverlayEngine` class: registry, two-pass discovery, subnet grouping, mesh/hub-spoke link building, utility methods. Built-in `BUILTIN_DEFINITIONS` array. Subnet computation helper. |
| `backend/src/librenms/overlays.ts` | Rewrite to thin wrapper. Instantiate singleton `OverlayEngine` from config. Re-export `buildOverlayLinks`, `getOverlayPortSummaries`, `findLanIp`, `findDeviceIps` delegating to engine. Remove `OVERLAY_CONFIGS`, `classifyOverlayPort`, `classifyOverlayIp` (now engine methods). Keep `isExcludedIface` helper (updated to use engine). |
| `backend/src/config.ts` | Remove `OverlayType` import. Add parsing for `OVERLAY_TOPOLOGY`, `OVERLAY_HUB`, `OVERLAY_RECLASSIFY`, `OVERLAY_EXTRA`. Keep legacy `*_SUBNETS` env vars as compat (converted to `OVERLAY_EXTRA` format internally). |
| `backend/src/jobs/poller.ts` | Import engine. Replace `buildOverlayLinks(allPorts, allIps)` with engine call. Replace `isExcludedArpIp` overlay portion with `engine.isOverlayIp()`. Asset change tracking uses `SubnetGroup` fields. |
| `backend/src/routes/topology.ts` | Type import: `OverlayGroup` → `SubnetGroup`. No logic changes — overlays are already read from cache and passed through. |
| `frontend/src/hooks/useForceLayout.ts` | Overlay link building: iterate `SubnetGroup[]`, use `group.overlayType` and `group.color`. `LayoutLink.overlayType` already `string` — no type change. |
| `frontend/src/components/TopologyMap.tsx` | Overlay legend: show per-subnet labels (e.g., "ZeroTier (10.147.17.0/24)"). Hub-spoke groups show hub indicator. Colors from group. |
| `frontend/src/components/OverlayLink.tsx` | No change. |
| `backend/src/librenms/cidr.ts` | Add `computeSubnet(ip: string, prefixLen: number): string` helper. Existing `makeCidrMatcher` unchanged. |

## Backward Compatibility

- Legacy `ZEROTIER_SUBNETS` / `WIREGUARD_SUBNETS` / `TAILSCALE_SUBNETS` env vars continue to work, parsed as `OVERLAY_EXTRA` entries internally.
- Frontend `LayoutLink.overlayType` is already typed as `string`, so no frontend type breaks beyond the shared type renames.
- The API response shape changes (`OverlayGroup` → `SubnetGroup`, `OverlayLink.type` → `OverlayLink.overlayType`), but frontend and backend deploy together from this monorepo.

## What This Enables

Adding a new overlay type in a different deployment environment requires zero code changes:
1. If the interface follows a known naming convention (from the built-in registry) → auto-discovered from LibreNMS data
2. If the interface has a non-standard name but shares a subnet with a standard-named peer → discovered in Pass 2
3. If no standard names exist at all → one `OVERLAY_EXTRA` env var seeds the subnet
4. Topology mode, hub selection, and reclassification are all configurable via env vars
