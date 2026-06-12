# Generic Overlay Network Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 3-type overlay system with a generic, registry-driven `OverlayEngine` that supports per-subnet linking, hub-spoke topologies, two-pass auto-discovery, and env-var-driven configuration.

**Architecture:** A new `OverlayEngine` class owns the full pipeline (discover → group → link). `OverlayDefinition` objects in a built-in registry define per-type patterns and defaults. The existing `overlays.ts` becomes a thin wrapper delegating to a singleton engine. Shared types change from the `OverlayType` union to open `string` types, and `OverlayGroup` becomes `SubnetGroup` (scoped to one type+subnet pair).

**Tech Stack:** TypeScript, Node.js backend (esbuild/tsx), React frontend (Vite), pnpm monorepo. No test framework — verification via `pnpm tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-11-generic-overlay-model-design.md`

---

### Task 1: Update shared types

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: Remove `OverlayType` union and `OverlayGroup` interface, add `SubnetGroup`, update existing interfaces**

Replace the overlay-related type definitions. Remove `OverlayType` (line 106) and `OverlayGroup` (lines 118–123). Update `OverlayLink` to add `subnet` and rename `type` → `overlayType` (widened to `string`). Update `OverlayPortSummary.overlayType` to `string`. Update `Port.overlayType` to `string`. Update `TopologyResponse.overlays` to `SubnetGroup[]`. Add `SubnetGroup` interface.

```typescript
// shared/types.ts — replace lines 97–123 with:

export interface OverlayPortSummary {
  ifName: string;
  overlayType: string;
  ip: string;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}

export interface OverlayLink {
  overlayType: string;
  subnet: string;
  from: string;
  to: string;
  fromIp: string;
  toIp: string;
  fromIface?: string;
  toIface?: string;
}

export interface SubnetGroup {
  overlayType: string;
  subnet: string;
  color: string;
  label: string;
  topology: "mesh" | "hub-spoke";
  hub?: string;
  links: OverlayLink[];
}
```

Also update `Port` (line 35):
```typescript
  overlayType?: string;
```

Update `TopologyResponse` (line 158):
```typescript
  overlays: SubnetGroup[];
```

Update `Device.overlayIps` (line 21) — the `type` field is already `string`, no change needed.

- [ ] **Step 2: Verify types compile**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p shared/tsconfig.json`
Expected: Errors in backend/frontend (downstream consumers of removed types) — that's expected at this stage. The shared package itself should compile cleanly.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "refactor: replace OverlayType/OverlayGroup with generic SubnetGroup types"
```

---

### Task 2: Add `computeSubnet` helper to cidr.ts

**Files:**
- Modify: `backend/src/librenms/cidr.ts`

- [ ] **Step 1: Add `computeSubnet` and export `ipToInt`**

Append to `backend/src/librenms/cidr.ts`:

```typescript
export function computeSubnet(ip: string, prefixLen: number): string | null {
  const n = ipToInt(ip);
  if (n === null) return null;
  if (prefixLen < 0 || prefixLen > 32) return null;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  const base = (n & mask) >>> 0;
  const a = (base >>> 24) & 0xff;
  const b = (base >>> 16) & 0xff;
  const c = (base >>> 8) & 0xff;
  const d = base & 0xff;
  return `${a}.${b}.${c}.${d}/${prefixLen}`;
}
```

Also export `ipToInt` (change from `function ipToInt` to `export function ipToInt`) — the engine needs it for hub detection (lowest IP comparison).

- [ ] **Step 2: Verify**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json 2>&1 | head -5`
Expected: Errors from overlays.ts / poller.ts / topology.ts (due to removed shared types) — cidr.ts itself should be fine.

- [ ] **Step 3: Commit**

```bash
git add backend/src/librenms/cidr.ts
git commit -m "feat: add computeSubnet helper and export ipToInt from cidr.ts"
```

---

### Task 3: Create `OverlayEngine` class

**Files:**
- Create: `backend/src/librenms/overlayEngine.ts`

This is the core of the refactor. The engine owns discovery, grouping, and link building.

- [ ] **Step 1: Create `overlayEngine.ts` with types, registry, and engine class**

```typescript
// backend/src/librenms/overlayEngine.ts

