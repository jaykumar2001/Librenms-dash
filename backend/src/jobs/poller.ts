import { cache, TTL } from "../cache/store.js";
import { librenmsGet, delay } from "../librenms/client.js";
import { buildOverlayLinks, engine, isExcludedIface, isDockerIp, findLanIp, getOverlayPortSummaries, findDeviceIps } from "../librenms/overlays.js";
import { loadOuiDatabases, lookupVendor, normalizeMac } from "../librenms/oui.js";
import { makeCidrMatcher } from "../librenms/cidr.js";
import { ARP_EXCLUDED_SUBNETS, OVERLAY_SUBNET_LIST } from "../config.js";
import { initWebSession, isWebClientEnabled, fetchRoutes, fetchNdNeighbours, extractIfaceName, extractNextHop, stripHtml } from "../librenms/web-client.js";
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsLocation, LnmsAlert, LnmsLink, LnmsArpEntry, LnmsNdEntry } from "../librenms/types.js";
import type { ArpLink, ArpDiscoveredDevice, DeviceRoute, AssetEvent, TopologyResponse, Site, DeviceSummary, NeighborLink } from "@librenms-dash/shared";

const STAGGER_MS = 200;

// How often to refresh the device list (status, uptime, last_polled). Kept well
// below TTL.DEVICES so the cached list never expires between polls. LibreNMS itself
// typically polls every 5 min, so a shorter interval here wouldn't add freshness.
const DEVICE_POLL_MS = 5 * 60 * 1000;

// IPs never treated as discoverable ARP neighbours: configured overlay ranges
// plus excluded infrastructure ranges (loopback, link-local, Docker, …).
const isExcludedArpIp = makeCidrMatcher([
  ...ARP_EXCLUDED_SUBNETS,
  ...OVERLAY_SUBNET_LIST,
]);

// --- Asset change detection ---
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function localTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: localTz });
}

const prevAssets = {
  devices: new Set<string>(),
  ports: new Set<string>(),
  ips: new Set<string>(),
  overlayLinks: new Set<string>(),
  arpDevices: new Set<string>(),
  routes: new Set<string>(),
};
const assetBaseline = new Set<string>();
const prevDeviceStatus = new Map<string, number>();
let eventSeq = 0;
const MAX_EVENTS = 200;

const commitSha: string | undefined = process.env.COMMIT_SHA || undefined;

function deriveDisplayName(device: LnmsDevice): string {
  if (device.display) return device.display;
  const name = device.sysName || device.hostname;
  return name.replace(/\.local\.lan$/, "").replace(/\.local\.zt$/, "").replace(/\.[a-z]+\.[a-z]+$/, "");
}

