import type { OverlayType, OverlayGroup, OverlayLink, OverlayPortSummary } from "@librenms-dash/shared";
import type { LnmsPort, LnmsDeviceIp } from "./types.js";

interface OverlayConfig {
  type: OverlayType;
  subnet: string;
  color: string;
  ifacePattern: RegExp;
  networkPrefix: string;
  prefixLen: number;
}

const OVERLAY_CONFIGS: OverlayConfig[] = [
  { type: "zerotier", subnet: "172.29.0.0/24", color: "#9333ea", ifacePattern: /^zt/, networkPrefix: "172.29.0.", prefixLen: 24 },
  { type: "wireguard", subnet: "10.127.0.0/24", color: "#dc2626", ifacePattern: /^wg/, networkPrefix: "10.127.0.", prefixLen: 24 },
  { type: "tailscale", subnet: "100.64.0.0/10", color: "#06b6d4", ifacePattern: /^tailscale/, networkPrefix: "100.", prefixLen: 10 },
];

function ipInSubnet(ip: string | undefined | null, prefix: string, prefixLen: number): boolean {
  if (!ip) return false;
  if (prefixLen === 10 && prefix === "100.") {
    const first = parseInt(ip.split(".")[0]);
    const second = parseInt(ip.split(".")[1]);
    return first === 100 && second >= 64 && second <= 127;
  }
  return ip.startsWith(prefix);
}

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
    if (ipInSubnet(ip, cfg.networkPrefix, cfg.prefixLen)) return cfg.type;
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
      portIdToIp.set(ipEntry.port_id, ipEntry.ipv4_address);
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

    groups.push({ type: cfg.type, subnet: cfg.subnet, color: cfg.color, links });
  }

  return groups;
}

export function getOverlayPortSummaries(
  ports: LnmsPort[],
  ips: LnmsDeviceIp[]
): OverlayPortSummary[] {
  const portIdToIp = new Map<number, string>();
  for (const ipEntry of ips) {
    portIdToIp.set(ipEntry.port_id, ipEntry.ipv4_address);
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