import type { OverlayLink, SubnetGroup, OverlayPortSummary } from "@librenms-dash/shared";
import type { LnmsPort, LnmsDeviceIp } from "./types.js";
import { makeCidrMatcher, computeSubnet, ipToInt } from "./cidr.js";

export interface OverlayDefinition {
  type: string;
  ifPattern: RegExp;
  color: string;
  label: string;
  topology: "mesh" | "hub-spoke";
}

interface OverlayMember {
  hostname: string;
  ifName: string;
  ip: string;
  prefixLen: number;
  subnet: string;
  overlayType: string;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}

const BUILTIN_DEFINITIONS: OverlayDefinition[] = [
  { type: "zerotier",  ifPattern: /^zt/i,            color: "#9333ea", label: "ZeroTier",  topology: "mesh" },
  { type: "tailscale", ifPattern: /^tailscale/i,      color: "#06b6d4", label: "Tailscale", topology: "mesh" },
  { type: "wireguard", ifPattern: /^wg/i,            color: "#dc2626", label: "WireGuard", topology: "hub-spoke" },
  { type: "gre",       ifPattern: /^gre/i,           color: "#6366f1", label: "GRE",       topology: "mesh" },
  { type: "ipsec",     ifPattern: /^(?:ipsec|vti)/i, color: "#ec4899", label: "IPSec",     topology: "hub-spoke" },
  { type: "tinc",      ifPattern: /^tinc/i,          color: "#14b8a6", label: "Tinc",      topology: "mesh" },
  { type: "pptp",      ifPattern: /^pp(?:tp|p)/i,    color: "#8b5cf6", label: "PPTP",      topology: "hub-spoke" },
  { type: "tunnel",    ifPattern: /^tun/i,           color: "#f59e0b", label: "Tunnel",    topology: "hub-spoke" },
  { type: "tap",       ifPattern: /^tap/i,           color: "#10b981", label: "TAP",       topology: "hub-spoke" },
];

interface ReclassifyRule {
  fromType: string;
  subnet: string;
  toType: string;
  matcher: (ip: string | undefined | null) => boolean;
}

interface ExtraSubnet {
  type: string;
  subnet: string;
}

interface HubOverride {
  type: string;
  subnet: string;
  hubIp: string;
}

interface TopologyOverride {
  type: string;
  topology: "mesh" | "hub-spoke";
}

export class OverlayEngine {
  private definitions: OverlayDefinition[];
  private reclassifyRules: ReclassifyRule[];
  private extraSubnets: ExtraSubnet[];
  private hubOverrides: HubOverride[];
  private topologyOverrides: Map<string, "mesh" | "hub-spoke">;
  private knownSubnets = new Set<string>();

  constructor(options?: {
    extra?: OverlayDefinition[];
    reclassify?: string;
    extraSubnets?: string;
    topologyOverride?: string;
    hubOverride?: string;
  }) {
    // Merge definitions: custom types override built-in by type name
    const customTypes = new Set((options?.extra ?? []).map((d) => d.type));
    this.definitions = [
      ...(options?.extra ?? []),
      ...BUILTIN_DEFINITIONS.filter((d) => !customTypes.has(d.type)),
    ];

    this.reclassifyRules = parseReclassify(options?.reclassify ?? "");
    this.extraSubnets = parseExtraSubnets(options?.extraSubnets ?? "");
    this.hubOverrides = parseHubOverrides(options?.hubOverride ?? "");
    this.topologyOverrides = parseTopologyOverrides(options?.topologyOverride ?? "");
  }

  process(
    devicePorts: Map<string, LnmsPort[]>,
    deviceIps: Map<string, LnmsDeviceIp[]>,
  ): SubnetGroup[] {
    const members = this.discover(devicePorts, deviceIps);
    const groups = this.groupBySubnet(members);
    return this.buildLinks(groups);
  }