export function buildAndCacheTopology(): void {
  const devices = cache.get<LnmsDevice[]>("devices") ?? [];
  const locations = cache.get<LnmsLocation[]>("locations") ?? [];
  const overlays = cache.get<import("@librenms-dash/shared").SubnetGroup[]>("overlays") ?? [];
  const alerts = cache.get<LnmsAlert[]>("alerts") ?? [];
  const lnmsLinks = cache.get<LnmsLink[]>("links") ?? [];

  const locationMap = new Map<string, LnmsLocation>();
  for (const loc of locations) locationMap.set(loc.location, loc);

  const arpLanIps = cache.get<Map<string, string>>("arpLanIps") ?? new Map<string, string>();
  const ndGlobalIpv6 = cache.get<Map<string, string[]>>("ndGlobalIpv6");

  const siteMap = new Map<string, Site>();

  for (const device of devices) {
    const locName = device.location || "Unknown";
    if (!siteMap.has(locName)) {
      const loc = locationMap.get(locName);
      siteMap.set(locName, {
        id: locName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        location: locName,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        devices: [],
      });
    }

    const ports = cache.get<LnmsPort[]>(`ports:${device.hostname}`) ?? [];
    const ips = cache.get<LnmsDeviceIp[]>(`ips:${device.hostname}`) ?? [];

    let totalIn = 0;
    let totalOut = 0;
    const macSet = new Set<string>();
    for (const p of ports) {
      totalIn += p.ifInOctets_rate ?? 0;
      totalOut += p.ifOutOctets_rate ?? 0;
      const mac = normalizeMac(p.ifPhysAddress ?? "");
      if (mac && mac.length === 12 && mac !== "000000000000") macSet.add(mac);
    }

    let lanIp = findLanIp(device.ip, ips, ports);
    const deviceIps = findDeviceIps(ips, ports);
    if (device.ip && !deviceIps.includes(device.ip) && !engine.isOverlayIp(device.ip)) deviceIps.push(device.ip);
    const arpLanIp = arpLanIps.get(device.hostname);

    const allIpsSet = new Set<string>(deviceIps);
    for (const entry of ips) {
      if (entry.ipv4_address) allIpsSet.add(entry.ipv4_address);
      const v6 = entry.ipv6_compressed ?? entry.ipv6_address;
      if (v6) allIpsSet.add(v6);
    }
    if (device.ip) allIpsSet.add(device.ip);

    const deviceNdV6 = ndGlobalIpv6?.get(device.hostname) ?? [];
    for (const v6 of deviceNdV6) {
      if (!deviceIps.includes(v6)) deviceIps.push(v6);
      allIpsSet.add(v6);
    }

    if (arpLanIp && engine.isOverlayIp(lanIp)) lanIp = arpLanIp;
    if (arpLanIp && !deviceIps.includes(arpLanIp)) deviceIps.unshift(arpLanIp);

    const summary: DeviceSummary = {
      device_id: device.device_id,
      hostname: device.hostname,
      displayName: deriveDisplayName(device),
      ip: device.ip,
      lanIp,
      ips: deviceIps,
      allIps: [...allIpsSet],
      macs: [...macSet],
      os: device.os,
      icon: device.icon,
      status: device.status,
      uptime: device.uptime,
      location: device.location,
      hardware: device.hardware,
      sysName: device.sysName,
      totalInRate: totalIn,
      totalOutRate: totalOut,
      portCount: ports.length,
      overlayPorts: getOverlayPortSummaries(ports, ips),
      routes: cache.get<DeviceRoute[]>(`routes:${device.hostname}`) ?? undefined,
    };

    siteMap.get(locName)!.devices.push(summary);
  }

  const deviceIdMap = new Map<number, LnmsDevice>();
  for (const d of devices) deviceIdMap.set(d.device_id, d);
  const deviceHostnameMap = new Map<string, LnmsDevice>();
  for (const d of devices) deviceHostnameMap.set(d.hostname, d);

  const portNameMap = new Map<number, string>();
  for (const device of devices) {
    const ports = cache.get<LnmsPort[]>(`ports:${device.hostname}`) ?? [];
    for (const p of ports) portNameMap.set(p.port_id, p.ifName || p.ifDescr || `port-${p.port_id}`);
  }

  const neighborSet = new Set<string>();
  const neighbors: NeighborLink[] = [];
  for (const link of lnmsLinks) {
    const localDev = deviceIdMap.get(link.local_device_id);
    const remoteDev = deviceIdMap.get(link.remote_device_id);
    if (!localDev || !remoteDev) continue;

    const localPortName = portNameMap.get(link.local_port_id) ?? "";
    const remotePortName = portNameMap.get(link.remote_port_id) ?? link.remote_port ?? "";
    if (localPortName && isExcludedIface(localPortName)) continue;
    if (remotePortName && isExcludedIface(remotePortName)) continue;

    const key = [link.local_device_id, link.remote_device_id].sort().join("-") +
      ":" + [link.local_port_id, link.remote_port_id].sort().join("-");
    if (neighborSet.has(key)) continue;
    neighborSet.add(key);

    neighbors.push({
      id: link.id,
      localDeviceId: link.local_device_id,
      localHostname: localDev.hostname,
      localPort: localPortName || `port-${link.local_port_id}`,
      remoteDeviceId: link.remote_device_id,
      remoteHostname: remoteDev.hostname,
      remotePort: remotePortName || `port-${link.remote_port_id}`,
      protocol: link.protocol,
    });
  }

  const arpLinks = (cache.get<ArpLink[]>("arpLinks") ?? []).filter((link) => {
    const fromDevice = deviceHostnameMap.get(link.fromHostname);
    const toDevice = deviceHostnameMap.get(link.toHostname);
    if (!fromDevice || !toDevice) return false;
    return (fromDevice.location || "Unknown") === (toDevice.location || "Unknown");
  });

  const arpDevices = cache.get<ArpDiscoveredDevice[]>("arpDevices") ?? [];

  const payload: TopologyResponse = {
    sites: [...siteMap.values()],
    overlays,
    neighbors,
    arpLinks,
    arpDevices,
    alerts: alerts.map((a) => ({
      id: a.id,
      device_id: a.device_id,
      hostname: a.hostname,
      rule: typeof a.rule === "string" ? a.rule : a.rule?.name ?? "",
      severity: a.severity,
      state: a.state,
      timestamp: a.timestamp,
    })),
    lastUpdated: new Date().toISOString(),
    commitSha,
  };

  cache.set("topology", payload, TTL.PORTS);
}

type EventListener = (events: AssetEvent[]) => void;
const sseListeners = new Set<EventListener>();

export function subscribeEvents(fn: EventListener) { sseListeners.add(fn); }
export function unsubscribeEvents(fn: EventListener) { sseListeners.delete(fn); }

type TopologyListener = (payload: TopologyResponse) => void;
const topologyListeners = new Set<TopologyListener>();

export function subscribeTopologyChanged(fn: TopologyListener) { topologyListeners.add(fn); }
export function unsubscribeTopologyChanged(fn: TopologyListener) { topologyListeners.delete(fn); }

let topologyChangedInCycle = false;

function flushTopologyChanged() {
  if (!topologyChangedInCycle) return;
  topologyChangedInCycle = false;
  buildAndCacheTopology();
  const payload = cache.get<TopologyResponse>("topology");
  if (!payload) return;
  for (const fn of topologyListeners) fn(payload);
}

function pushEvents(events: AssetEvent[]) {
  if (events.length === 0) return;
  const existing = cache.get<AssetEvent[]>("assetEvents") ?? [];
  cache.set("assetEvents", [...existing, ...events].slice(-MAX_EVENTS), 60 * 60 * 1000);
  for (const fn of sseListeners) fn(events);
}

