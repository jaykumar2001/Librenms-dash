import type { OverlayType, OverlayGroup, OverlayLink, OverlayPortSummary } from "@librenms-dash/shared";
import type { LnmsPort, LnmsDeviceIp } from "./types.js";
import { OVERLAY_SUBNETS, DOCKER_SUBNETS } from "../config.js";
import { makeCidrMatcher } from "./cidr.js";

interface OverlayConfig {
  type: OverlayType;
  color: string;
  ifacePattern: RegExp;
  subnets: string[];
  matchesIp: (ip: string | undefined | null) => boolean;
}

// Interface-name patterns are protocol conventions (not deployment-specific); the
// address ranges come from configuration (see OVERLAY_SUBNETS).
const OVERLAY_CONFIGS: OverlayConfig[] = [
  { type: "zerotier" as const, color: "#9333ea", ifacePattern: /^zt/ },
  { type: "wireguard" as const, color: "#dc2626", ifacePattern: /^wg/ },
  { type: "tailscale" as const, color: "#06b6d4", ifacePattern: /^tailscale/ },
].map((cfg) => ({
  ...cfg,
  subnets: OVERLAY_SUBNETS[cfg.type],
  matchesIp: makeCidrMatcher(OVERLAY_SUBNETS[cfg.type]),
}));

export function classifyOverlayPort(port: LnmsPort): OverlayType | null {
  if (!port.ifName) return null;
  for (const cfg of OVERLAY_CONFIGS) {
    if (cfg.ifacePattern.test(port.ifName)) return cfg.type;
  }
  return null;
}

export function classifyOverlayIp(ip: string | undefined | null): OverlayType | null {
  if (!ip) return null;
  for (const cfg of OVERLAY_CONFIGS) {
    if (cfg.matchesIp(ip)) return cfg.type;
  }
  return null;
}

interface DeviceOverlayInfo {
  hostname: string;
  overlayType: OverlayType;
  ip: string;
  ifName: string;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}

export function buildOverlayLinks(
  devicePorts: Map<string, LnmsPort[]>,
  deviceIps: Map<string, LnmsDeviceIp[]>
): OverlayGroup[] {
  const overlayDevices = new Map<OverlayType, DeviceOverlayInfo[]>();

  for (const [hostname, ports] of devicePorts) {
    const ips = deviceIps.get(hostname) ?? [];
    const portIdToIp = new Map<number, string>();
    for (const ipEntry of ips) {
      if (ipEntry.ipv4_address) portIdToIp.set(ipEntry.port_id, ipEntry.ipv4_address);
    }

    for (const port of ports) {
      const overlayType = classifyOverlayPort(port);
      if (!overlayType) continue;

      let ip = portIdToIp.get(port.port_id) ?? "";
      if (!ip) {
        for (const ipEntry of ips) {
          if (classifyOverlayIp(ipEntry.ipv4_address) === overlayType) {
            ip = ipEntry.ipv4_address;
            break;
          }
        }
      }
      if (!ip) {
        const match = ips.find((e) => e.port_id === port.port_id && e.ipv4_address);
        if (match) ip = match.ipv4_address;
      }

      // Skip wg-named interfaces that actually carry a Tailscale CGNAT address
      // (100.64.0.0/10) — e.g. Tailscale's WireGuard-backed tunnel — so they don't
      // pollute the WireGuard mesh.
      if (overlayType === "wireguard" && classifyOverlayIp(ip) === "tailscale") continue;

      if (!overlayDevices.has(overlayType)) overlayDevices.set(overlayType, []);
      overlayDevices.get(overlayType)!.push({
        hostname,
        overlayType,
        ip,
        ifName: port.ifName,
        ifInOctets_rate: port.ifInOctets_rate ?? 0,
        ifOutOctets_rate: port.ifOutOctets_rate ?? 0,
        ifOperStatus: port.ifOperStatus ?? "up",
      });
    }
  }

  const groups: OverlayGroup[] = [];

  for (const cfg of OVERLAY_CONFIGS) {
    const members = overlayDevices.get(cfg.type) ?? [];
    const links: OverlayLink[] = [];

    // full mesh between all members of the same overlay
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        links.push({
          type: cfg.type,
          from: members[i].hostname,
          to: members[j].hostname,
          fromIp: members[i].ip,
          toIp: members[j].ip,
          fromIface: members[i].ifName,
          toIface: members[j].ifName,
        });
      }
    }

    groups.push({ type: cfg.type, subnet: cfg.subnets.join(", "), color: cfg.color, links });
  }

  return groups;
}

export function getOverlayPortSummaries(
  ports: LnmsPort[],
  ips: LnmsDeviceIp[]
): OverlayPortSummary[] {
  const portIdToIp = new Map<number, string>();
  for (const ipEntry of ips) {
    if (ipEntry.ipv4_address) portIdToIp.set(ipEntry.port_id, ipEntry.ipv4_address);
  }

  // Dedup: one entry per overlay type, pick the one with an IP and highest traffic
  const best = new Map<OverlayType, OverlayPortSummary>();

  for (const port of ports) {
    const overlayType = classifyOverlayPort(port);
    if (!overlayType) continue;

    let ip = portIdToIp.get(port.port_id) ?? "";
    if (!ip) {
      for (const ipEntry of ips) {
        if (classifyOverlayIp(ipEntry.ipv4_address) === overlayType) {
          ip = ipEntry.ipv4_address;
          break;
        }
      }
    }
    if (!ip) {
      const match = ips.find((e) => e.port_id === port.port_id && e.ipv4_address);
      if (match) ip = match.ipv4_address;
    }

    const existing = best.get(overlayType);
    const traffic = (port.ifInOctets_rate ?? 0) + (port.ifOutOctets_rate ?? 0);
    const existingTraffic = existing ? (existing.ifInOctets_rate + existing.ifOutOctets_rate) : -1;

    // Prefer entry with IP, then higher traffic
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

// Find the best LAN IP for a device (non-overlay IP from port data)
export function findLanIp(deviceIp: string, ips: LnmsDeviceIp[]): string {
  // Collect all non-overlay IPs
  const lanIps: string[] = [];
  for (const entry of ips) {
    const addr = entry.ipv4_address;
    if (!addr || addr === "127.0.0.1") continue;
    if (!classifyOverlayIp(addr)) {
      lanIps.push(addr);
    }
  }
  // If the device's primary IP is not an overlay IP, use it
  if (!classifyOverlayIp(deviceIp) && deviceIp) return deviceIp;
  // Otherwise pick first LAN IP from ports
  if (lanIps.length > 0) return lanIps[0];
  // Fallback to device IP
  return deviceIp;
}

const OVERLAY_IFACE_RE = /^(zt|wg|tailscale|docker)/i;
const DOCKER_IFACE_RE = /^(br-[0-9a-f]{6,}|docker|veth)/i;
const isDockerIp = makeCidrMatcher(DOCKER_SUBNETS);

function isExcludedIface(ifName: string): boolean {
  return OVERLAY_IFACE_RE.test(ifName) || DOCKER_IFACE_RE.test(ifName) || ifName === "lo";
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
      if (classifyOverlayIp(addr)) continue;
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