  discover(
    devicePorts: Map<string, LnmsPort[]>,
    deviceIps: Map<string, LnmsDeviceIp[]>,
  ): OverlayMember[] {
    const members: OverlayMember[] = [];
    // Track which (hostname, subnet) combos we've already matched
    const seen = new Set<string>();
    this.knownSubnets.clear();

    // --- Pass 1: Pattern match ---
    for (const [hostname, ports] of devicePorts) {
      const ips = deviceIps.get(hostname) ?? [];
      const portIdToIp = new Map<number, { ip: string; prefixLen: number }>();
      for (const ipEntry of ips) {
        if (ipEntry.ipv4_address) {
          portIdToIp.set(ipEntry.port_id, {
            ip: ipEntry.ipv4_address,
            prefixLen: ipEntry.ipv4_prefixlen,
          });
        }
      }

      for (const port of ports) {
        let overlayType = this.classifyPort(port);
        if (!overlayType) continue;

        // Resolve IP: 1) direct port_id match, 2) first overlay IP on device, 3) any IP on port
        let ip = "";
        let prefixLen = 24;

        const directMatch = portIdToIp.get(port.port_id);
        if (directMatch) {
          ip = directMatch.ip;
          prefixLen = directMatch.prefixLen;
        }

        if (!ip) {
          for (const ipEntry of ips) {
            if (!ipEntry.ipv4_address) continue;
            const classified = this.classifyIpBySubnet(ipEntry.ipv4_address, overlayType);
            if (classified) {
              ip = ipEntry.ipv4_address;
              prefixLen = ipEntry.ipv4_prefixlen;
              break;
            }
          }
        }

        if (!ip) {
          const match = ips.find((e) => e.port_id === port.port_id && e.ipv4_address);
          if (match) {
            ip = match.ipv4_address;
            prefixLen = match.ipv4_prefixlen;
          }
        }

        if (!ip) continue;

        // Apply reclassify rules
        for (const rule of this.reclassifyRules) {
          if (rule.fromType === overlayType && rule.matcher(ip)) {
            overlayType = rule.toType;
            break;
          }
        }

        const subnet = computeSubnet(ip, prefixLen);
        if (!subnet) continue;

        const key = `${hostname}:${overlayType}:${subnet}`;
        if (seen.has(key)) continue;
        seen.add(key);

        this.knownSubnets.add(`${overlayType}:${subnet}`);

        members.push({
          hostname,
          ifName: port.ifName,
          ip,
          prefixLen,
          subnet,
          overlayType,
          ifInOctets_rate: port.ifInOctets_rate ?? 0,
          ifOutOctets_rate: port.ifOutOctets_rate ?? 0,
          ifOperStatus: port.ifOperStatus ?? "up",
        });
      }
    }

    // Register extra subnets as known
    for (const extra of this.extraSubnets) {
      this.knownSubnets.add(`${extra.type}:${extra.subnet}`);
    }

    // --- Pass 2: Subnet sweep ---
    for (const entry of this.knownSubnets) {
      const colonIdx = entry.indexOf(":");
      const type = entry.slice(0, colonIdx);
      const subnet = entry.slice(colonIdx + 1);
      const matcher = makeCidrMatcher([subnet]);

      for (const [hostname, ips] of deviceIps) {
        for (const ipEntry of ips) {
          if (!ipEntry.ipv4_address) continue;
          const key = `${hostname}:${type}:${subnet}`;
          if (seen.has(key)) continue;

          if (matcher(ipEntry.ipv4_address)) {
            seen.add(key);

            // Find interface name for this IP if possible
            const ports = devicePorts.get(hostname) ?? [];
            const matchingPort = ports.find((p) => p.port_id === ipEntry.port_id);

            members.push({
              hostname,
              ifName: matchingPort?.ifName ?? "",
              ip: ipEntry.ipv4_address,
              prefixLen: ipEntry.ipv4_prefixlen,
              subnet,
              overlayType: type,
              ifInOctets_rate: matchingPort?.ifInOctets_rate ?? 0,
              ifOutOctets_rate: matchingPort?.ifOutOctets_rate ?? 0,
              ifOperStatus: matchingPort?.ifOperStatus ?? "up",
            });
          }
        }
      }
    }

    return members;
  }

  groupBySubnet(members: OverlayMember[]): SubnetGroup[] {
    const map = new Map<string, SubnetGroup & { members: OverlayMember[] }>();

    for (const m of members) {
      const key = `${m.overlayType}:${m.subnet}`;
      let group = map.get(key);
      if (!group) {
        const def = this.definitions.find((d) => d.type === m.overlayType);
        const topology = this.topologyOverrides.get(m.overlayType) ?? def?.topology ?? "mesh";
        group = {
          overlayType: m.overlayType,
          subnet: m.subnet,
          color: def?.color ?? "#666",
          label: `${def?.label ?? m.overlayType} (${m.subnet})`,
          topology,
          links: [],
          members: [],
        };
        map.set(key, group);
      }
      group.members.push(m);
    }

    return [...map.values()];
  }