function diffAndLog(category: string, prev: Set<string>, curr: Set<string>): Set<string> {
  if (assetBaseline.has(category)) {
    const ts = localTimestamp();
    const events: AssetEvent[] = [];
    for (const key of curr) {
      if (!prev.has(key)) {
        console.log(`${ts} [asset+] ${category} added: ${key}`);
        events.push({ id: ++eventSeq, timestamp: new Date().toISOString(), action: "added", category, asset: key });
      }
    }
    for (const key of prev) {
      if (!curr.has(key)) {
        console.log(`${ts} [asset-] ${category} removed: ${key}`);
        events.push({ id: ++eventSeq, timestamp: new Date().toISOString(), action: "removed", category, asset: key });
      }
    }
    pushEvents(events);
    if (events.length > 0) topologyChangedInCycle = true;
  }
  assetBaseline.add(category);
  return curr;
}

async function fetchDevices(): Promise<LnmsDevice[]> {
  const res = await librenmsGet<{ devices: LnmsDevice[] }>("/devices");
  return res.devices;
}

async function fetchLocations(): Promise<LnmsLocation[]> {
  const res = await librenmsGet<{ locations: LnmsLocation[] }>("/resources/locations");
  return res.locations;
}

async function fetchAlerts(): Promise<LnmsAlert[]> {
  const res = await librenmsGet<{ alerts: LnmsAlert[] }>("/alerts", { state: "1" });
  return res.alerts ?? [];
}

async function fetchLinks(): Promise<LnmsLink[]> {
  const res = await librenmsGet<{ links: LnmsLink[] }>("/resources/links");
  return (res.links ?? []).filter((l) => l.active === 1);
}

const PORT_COLUMNS = "port_id,device_id,ifName,ifDescr,ifAlias,ifSpeed,ifInOctets_rate,ifOutOctets_rate,ifOperStatus,ifAdminStatus,ifType,ifPhysAddress";

async function fetchDevicePorts(hostname: string): Promise<LnmsPort[]> {
  const res = await librenmsGet<{ ports: LnmsPort[] }>(`/devices/${hostname}/ports`, { columns: PORT_COLUMNS });
  return res.ports ?? [];
}

async function fetchDeviceIps(hostname: string): Promise<LnmsDeviceIp[]> {
  const res = await librenmsGet<Record<string, unknown>>(`/devices/${hostname}/ip`);
  const addresses = (res.addresses ?? res.ip ?? res.data ?? []) as LnmsDeviceIp[];
  return Array.isArray(addresses) ? addresses : [];
}

export async function pollDevicesAndLocations() {
  console.log("[poller] Refreshing devices and locations...");
  const [allDevices, locations, links] = await Promise.all([fetchDevices(), fetchLocations(), fetchLinks()]);
  const devices = allDevices.filter((d) => d.disabled !== 1);
  cache.set("devices", devices, TTL.DEVICES);
  cache.set("allDevicesForExclusion", allDevices, TTL.DEVICES);
  cache.set("locations", locations, TTL.LOCATIONS);
  cache.set("links", links, TTL.DEVICES);
  const skipped = allDevices.length - devices.length;
  console.log(`[poller] Cached ${devices.length} devices (${skipped} disabled/ignored skipped), ${locations.length} locations, ${links.length} neighbor links`);

  const currDevices = new Set(devices.map(d => `${d.hostname} (${d.ip})`));
  prevAssets.devices = diffAndLog("device", prevAssets.devices, currDevices);

  for (const d of devices) {
    const prev = prevDeviceStatus.get(d.hostname);
    if (prev !== undefined && prev !== d.status) {
      const label = d.status === 1 ? "up" : "down";
      console.log(`${localTimestamp()} [status] ${d.hostname} went ${label}`);
      topologyChangedInCycle = true;
    }
    prevDeviceStatus.set(d.hostname, d.status);
  }

  flushTopologyChanged();
}

