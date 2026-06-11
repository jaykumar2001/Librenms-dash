import { cache, TTL } from "../cache/store.js";
import { librenmsGet, delay } from "../librenms/client.js";
import { buildOverlayLinks } from "../librenms/overlays.js";
import { loadOuiDatabases, lookupVendor, normalizeMac } from "../librenms/oui.js";
import { makeCidrMatcher } from "../librenms/cidr.js";
import { ARP_EXCLUDED_SUBNETS, OVERLAY_SUBNETS } from "../config.js";
import { initWebSession, isWebClientEnabled, fetchRoutes, extractIfaceName, extractNextHop, stripHtml } from "../librenms/web-client.js";
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsLocation, LnmsAlert, LnmsLink, LnmsArpEntry } from "../librenms/types.js";
import type { ArpLink, ArpDiscoveredDevice, DeviceRoute, AssetEvent } from "@librenms-dash/shared";

const STAGGER_MS = 200;

// How often to refresh the device list (status, uptime, last_polled). Kept well
// below TTL.DEVICES so the cached list never expires between polls. LibreNMS itself
// typically polls every 5 min, so a shorter interval here wouldn't add freshness.
const DEVICE_POLL_MS = 5 * 60 * 1000;

// IPs never treated as discoverable ARP neighbours: configured overlay ranges
// plus excluded infrastructure ranges (loopback, link-local, Docker, …).
const isExcludedArpIp = makeCidrMatcher([
  ...ARP_EXCLUDED_SUBNETS,
  ...Object.values(OVERLAY_SUBNETS).flat(),
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
let eventSeq = 0;
const MAX_EVENTS = 200;

type EventListener = (events: AssetEvent[]) => void;
const sseListeners = new Set<EventListener>();

export function subscribeEvents(fn: EventListener) { sseListeners.add(fn); }
export function unsubscribeEvents(fn: EventListener) { sseListeners.delete(fn); }

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
}

export async function pollPortsAndIps() {
  const devices = cache.get<LnmsDevice[]>("devices");
  if (!devices) return;

  console.log(`[poller] Refreshing ports for ${devices.length} devices...`);
  const allPorts = new Map<string, LnmsPort[]>();
  const allIps = new Map<string, LnmsDeviceIp[]>();

  for (const device of devices) {
    if (device.status !== 1) continue; // skip down devices
    try {
      const [ports, ips] = await Promise.all([
        fetchDevicePorts(device.hostname),
        fetchDeviceIps(device.hostname),
      ]);
      allPorts.set(device.hostname, ports);
      allIps.set(device.hostname, ips);
      cache.set(`ports:${device.hostname}`, ports, TTL.PORTS);
      cache.set(`ips:${device.hostname}`, ips, TTL.DEVICE_IPS);
    } catch (e) {
      console.warn(`[poller] Failed to fetch ports/ips for ${device.hostname}:`, e);
    }
    await delay(STAGGER_MS);
  }

  const overlays = buildOverlayLinks(allPorts, allIps);
  cache.set("overlays", overlays, TTL.PORTS);
  console.log(`[poller] Cached overlays: ${overlays.map((o) => `${o.type}(${o.links.length} links)`).join(", ")}`);

  const currPorts = new Set<string>();
  const currIps = new Set<string>();
  for (const [hostname, ports] of allPorts) {
    for (const p of ports) if (p.ifName) currPorts.add(`${hostname}/${p.ifName}`);
  }
  for (const [hostname, ips] of allIps) {
    for (const ip of ips) if (ip.ipv4_address) currIps.add(`${hostname} ${ip.ipv4_address}`);
  }
  prevAssets.ports = diffAndLog("port", prevAssets.ports, currPorts);
  prevAssets.ips = diffAndLog("ip", prevAssets.ips, currIps);

  const currOverlays = new Set<string>();
  for (const g of overlays) {
    for (const l of g.links) currOverlays.add(`${g.type} ${l.from}<>${l.to}`);
  }
  prevAssets.overlayLinks = diffAndLog("overlay-link", prevAssets.overlayLinks, currOverlays);

  // Build ARP-based connections (non-blocking, runs in background)
  pollArpLinks(devices, allIps).catch(e => console.warn("[poller] ARP poll failed:", e));
}

async function pollArpLinks(devices: LnmsDevice[], allIps: Map<string, LnmsDeviceIp[]>) {
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

  // Active devices also provide IP→hostname mapping for ARP link building
  for (const d of devices) {
    ipToHostname.set(d.ip, d.hostname);
    const ips = allIps.get(d.hostname) ?? [];
    for (const ip of ips) {
      ipToHostname.set(ip.ipv4_address, d.hostname);
    }
  }

  // Map each port_id to its interface name (from the per-device port cache) so
  // ARP links/devices can report which interface a device learned a peer on.
  const portIdToIfName = new Map<number, string>();
  for (const d of allDevicesForExclusion) {
    const ports = cache.get<LnmsPort[]>(`ports:${d.hostname}`);
    if (!ports) continue;
    for (const p of ports) {
      const name = p.ifName || p.ifDescr;
      if (name) portIdToIfName.set(p.port_id, name);
    }
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

        const key = [ownerHostname, seeingHostname].sort().join("<>");
        if (linkSet.has(key)) continue;
        linkSet.add(key);

        const seeingDevice = devices.find(d => d.hostname === seeingHostname);
        arpLinks.push({
          fromHostname: ownerHostname,
          toHostname: seeingHostname,
          fromIp: ip,
          toIp: seeingDevice?.ip ?? "",
          mac: entry.mac_address,
          toInterface: portIdToIfName.get(entry.port_id),
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
    const cached = cache.get<LnmsPort[]>(`ports:${d.hostname}`);
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
  const arpDevices = consolidateArpDevices(allArpEntries, managedIpsByLocation, managedMacsByLocation, deviceIdToHostname, hostnameToLocation, isOverlayIp, portIdToIfName, activeDeviceIds);

  cache.set("arpLinks", arpLinks, TTL.PORTS);
  cache.set("arpDevices", arpDevices, TTL.PORTS);
  console.log(`[poller] Cached ${arpLinks.length} ARP links, ${arpDevices.length} discovered devices (consolidated) from ${allArpEntries.length} ARP entries`);

  const currArpDevices = new Set(arpDevices.map(d => {
    const mac = d.mac.replace(/(.{2})(?=.)/g, "$1:");
    return `${mac} at ${d.location}`;
  }));
  prevAssets.arpDevices = diffAndLog("discovered-device", prevAssets.arpDevices, currArpDevices);
}

function consolidateArpDevices(
  allArpEntries: LnmsArpEntry[],
  managedIpsByLocation: Map<string, Set<string>>,
  managedMacsByLocation: Map<string, Set<string>>,
  deviceIdToHostname: Map<number, string>,
  hostnameToLocation: Map<string, string>,
  isOverlayIp: (ip: string) => boolean,
  portIdToIfName: Map<number, string>,
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

    // Skip MACs learned on ZeroTier interfaces
    const ifName = portIdToIfName.get(entry.port_id);
    if (ifName && /^zt/i.test(ifName)) continue;

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
}

export async function pollAlerts() {
  const alerts = await fetchAlerts();
  cache.set("alerts", alerts, TTL.ALERTS);
}

export async function warmCache() {
  console.log("[poller] Warming cache...");
  await loadOuiDatabases();
  await initWebSession();
  await pollDevicesAndLocations();
  await pollAlerts();
  await pollPortsAndIps();
  await pollRoutes();
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
}