  buildLinks(groups: (SubnetGroup & { members?: OverlayMember[] })[]): SubnetGroup[] {
    for (const group of groups) {
      const members = group.members ?? [];
      if (members.length < 2) continue;

      if (group.topology === "hub-spoke") {
        // Find hub: override or lowest IP
        const hubOverride = this.hubOverrides.find(
          (h) => h.type === group.overlayType && h.subnet === group.subnet,
        );
        let hub: OverlayMember;
        if (hubOverride) {
          hub = members.find((m) => m.ip === hubOverride.hubIp) ?? members[0];
        } else {
          hub = members.reduce((a, b) => ((ipToInt(a.ip) ?? 0) < (ipToInt(b.ip) ?? 0) ? a : b));
        }
        group.hub = hub.hostname;

        for (const m of members) {
          if (m === hub) continue;
          group.links.push({
            overlayType: group.overlayType,
            subnet: group.subnet,
            from: hub.hostname,
            to: m.hostname,
            fromIp: hub.ip,
            toIp: m.ip,
            fromIface: hub.ifName || undefined,
            toIface: m.ifName || undefined,
          });
        }
      } else {
        // Mesh: all pairs
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            group.links.push({
              overlayType: group.overlayType,
              subnet: group.subnet,
              from: members[i].hostname,
              to: members[j].hostname,
              fromIp: members[i].ip,
              toIp: members[j].ip,
              fromIface: members[i].ifName || undefined,
              toIface: members[j].ifName || undefined,
            });
          }
        }
      }
    }

    // Strip internal members field from API response
    return groups.map(({ members: _members, ...rest }) => rest as SubnetGroup);
  }

  classifyPort(port: LnmsPort): string | null {
    if (!port.ifName) return null;
    for (const def of this.definitions) {
      if (def.ifPattern.test(port.ifName)) return def.type;
    }
    return null;
  }

  isOverlayIp(ip: string): boolean {
    if (!ip) return false;
    for (const entry of this.knownSubnets) {
      const subnet = entry.slice(entry.indexOf(":") + 1);
      if (makeCidrMatcher([subnet])(ip)) return true;
    }
    return false;
  }

  getDefinitions(): OverlayDefinition[] {
    return [...this.definitions];
  }

  private classifyIpBySubnet(ip: string, expectedType: string): boolean {
    for (const extra of this.extraSubnets) {
      if (extra.type === expectedType && makeCidrMatcher([extra.subnet])(ip)) return true;
    }
    return false;
  }
}

// --- Env var parsers ---

function parseReclassify(raw: string): ReclassifyRule[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    // Format: fromType@cidr:toType (e.g. wg@100.64.0.0/10:tailscale)
    const match = entry.trim().match(/^(\w+)@([^:]+):(\w+)$/);
    if (!match) return null;
    return {
      fromType: match[1],
      subnet: match[2],
      toType: match[3],
      matcher: makeCidrMatcher([match[2]]),
    };
  }).filter((r): r is ReclassifyRule => r !== null);
}

function parseExtraSubnets(raw: string): ExtraSubnet[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    // Format: type:cidr (e.g. wireguard:10.10.0.0/24)
    const match = entry.trim().match(/^(\w+):(.+)$/);
    if (!match) return null;
    return { type: match[1], subnet: match[2].trim() };
  }).filter((e): e is ExtraSubnet => e !== null);
}

function parseHubOverrides(raw: string): HubOverride[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    // Format: type@subnet:hubIp (e.g. wireguard@10.10.0.0/24:10.10.0.1)
    const match = entry.trim().match(/^(\w+)@([^:]+):(.+)$/);
    if (!match) return null;
    return { type: match[1], subnet: match[2], hubIp: match[3].trim() };
  }).filter((h): h is HubOverride => h !== null);
}

function parseTopologyOverrides(raw: string): Map<string, "mesh" | "hub-spoke"> {
  const map = new Map<string, "mesh" | "hub-spoke">();
  if (!raw) return map;
  for (const entry of raw.split(",")) {
    // Format: type:topology (e.g. wireguard:mesh)
    const match = entry.trim().match(/^(\w+):(mesh|hub-spoke)$/);
    if (match) map.set(match[1], match[2] as "mesh" | "hub-spoke");
  }
  return map;
}
```

- [ ] **Step 2: Verify the file compiles in isolation**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json 2>&1 | grep overlayEngine || echo "overlayEngine clean"`
Expected: `overlayEngine clean` (the new file should have no type errors of its own)