export async function pollPortsAndIps() {
  const devices = cache.get<LnmsDevice[]>("devices");
  if (!devices) return;

  console.log(`[poller] Refreshing ports for ${devices.length} devices...`);
  const allPorts = new Map<string, LnmsPort[]>();
  const allIps = new Map<string, LnmsDeviceIp[]>();

  for (const device of devices) {
    if (device.status !== 1) continue; // skip down devices
    const [portsResult, ipsResult] = await Promise.allSettled([
      fetchDevicePorts(device.hostname),
      fetchDeviceIps(device.hostname),
    ]);
    const ports = portsResult.status === "fulfilled" ? portsResult.value : [];
    const ips = ipsResult.status === "fulfilled" ? ipsResult.value : [];
    if (portsResult.status === "rejected") console.warn(`[poller] Failed to fetch ports for ${device.hostname}:`, portsResult.reason);
    if (ipsResult.status === "rejected") console.warn(`[poller] Failed to fetch ips for ${device.hostname}:`, ipsResult.reason);
    allPorts.set(device.hostname, ports);
    allIps.set(device.hostname, ips);
    cache.set(`ports:${device.hostname}`, ports, TTL.PORTS);
    cache.set(`ips:${device.hostname}`, ips, TTL.DEVICE_IPS);
    await delay(STAGGER_MS);
  }

  const overlays = buildOverlayLinks(allPorts, allIps);
  cache.set("overlays", overlays, TTL.PORTS);
  console.log(`[poller] Cached overlays: ${overlays.map((o) => `${o.overlayType}(${o.links.length} links)`).join(", ")}`);

  const currPorts = new Set<string>();
  const currIps = new Set<string>();
  for (const [hostname, ports] of allPorts) {
    for (const p of ports) if (p.ifName) currPorts.add(`${hostname}/${p.ifName}`);
  }
  for (const [hostname, ips] of allIps) {
    for (const ip of ips) {
      if (ip.ipv4_address) currIps.add(`${hostname} ${ip.ipv4_address}`);
      const v6 = ip.ipv6_compressed ?? ip.ipv6_address;
      if (v6 && !v6.startsWith("fe80:") && v6 !== "::1") currIps.add(`${hostname} ${v6}`);
    }
  }
  prevAssets.ports = diffAndLog("port", prevAssets.ports, currPorts);
  prevAssets.ips = diffAndLog("ip", prevAssets.ips, currIps);

  const currOverlays = new Set<string>();
  for (const g of overlays) {
    for (const l of g.links) currOverlays.add(`${g.overlayType} ${l.from}<>${l.to}`);
  }
  prevAssets.overlayLinks = diffAndLog("overlay-link", prevAssets.overlayLinks, currOverlays);
  flushTopologyChanged();

  // Build ARP-based connections (non-blocking, runs in background)
  pollArpLinks(devices, allIps, allPorts).catch(e => console.warn("[poller] ARP poll failed:", e));
}

