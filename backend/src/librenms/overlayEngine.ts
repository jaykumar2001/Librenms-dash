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
    const linked = this.buildLinks(groups);
    return linked.filter((g) => g.links.length > 0);
  }

  discover(
    devicePorts: Map<string, LnmsPort[]>,
    deviceIps: Map<string, LnmsDeviceIp[]>,
  ): OverlayMember[] {
    const members: OverlayMember[] = [];
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
            if (this.classifyIpBySubnet(ipEntry.ipv4_address, overlayType)) {
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
    const match = entry.trim().match(/^(\w+):(.+)$/);
    if (!match) return null;
    return { type: match[1], subnet: match[2].trim() };
  }).filter((e): e is ExtraSubnet => e !== null);
}

function parseHubOverrides(raw: string): HubOverride[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const match = entry.trim().match(/^(\w+)@([^:]+):(.+)$/);
    if (!match) return null;
    return { type: match[1], subnet: match[2], hubIp: match[3].trim() };
  }).filter((h): h is HubOverride => h !== null);
}

function parseTopologyOverrides(raw: string): Map<string, "mesh" | "hub-spoke"> {
  const map = new Map<string, "mesh" | "hub-spoke">();
  if (!raw) return map;
  for (const entry of raw.split(",")) {
    const match = entry.trim().match(/^(\w+):(mesh|hub-spoke)$/);
    if (match) map.set(match[1], match[2] as "mesh" | "hub-spoke");
  }
  return map;
}