- [ ] **Step 3: Commit**

```bash
git add backend/src/librenms/overlayEngine.ts
git commit -m "feat: add OverlayEngine with registry, two-pass discovery, and hub-spoke support"
```

---

### Task 4: Update config.ts

**Files:**
- Modify: `backend/src/config.ts`

- [ ] **Step 1: Replace overlay config with generic env var exports**

Remove the `OverlayType` import (line 3) and `OVERLAY_SUBNETS` block (lines 25–29). Add new exports that the engine consumes.

Replace lines 3 and 14–29 in `backend/src/config.ts`:

```typescript
// Remove line 3: import type { OverlayType } from "@librenms-dash/shared";

// Replace lines 14–29 with:

function parseSubnetList(env: string | undefined, fallback: string[] = []): string[] {
  if (!env) return fallback;
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

// Build OVERLAY_EXTRA from new env var + legacy compat vars.
// Legacy ZEROTIER_SUBNETS / WIREGUARD_SUBNETS / TAILSCALE_SUBNETS are converted to
// the generic format (type:cidr) so existing .env files continue to work.
function buildOverlayExtra(): string {
  const parts: string[] = [];
  if (process.env.OVERLAY_EXTRA) parts.push(process.env.OVERLAY_EXTRA);

  const legacy: Array<[string, string, string[]]> = [
    ["zerotier", "ZEROTIER_SUBNETS", []],
    ["wireguard", "WIREGUARD_SUBNETS", []],
    ["tailscale", "TAILSCALE_SUBNETS", ["100.64.0.0/10"]],
  ];
  for (const [type, envKey, fallback] of legacy) {
    const subnets = parseSubnetList(process.env[envKey], fallback);
    for (const s of subnets) parts.push(`${type}:${s}`);
  }
  return parts.join(",");
}

export const OVERLAY_EXTRA = buildOverlayExtra();
export const OVERLAY_RECLASSIFY = process.env.OVERLAY_RECLASSIFY ?? "";
export const OVERLAY_TOPOLOGY = process.env.OVERLAY_TOPOLOGY ?? "";
export const OVERLAY_HUB = process.env.OVERLAY_HUB ?? "";

// Collect all configured overlay CIDRs so ARP exclusion still works.
// This is a flat list derived from OVERLAY_EXTRA for backward compatibility
// with code that needs a simple CIDR list (e.g. ARP exclusion before engine init).
export const OVERLAY_SUBNET_LIST: string[] = buildOverlayExtra()
  .split(",")
  .map((e) => { const m = e.trim().match(/^\w+:(.+)$/); return m?.[1] ?? ""; })
  .filter(Boolean);
```

- [ ] **Step 2: Verify**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json 2>&1 | grep -c "config.ts"` 
Expected: 0 errors from config.ts

- [ ] **Step 3: Commit**

```bash
git add backend/src/config.ts
git commit -m "refactor: replace OVERLAY_SUBNETS with generic overlay env var config"
```

---

### Task 5: Rewrite overlays.ts as thin wrapper

**Files:**
- Modify: `backend/src/librenms/overlays.ts`

- [ ] **Step 1: Rewrite overlays.ts to delegate to OverlayEngine singleton**

Replace the entire file:

```typescript
import type { SubnetGroup, OverlayPortSummary } from "@librenms-dash/shared";
import type { LnmsPort, LnmsDeviceIp } from "./types.js";
import { OVERLAY_EXTRA, OVERLAY_RECLASSIFY, OVERLAY_TOPOLOGY, OVERLAY_HUB, DOCKER_SUBNETS } from "../config.js";
import { makeCidrMatcher } from "./cidr.js";
import { OverlayEngine } from "./overlayEngine.js";

export const engine = new OverlayEngine({
  extraSubnets: OVERLAY_EXTRA,
  reclassify: OVERLAY_RECLASSIFY,
  topologyOverride: OVERLAY_TOPOLOGY,
  hubOverride: OVERLAY_HUB,
});