async function pollArpLinks(devices: LnmsDevice[], allIps: Map<string, LnmsDeviceIp[]>, allPorts: Map<string, LnmsPort[]>) {
  console.log("[poller] Building ARP link map...");

  const deviceIdToHostname = new Map<number, string>();
  const ipToHostname = new Map<string, string>();
  const hostnameToLocation = new Map<string, string>();

  // Include ALL LibreNMS devices (active + disabled) in managed exclusion set.
  // Managed IPs are scoped per-location because LAN subnets can overlap across
  // sites (e.g. 192.168.1.0/24 at both BLR-R and GGN are different networks).
  const allDevicesForExclusion = cache.get<LnmsDevice[]>("allDevicesForExclusion") ?? devices;
  const managedIpsByLocation = new Map<string, Set<string>>();
  for (const d of allDevicesForExclusion) {
    deviceIdToHostname.set(d.device_id, d.hostname);
    const loc = d.location || "Unknown";
    hostnameToLocation.set(d.hostname, loc);
    let locIps = managedIpsByLocation.get(loc);
    if (!locIps) {
      locIps = new Set();
      managedIpsByLocation.set(loc, locIps);
    }
    locIps.add(d.ip);
    const ips = allIps.get(d.hostname) ?? [];
    for (const ip of ips) {
      locIps.add(ip.ipv4_address);
    }
  }
  // Active device IDs — used to restrict which devices can be "seenBy" sources
  const activeDeviceIds = new Set(devices.map((d) => d.device_id));

  // Map each port_id to its interface name (from the per-device port cache) so
  // ARP links/devices can report which interface a device learned a peer on.
  // Built early because ipToHostname filtering needs it.
  const portIdToIfName = new Map<number, string>();
  const portIdToMac = new Map<number, string>();
  for (const d of allDevicesForExclusion) {
    const ports = allPorts.get(d.hostname) ?? cache.get<LnmsPort[]>(`ports:${d.hostname}`);
    if (!ports) continue;
    for (const p of ports) {
      const name = p.ifName || p.ifDescr;
      if (name) portIdToIfName.set(p.port_id, name);
      const mac = normalizeMac(p.ifPhysAddress ?? "");
      if (mac && mac.length === 12 && mac !== "000000000000") portIdToMac.set(p.port_id, mac);
    }
  }

  // MAC → hostname for managed devices (from interface MACs), used for
  // MAC-based ARP link matching when IP-based matching misses (e.g. device
  // whose IP endpoint 404s but whose interface MACs appear in other ARP tables).
  const macToHostname = new Map<string, string>();
  for (const d of devices) {
    const ports = allPorts.get(d.hostname) ?? cache.get<LnmsPort[]>(`ports:${d.hostname}`);
    if (!ports) continue;
    for (const p of ports) {
      const mac = normalizeMac(p.ifPhysAddress ?? "");
      if (mac && mac.length === 12 && mac !== "000000000000") {
        macToHostname.set(mac, d.hostname);
      }
    }
  }

  // Map port_id → first local IPv4 on that port (for seenByIp on discovered devices).
  const portIdToIp = new Map<number, string>();
  for (const [, ips] of allIps) {
    for (const ip of ips) {
      if (!ip.ipv4_address || portIdToIp.has(ip.port_id)) continue;
      if (engine.isOverlayIp(ip.ipv4_address) || isDockerIp(ip.ipv4_address)) continue;
      portIdToIp.set(ip.port_id, ip.ipv4_address);
    }
  }

  // Active devices provide IP→hostname mapping for ARP link building.
  // Only map local IPs (skip overlay, docker-bridge, and excluded interfaces)
  // so ARP links stay on physical/LAN paths.
  for (const d of devices) {
    if (!engine.isOverlayIp(d.ip) && !isDockerIp(d.ip)) {
      ipToHostname.set(d.ip, d.hostname);
    }
    const ips = allIps.get(d.hostname) ?? [];
    for (const ip of ips) {
      if (!ip.ipv4_address) continue;
      if (engine.isOverlayIp(ip.ipv4_address)) continue;
      if (isDockerIp(ip.ipv4_address)) continue;
      const ifName = portIdToIfName.get(ip.port_id) ?? "";
      if (ifName && isExcludedIface(ifName)) continue;
      ipToHostname.set(ip.ipv4_address, d.hostname);
    }
  }

  // Pre-compute each device's local (LAN) IP for ARP link toIp field.
  const hostnameToLocalIp = new Map<string, string>();
  for (const d of devices) {
    const ips = allIps.get(d.hostname) ?? [];
    const ports = allPorts.get(d.hostname) ?? cache.get<LnmsPort[]>(`ports:${d.hostname}`) ?? [];
    hostnameToLocalIp.set(d.hostname, findLanIp(d.ip, ips, ports));
  }

  const linkSet = new Set<string>();
  const arpLinks: ArpLink[] = [];

  // Treat configured overlay ranges and excluded infrastructure ranges as
  // non-discoverable when scanning ARP tables (see config.ts / .env).
  const isOverlayIp = isExcludedArpIp;

  const uniqueIps = [...new Set(
    devices.flatMap(d => {
      const ips = allIps.get(d.hostname) ?? [];
      return [d.ip, ...ips.map(i => i.ipv4_address)];
    }).filter(ip => ip && ipToHostname.has(ip) && !isOverlayIp(ip))
  )];

  // Collect ALL ARP entries
  const allArpEntries: LnmsArpEntry[] = [];

  for (const ip of uniqueIps) {
    const ownerHostname = ipToHostname.get(ip);
    if (!ownerHostname) continue;

    try {
      const res = await librenmsGet<{ arp: LnmsArpEntry[] }>(`/resources/ip/arp/${ip}`);
      const entries = res.arp ?? [];

      for (const entry of entries) {
        allArpEntries.push(entry);

        const seeingHostname = deviceIdToHostname.get(entry.device_id);
        if (!seeingHostname || seeingHostname === ownerHostname) continue;
        if (hostnameToLocation.get(seeingHostname) !== hostnameToLocation.get(ownerHostname)) continue;

        // Only build links from local interfaces
        const ifName = portIdToIfName.get(entry.port_id) ?? "";
        if (ifName && isExcludedIface(ifName)) continue;

        const key = [ownerHostname, seeingHostname].sort().join("<>");
        if (linkSet.has(key)) continue;
        linkSet.add(key);

        const ownerIps = allIps.get(ownerHostname) ?? [];
        const ownerPortId = ownerIps.find(i => i.ipv4_address === ip)?.port_id;
        const fromIfName = ownerPortId ? portIdToIfName.get(ownerPortId) : undefined;
        const fromMac = ownerPortId ? portIdToMac.get(ownerPortId) : undefined;
        const toMac = portIdToMac.get(entry.port_id);

        arpLinks.push({
          fromHostname: ownerHostname,
          toHostname: seeingHostname,
          fromIp: ip,
          toIp: hostnameToLocalIp.get(seeingHostname) ?? "",
          mac: entry.mac_address,
          fromInterface: fromIfName,
          fromMac: fromMac ?? entry.mac_address,
          toInterface: ifName || undefined,
          toMac,
        });
      }
    } catch {
      // skip IPs that fail
    }
    await delay(50);
  }

  // Also fetch all ARP entries to discover non-managed devices
  try {
    const res = await librenmsGet<{ arp: LnmsArpEntry[] }>("/resources/ip/arp/all");
    const entries = res.arp ?? [];
    for (const entry of entries) allArpEntries.push(entry);
  } catch {
    // fall through with whatever we collected per-IP
  }

  // Second pass: create ARP links via MAC matching for managed devices that
  // the IP-based pass missed (e.g. device whose /ip endpoint 404s but whose
  // interface MACs appear in other devices' ARP tables).
  for (const entry of allArpEntries) {
    const seeingHostname = deviceIdToHostname.get(entry.device_id);
    if (!seeingHostname) continue;
    if (!activeDeviceIds.has(entry.device_id)) continue;

    const mac = normalizeMac(entry.mac_address);
    const macOwner = macToHostname.get(mac);
    if (!macOwner || macOwner === seeingHostname) continue;
    if (hostnameToLocation.get(seeingHostname) !== hostnameToLocation.get(macOwner)) continue;

    const ifName = portIdToIfName.get(entry.port_id) ?? "";
    if (ifName && isExcludedIface(ifName)) continue;

    const key = [macOwner, seeingHostname].sort().join("<>");
    if (linkSet.has(key)) continue;
    linkSet.add(key);

    const toMac = portIdToMac.get(entry.port_id);

    arpLinks.push({
      fromHostname: macOwner,
      toHostname: seeingHostname,
      fromIp: entry.ipv4_address,
      toIp: hostnameToLocalIp.get(seeingHostname) ?? "",
      mac: entry.mac_address,
      fromInterface: undefined,
      fromMac: mac,
      toInterface: ifName || undefined,
      toMac,
    });
  }

  // Build managed MAC set from ARP entries matching managed IPs (per-location).
  // MACs are globally unique, but the IP→MAC association must be checked against
  // the correct location to avoid false matches from overlapping subnets.
  const managedMacsByLocation = new Map<string, Set<string>>();
  for (const entry of allArpEntries) {
    const seenBy = deviceIdToHostname.get(entry.device_id);
    const loc = seenBy ? (hostnameToLocation.get(seenBy) ?? "Unknown") : "Unknown";
    const locIps = managedIpsByLocation.get(loc);
    if (locIps?.has(entry.ipv4_address)) {
      let locMacs = managedMacsByLocation.get(loc);
      if (!locMacs) {
        locMacs = new Set();
        managedMacsByLocation.set(loc, locMacs);
      }
      locMacs.add(normalizeMac(entry.mac_address));
    }
  }

  // Include interface MACs (ifPhysAddress) from ALL managed devices so their
  // interfaces never appear as independent unmanaged discovered devices.
  for (const d of allDevicesForExclusion) {
    const loc = d.location || "Unknown";
    let locMacs = managedMacsByLocation.get(loc);
    if (!locMacs) {
      locMacs = new Set();
      managedMacsByLocation.set(loc, locMacs);
    }
    const cached = allPorts.get(d.hostname) ?? cache.get<LnmsPort[]>(`ports:${d.hostname}`);
    if (cached) {
      for (const p of cached) {
        const mac = normalizeMac(p.ifPhysAddress ?? "");
        if (mac && mac.length === 12 && mac !== "000000000000") locMacs.add(mac);
      }
    } else {
      try {
        const res = await librenmsGet<{ ports: Array<{ ifPhysAddress?: string }> }>(`/devices/${d.hostname}/ports`, { columns: "port_id,ifPhysAddress" });
        for (const p of (res.ports ?? [])) {
          const mac = normalizeMac(p.ifPhysAddress ?? "");
          if (mac && mac.length === 12 && mac !== "000000000000") locMacs.add(mac);
        }
      } catch { /* skip */ }
      await delay(50);
    }
  }

  // --- Consolidation: union-find to merge MACs sharing an IP and IPs sharing a MAC ---
  const arpDevices = consolidateArpDevices(allArpEntries, managedIpsByLocation, managedMacsByLocation, deviceIdToHostname, hostnameToLocation, isOverlayIp, portIdToIfName, portIdToMac, portIdToIp, activeDeviceIds);

  // Discover LAN IPs for managed devices from ARP entries where a device's
  // interface MAC is seen at a non-overlay, non-docker IP. This catches devices
  // polled only via overlay whose /ip endpoint fails.
  const arpLanIps = new Map<string, string>();
  for (const entry of allArpEntries) {
    const mac = normalizeMac(entry.mac_address);
    const owner = macToHostname.get(mac);
    if (!owner) continue;
    if (arpLanIps.has(owner)) continue;
    const ip = entry.ipv4_address;
    if (!ip || ip === "0.0.0.0") continue;
    if (engine.isOverlayIp(ip) || isDockerIp(ip)) continue;
    if (isExcludedArpIp(ip)) continue;
    arpLanIps.set(owner, ip);
  }
  cache.set("arpLanIps", arpLanIps, TTL.PORTS);

  cache.set("arpLinks", arpLinks, TTL.PORTS);
  cache.set("arpDevices", arpDevices, TTL.PORTS);
  console.log(`[poller] Cached ${arpLinks.length} ARP links, ${arpDevices.length} discovered devices (consolidated), ${arpLanIps.size} ARP-discovered LAN IPs from ${allArpEntries.length} ARP entries`);

  const currArpDevices = new Set(arpDevices.map(d => {
    const mac = d.mac.replace(/(.{2})(?=.)/g, "$1:");
    return `${mac} at ${d.location}`;
  }));
  prevAssets.arpDevices = diffAndLog("discovered-device", prevAssets.arpDevices, currArpDevices);
  flushTopologyChanged();
}

