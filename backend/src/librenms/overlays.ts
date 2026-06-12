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