export function buildOverlayLinks(
  devicePorts: Map<string, LnmsPort[]>,
  deviceIps: Map<string, LnmsDeviceIp[]>,
): SubnetGroup[] {
  return engine.process(devicePorts, deviceIps);
}

export function getOverlayPortSummaries(
  ports: LnmsPort[],
  ips: LnmsDeviceIp[],
): OverlayPortSummary[] {
  const portIdToIp = new Map<number, string>();
  for (const ipEntry of ips) {
    if (ipEntry.ipv4_address) portIdToIp.set(ipEntry.port_id, ipEntry.ipv4_address);
  }

  const best = new Map<string, OverlayPortSummary>();

  for (const port of ports) {
    const overlayType = engine.classifyPort(port);
    if (!overlayType) continue;

    let ip = portIdToIp.get(port.port_id) ?? "";
    if (!ip) {
      const match = ips.find((e) => e.port_id === port.port_id && e.ipv4_address);
      if (match) ip = match.ipv4_address;
    }

    const existing = best.get(overlayType);
    const traffic = (port.ifInOctets_rate ?? 0) + (port.ifOutOctets_rate ?? 0);
    const existingTraffic = existing ? (existing.ifInOctets_rate + existing.ifOutOctets_rate) : -1;

    if (!existing || (!existing.ip && ip) || (ip && traffic > existingTraffic)) {
      best.set(overlayType, {
        ifName: port.ifName,
        overlayType,
        ip,
        ifInOctets_rate: port.ifInOctets_rate ?? 0,
        ifOutOctets_rate: port.ifOutOctets_rate ?? 0,
        ifOperStatus: port.ifOperStatus ?? "up",
      });
    }
  }

  return [...best.values()];
}

export function findLanIp(deviceIp: string, ips: LnmsDeviceIp[]): string {
  const lanIps: string[] = [];
  for (const entry of ips) {
    const addr = entry.ipv4_address;
    if (!addr || addr === "127.0.0.1") continue;
    if (!engine.isOverlayIp(addr)) {
      lanIps.push(addr);
    }
  }
  if (!engine.isOverlayIp(deviceIp) && deviceIp) return deviceIp;
  if (lanIps.length > 0) return lanIps[0];
  return deviceIp;
}

const DOCKER_IFACE_RE = /^(br-[0-9a-f]{6,}|docker|veth)/i;
const isDockerIp = makeCidrMatcher(DOCKER_SUBNETS);

function isExcludedIface(ifName: string): boolean {
  if (ifName === "lo") return true;
  if (DOCKER_IFACE_RE.test(ifName)) return true;
  return engine.classifyPort({ ifName } as LnmsPort) !== null;
}

function isLinkLocalV4(ip: string): boolean {
  return ip.startsWith("127.") || ip.startsWith("169.254.");
}

function isExcludedV6(addr: string, origin: string): boolean {
  const lower = addr.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("::1")) return true;
  if (lower.startsWith("fd") || lower.startsWith("fc")) return true;
  if (origin === "linklayer" && !isGlobalUnicastV6(lower)) return true;
  return false;
}

function isGlobalUnicastV6(addr: string): boolean {
  return /^2[0-9a-f]{3}:/.test(addr);
}