function consolidateArpDevices(
  allArpEntries: LnmsArpEntry[],
  managedIpsByLocation: Map<string, Set<string>>,
  managedMacsByLocation: Map<string, Set<string>>,
  deviceIdToHostname: Map<number, string>,
  hostnameToLocation: Map<string, string>,
  isOverlayIp: (ip: string) => boolean,
  portIdToIfName: Map<number, string>,
  portIdToMac: Map<number, string>,
  portIdToIp: Map<number, string>,
  activeDeviceIds: Set<number>,
): ArpDiscoveredDevice[] {
  // Phase 1: collect valid (mac, ip) pairs, grouped by location.
  // Scoping by location prevents cross-site merging from swallowing devices.
  const pairsByLocation = new Map<string, Array<{ mac: string; ip: string; deviceId: number; portId: number }>>();
  const seen = new Set<string>();

  for (const entry of allArpEntries) {
    // Only use ARP entries from active (non-disabled) devices as sources
    if (!activeDeviceIds.has(entry.device_id)) continue;

    const mac = normalizeMac(entry.mac_address);
    const ip = entry.ipv4_address;
    if (!mac || !ip || ip === "0.0.0.0") continue;
    if (mac === "000000000000" || mac === "FFFFFFFFFFFF") continue;
    if (isBogus(mac)) continue;
    if (isOverlayIp(ip)) continue;

    // Skip entries learned on overlay or docker bridge interfaces
    const ifName = portIdToIfName.get(entry.port_id);
    if (ifName && isExcludedIface(ifName)) continue;

    const seenBy = deviceIdToHostname.get(entry.device_id);
    if (!seenBy) continue;
    const location = hostnameToLocation.get(seenBy) ?? "Unknown";

    // Managed exclusion is per-location — overlapping LAN subnets across sites
    // mean the same IP can be managed at one site and unmanaged at another.
    const locIps = managedIpsByLocation.get(location);
    const locMacs = managedMacsByLocation.get(location);
    if (locIps?.has(ip) || locMacs?.has(mac)) continue;

    const pairKey = `${location}:${mac}:${ip}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    let pairs = pairsByLocation.get(location);
    if (!pairs) {
      pairs = [];
      pairsByLocation.set(location, pairs);
    }
    pairs.push({ mac, ip, deviceId: entry.device_id, portId: entry.port_id });
  }

  // Phase 2–4: run union-find per location so deduplication stays within a site
  const arpDevices: ArpDiscoveredDevice[] = [];

  for (const [location, pairs] of pairsByLocation) {
    const siteId = location.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    // Union-find — merge entries that share a MAC or an IP within this location
    const parent = new Map<string, string>();

    function find(x: string): string {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (cur !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    }

    function union(a: string, b: string) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    for (const p of pairs) {
      const mk = `mac:${p.mac}`;
      const ik = `ip:${p.ip}`;
      if (!parent.has(mk)) parent.set(mk, mk);
      if (!parent.has(ik)) parent.set(ik, ik);
      union(mk, ik);
    }

    // Group pairs by component
    const components = new Map<string, { macs: Set<string>; ips: Set<string>; deviceId: number; portId: number }>();
    for (const p of pairs) {
      const root = find(`mac:${p.mac}`);
      let comp = components.get(root);
      if (!comp) {
        comp = { macs: new Set(), ips: new Set(), deviceId: p.deviceId, portId: p.portId };
        components.set(root, comp);
      }
      comp.macs.add(p.mac);
      comp.ips.add(p.ip);
    }

    // Build output — one entry per component per location
    for (const [, comp] of components) {
      const seenBy = deviceIdToHostname.get(comp.deviceId);
      if (!seenBy) continue;

      const macArr = [...comp.macs];
      const bestMac = macArr.reduce((best, mac) => {
        const bestIsLocal = isLocallyAdministered(best);
        const macIsLocal = isLocallyAdministered(mac);
        if (bestIsLocal && !macIsLocal) return mac;
        if (!bestIsLocal && macIsLocal) return best;
        const bestVendor = lookupVendor(best);
        const macVendor = lookupVendor(mac);
        if (!bestVendor && macVendor) return mac;
        return best;
      });

      const ips = [...comp.ips].sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 4; i++) {
          if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }
        return 0;
      });

      arpDevices.push({
        mac: bestMac,
        macs: macArr,
        ips,
        vendor: lookupVendor(bestMac),
        location,
        siteId,
        seenByHostname: seenBy,
        seenByInterface: portIdToIfName.get(comp.portId),
        seenByIp: portIdToIp.get(comp.portId),
        seenByMac: portIdToMac.get(comp.portId),
      });
    }
  }

  return arpDevices;
}

function isBogus(mac: string): boolean {
  if (mac.length !== 12) return true;
  // All-same-nibble patterns like bc0000000000
  if (/^[0-9A-F]{2}0{10}$/i.test(mac)) return true;
  // All-same-byte
  const b = mac.slice(0, 2);
  if (mac === b.repeat(6)) return true;
  return false;
}

function isLocallyAdministered(mac: string): boolean {
  const firstByte = parseInt(mac.slice(0, 2), 16);
  return (firstByte & 0x02) !== 0;
}

export async function pollRoutes() {
  if (!isWebClientEnabled()) return;

  const devices = cache.get<LnmsDevice[]>("devices");
  if (!devices) return;

  let totalRoutes = 0;
  let devicesWithRoutes = 0;
  const currRoutes = new Set<string>();

  for (const device of devices) {
    if (device.status !== 1) continue;
    try {
      const rawRoutes = await fetchRoutes(device.device_id);
      if (!isWebClientEnabled()) return;

      const routes: DeviceRoute[] = [];
      for (const r of rawRoutes) {
        if (r.inetCidrRouteDestType !== "ipv4") continue;
        if (r.inetCidrRouteType !== "remote") continue;

        const nextHop = extractNextHop(r.inetCidrRouteNextHop);
        if (!nextHop || nextHop === "hide") continue;

        routes.push({
          dest: stripHtml(r.inetCidrRouteDest),
          prefix: parseInt(r.inetCidrRoutePfxLen, 10) || 0,
          nextHop,
          iface: extractIfaceName(r.inetCidrRouteIfIndex),
          protocol: r.inetCidrRouteProto,
          type: r.inetCidrRouteType,
        });
      }

      if (routes.length > 0) {
        cache.set(`routes:${device.hostname}`, routes, TTL.ROUTES);
        totalRoutes += routes.length;
        devicesWithRoutes++;
        for (const r of routes) currRoutes.add(`${device.hostname} ${r.dest}/${r.prefix} via ${r.nextHop}`);
      }
    } catch {
      // skip devices that fail
    }
    await delay(STAGGER_MS);
  }

  console.log(`[poller] Cached ${totalRoutes} routes across ${devicesWithRoutes} devices`);

  prevAssets.routes = diffAndLog("route", prevAssets.routes, currRoutes);
  flushTopologyChanged();
}

export async function pollNdNeighbours() {
  if (!isWebClientEnabled()) return;

  const devices = cache.get<LnmsDevice[]>("devices");
  if (!devices) return;

  // Build mac → hostname map from cached port data
  const macToHostname = new Map<string, string>();
  const hostnameToLocation = new Map<string, string>();
  for (const d of devices) {
    hostnameToLocation.set(d.hostname, d.location || "Unknown");
    const ports = cache.get<LnmsPort[]>(`ports:${d.hostname}`);
    if (!ports) continue;
    for (const p of ports) {
      const mac = normalizeMac(p.ifPhysAddress ?? "");
      if (mac && mac.length === 12 && mac !== "000000000000") macToHostname.set(mac, d.hostname);
    }
  }

  const ndGlobalIpv6 = new Map<string, string[]>();
  // Unmanaged: mac → { ips, vendor, seenByHostname, seenByPort, location }
  const ndUnmanaged = new Map<string, { ips: Set<string>; vendor: string; seenByHostname: string; seenByPort: string; location: string }>();

  let totalEntries = 0;

  for (const device of devices) {
    if (device.status !== 1) continue;
    const location = hostnameToLocation.get(device.hostname) ?? "Unknown";

    try {
      const entries = await fetchNdNeighbours(device.device_id);
      if (!isWebClientEnabled()) return;
      totalEntries += entries.length;

      for (const entry of entries) {
        const mac = normalizeMac(entry.mac);
        if (!mac || mac.length !== 12 || mac === "000000000000") continue;
        const ipv6 = entry.ipv6.trim();
        if (!ipv6) continue;

        // Only non-link-local, non-loopback addresses provide topology value
        const isGlobal = !ipv6.startsWith("fe80:") && ipv6 !== "::1"
          && !ipv6.startsWith("fc") && !ipv6.startsWith("fd");
        if (!isGlobal) continue;

        if (macToHostname.has(mac)) {
          // Known managed device — collect its global/ULA IPv6
          const hostname = macToHostname.get(mac)!;
          const list = ndGlobalIpv6.get(hostname) ?? [];
          if (!list.includes(ipv6)) list.push(ipv6);
          ndGlobalIpv6.set(hostname, list);
        } else {
          // Unmanaged device visible only via ND
          const existing = ndUnmanaged.get(mac);
          if (existing) {
            existing.ips.add(ipv6);
          } else {
            ndUnmanaged.set(mac, { ips: new Set([ipv6]), vendor: entry.vendor, seenByHostname: device.hostname, seenByPort: entry.portName, location });
          }
        }
      }
    } catch { /* skip */ }
    await delay(STAGGER_MS);
  }

  cache.set("ndGlobalIpv6", ndGlobalIpv6, TTL.PORTS);

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
}

let prevAlertIds = new Set<number>();

export async function pollAlerts() {
  const alerts = await fetchAlerts();
  cache.set("alerts", alerts, TTL.ALERTS);

  const currIds = new Set(alerts.map(a => a.id));
  if (prevAlertIds.size > 0 || currIds.size > 0) {
    let changed = currIds.size !== prevAlertIds.size;
    if (!changed) {
      for (const id of currIds) {
        if (!prevAlertIds.has(id)) { changed = true; break; }
      }
    }
    if (changed) {
      topologyChangedInCycle = true;
      flushTopologyChanged();
    }
  }
  prevAlertIds = currIds;
}

export async function warmCache() {
  console.log("[poller] Warming cache...");
  await loadOuiDatabases();
  await initWebSession();
  await pollDevicesAndLocations();
  await pollAlerts();
  await pollPortsAndIps();
  await pollRoutes();
  await pollNdNeighbours();
  console.log("[poller] Cache warm complete");
}

// Run an async poll on an interval without letting a rejection become an
// unhandled rejection that could crash the process.
function safeInterval(fn: () => Promise<unknown>, ms: number) {
  setInterval(() => {
    fn().catch((e) => console.error(`[poller] ${fn.name} failed:`, e));
  }, ms);
}

export function startPoller() {
  // Devices + locations: every 5 min (keeps status / uptime / last_polled fresh)
  safeInterval(pollDevicesAndLocations, DEVICE_POLL_MS);

  // Ports + overlays: every 5 min
  safeInterval(pollPortsAndIps, TTL.PORTS);

  // Alerts: every 2 min
  safeInterval(pollAlerts, TTL.ALERTS);

  // Routes: every 5 min (same as ports)
  safeInterval(pollRoutes, TTL.PORTS);
  safeInterval(pollNdNeighbours, TTL.PORTS);
}