export function findDeviceIps(
  ips: LnmsDeviceIp[],
  ports: LnmsPort[],
): string[] {
  const portIdToIfName = new Map<number, string>();
  for (const p of ports) {
    const name = p.ifName || p.ifDescr;
    if (name) portIdToIfName.set(p.port_id, name);
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of ips) {
    const ifName = portIdToIfName.get(entry.port_id) ?? "";
    if (ifName && isExcludedIface(ifName)) continue;

    if (entry.ipv4_address) {
      const addr = entry.ipv4_address;
      if (isLinkLocalV4(addr)) continue;
      if (engine.isOverlayIp(addr)) continue;
      if (isDockerIp(addr)) continue;
      if (!seen.has(addr)) { seen.add(addr); result.push(addr); }
    }

    const v6 = entry.ipv6_compressed || entry.ipv6_address;
    if (v6) {
      const origin = entry.ipv6_origin ?? "";
      if (isExcludedV6(v6, origin)) continue;
      if (!seen.has(v6)) { seen.add(v6); result.push(v6); }
    }
  }

  return result;
}
```

- [ ] **Step 2: Verify**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json 2>&1 | grep "overlays.ts" || echo "overlays.ts clean"`
Expected: clean or only downstream errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/librenms/overlays.ts
git commit -m "refactor: rewrite overlays.ts as thin wrapper delegating to OverlayEngine"
```

---

### Task 6: Update poller.ts

**Files:**
- Modify: `backend/src/jobs/poller.ts`

- [ ] **Step 1: Replace overlay imports and `isExcludedArpIp` with engine**

In `backend/src/jobs/poller.ts`, make these changes:

1. Update imports (lines 3, 5–6):
   - Remove `OVERLAY_SUBNETS` from config import
   - Add `OVERLAY_SUBNET_LIST` to config import
   - Add `engine` import from overlays

```typescript
// Line 3 stays the same:
import { buildOverlayLinks } from "../librenms/overlays.js";
// Add after line 3:
import { engine } from "../librenms/overlays.js";
// Line 5 stays:
import { makeCidrMatcher } from "../librenms/cidr.js";
// Line 6 — replace OVERLAY_SUBNETS with OVERLAY_SUBNET_LIST:
import { ARP_EXCLUDED_SUBNETS, OVERLAY_SUBNET_LIST } from "../config.js";
```

(Combine the overlays imports into one line: `import { buildOverlayLinks, engine } from "../librenms/overlays.js";`)

2. Update `isExcludedArpIp` (lines 20–23):

```typescript
const isExcludedArpIp = makeCidrMatcher([
  ...ARP_EXCLUDED_SUBNETS,
  ...OVERLAY_SUBNET_LIST,
]);
```

3. Update the overlay log line (line 154) — change `o.type` to `o.overlayType`:

```typescript
  console.log(`[poller] Cached overlays: ${overlays.map((o) => `${o.overlayType}(${o.links.length} links)`).join(", ")}`);
```

4. Update the asset tracking key (line 169) — change `g.type` to `g.overlayType`:

```typescript
    for (const l of g.links) currOverlays.add(`${g.overlayType} ${l.from}<>${l.to}`);
```

- [ ] **Step 2: Verify**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json 2>&1 | grep "poller.ts" || echo "poller.ts clean"`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add backend/src/jobs/poller.ts
git commit -m "refactor: update poller to use OverlayEngine and SubnetGroup fields"
```

---

### Task 7: Update topology.ts

**Files:**
- Modify: `backend/src/routes/topology.ts`

- [ ] **Step 1: Replace `OverlayGroup` import with `SubnetGroup`**

In `backend/src/routes/topology.ts`:

Line 4 — replace `OverlayGroup` with `SubnetGroup` in the import:

```typescript
import type { TopologyResponse, Site, DeviceSummary, SubnetGroup, NeighborLink, ArpLink, ArpDiscoveredDevice, DeviceRoute } from "@librenms-dash/shared";
```

Line 25 — update the cache type:

```typescript
  const overlays = cache.get<SubnetGroup[]>("overlays") ?? [];
```

- [ ] **Step 2: Verify full backend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/topology.ts
git commit -m "refactor: update topology route to use SubnetGroup type"
```

---

### Task 8: Update useForceLayout.ts

**Files:**
- Modify: `frontend/src/hooks/useForceLayout.ts`

- [ ] **Step 1: Update overlay link iteration**

In `frontend/src/hooks/useForceLayout.ts`, update the overlay link building block (lines 348–365):

Change `overlay.type` → `overlay.overlayType` and `overlay.color` stays the same (field name unchanged).

```typescript
  // Build overlay links
  const links: LayoutLink[] = [];
  for (const overlay of data.overlays) {
    for (const link of overlay.links) {
      const src = nodeMap.get(link.from);
      const tgt = nodeMap.get(link.to);
      if (src && tgt) {
        links.push({
          source: src,
          target: tgt,
          overlayType: overlay.overlayType,
          color: overlay.color,
          fromIp: link.fromIp,
          toIp: link.toIp,
          fromIface: link.fromIface,
          toIface: link.toIface,
        });
      }
    }
  }
```

The only actual change is `overlay.type` → `overlay.overlayType` on the one line.

- [ ] **Step 2: Verify**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p frontend/tsconfig.json 2>&1 | head -10`
Expected: 0 errors or only unrelated ones

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useForceLayout.ts
git commit -m "refactor: update useForceLayout overlay iteration for SubnetGroup"
```

---

### Task 9: Update TopologyMap.tsx

**Files:**
- Modify: `frontend/src/components/TopologyMap.tsx`

- [ ] **Step 1: Remove `OVERLAY_COLORS` constant and update legend**

In `frontend/src/components/TopologyMap.tsx`:

1. Remove `OVERLAY_COLORS` constant (lines 28–32) — colors now come from `SubnetGroup.color`.

2. Update `hiddenOverlays` default (lines 85–88) — change to empty object since overlay types are now dynamic:

```typescript
  const [hiddenOverlays, setHiddenOverlays] = useLocalStorage<Record<string, boolean>>(
    "librenms-dash:hiddenOverlays:v2",
    {},
  );
```

(Bump localStorage key to `v2` so users with stale `v1` data get fresh defaults.)

3. Update the overlay legend rendering (lines 712–731). Change `o.type` → `o.overlayType`, remove `OVERLAY_COLORS` lookup, use `o.color` directly, show `o.label`:

```typescript
        <span className="text-xs text-gray-400 font-semibold mr-2">Overlays:</span>
        {data.overlays.map((o) => {
          const key = `${o.overlayType}:${o.subnet}`;
          const visible = !hiddenOverlays[key];
          return (
            <button
              key={key}
              onClick={() => toggleOverlay(key)}
              className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
                visible ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
              }`}
            >
              <span
                className="w-3 h-0.5 inline-block rounded"
                style={{ backgroundColor: o.color, opacity: visible ? 1 : 0.3 }}
              />
              {o.label} ({o.links.length}){o.hub ? " ⭐" : ""}
            </button>
          );
        })}
```

4. Update `visibleLinks` filter (line 225) — the overlay key is now `overlayType:subnet`, but `LayoutLink` still only has `overlayType`. We need to match links to their group's hidden state. The simplest approach: build a set of hidden overlay types from the groups, then filter links.

Actually, since each `LayoutLink` has `overlayType` (which is the type string, not the composite key), and we now key hiddenOverlays by `type:subnet`, we need to update the link filtering. The cleanest approach: pass the composite key through the link. But that would require changing `LayoutLink`. Instead, build a set of visible overlay type+subnet combos and check against it.

The simplest fix: since `LayoutLink` already carries `fromIp` and `toIp`, and the `overlayType` field matches `SubnetGroup.overlayType`, we can key `hiddenOverlays` by just `overlayType` (the type string) instead of the composite key. This is simpler and matches how the original code worked (hiding all links of a given type).

**Revised approach:** Key `hiddenOverlays` by `overlayType` (string), not composite key. This means clicking a legend item hides all subnets of that type. The legend buttons still show per-subnet detail but toggle by type:

```typescript
        {data.overlays.map((o) => {
          const visible = !hiddenOverlays[o.overlayType];
          return (
            <button
              key={`${o.overlayType}:${o.subnet}`}
              onClick={() => toggleOverlay(o.overlayType)}
              className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
                visible ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
              }`}
            >
              <span
                className="w-3 h-0.5 inline-block rounded"
                style={{ backgroundColor: o.color, opacity: visible ? 1 : 0.3 }}
              />
              {o.label} ({o.links.length}){o.hub ? " ⭐" : ""}
            </button>
          );
        })}
```

The `visibleLinks` filter (line 225) stays as-is since it already uses `l.overlayType`.

- [ ] **Step 2: Verify frontend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/TopologyMap.tsx
git commit -m "refactor: update TopologyMap legend for dynamic SubnetGroup overlays"
```

---

### Task 10: Full build verification

- [ ] **Step 1: Type-check everything**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p shared/tsconfig.json && npx tsc --noEmit -p backend/tsconfig.json && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: 0 errors across all three packages

- [ ] **Step 2: Build check**

Run: `cd /home/jkumar/Librenms-dash && pnpm build` (if build script exists) or `cd backend && pnpm build && cd ../frontend && pnpm build`
Expected: Successful build

- [ ] **Step 3: Start dev server and verify overlay rendering**

Run: `cd /home/jkumar/Librenms-dash && pnpm dev` (or equivalent)
Verify: Open in browser, check that overlay links render correctly on the topology map, legend shows per-subnet labels, toggling works.

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address build issues from overlay engine refactor"
```
