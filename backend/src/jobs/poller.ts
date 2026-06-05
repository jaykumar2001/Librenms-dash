import { cache, TTL } from "../cache/store.js";
import { librenmsGet, delay } from "../librenms/client.js";
import { buildOverlayLinks } from "../librenms/overlays.js";
import { loadOuiDatabases, lookupVendor, normalizeMac } from "../librenms/oui.js";
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsLocation, LnmsAlert, LnmsLink, LnmsArpEntry } from "../librenms/types.js";
import type { ArpLink, ArpDiscoveredDevice } from "@librenms-dash/shared";

const STAGGER_MS = 200;

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

const PORT_COLUMNS = "port_id,device_id,ifName,ifDescr,ifAlias,ifSpeed,ifInOctets_rate,ifOutOctets_rate,ifOperStatus,ifAdminStatus,ifType";

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
  console.log(`[poller] Cached ${devices.length} devices (${allDevices.length - devices.length} disabled skipped), ${locations.length} locations, ${links.length} neighbor links`);
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

  // Build ARP-based connections (non-blocking, runs in background)
  pollArpLinks(devices, allIps).catch(e => console.warn("[poller] ARP poll failed:", e));
}

async function pollArpLinks(devices: LnmsDevice[], allIps: Map<string, LnmsDeviceIp[]>) {
  console.log("[poller] Building ARP link map...");

  const deviceIdToHostname = new Map<number, string>();
  const ipToHostname = new Map<string, string>();
  const hostnameToLocation = new Map<string, string>();

  // Include ALL LibreNMS devices (active + disabled) in managed exclusion set
  const allDevicesForExclusion = cache.get<LnmsDevice[]>("allDevicesForExclusion") ?? devices;
  const managedIps = new Set<string>();
  for (const d of allDevicesForExclusion) {
    deviceIdToHostname.set(d.device_id, d.hostname);
    managedIps.add(d.ip);
    hostnameToLocation.set(d.hostname, d.location || "Unknown");
    const ips = allIps.get(d.hostname) ?? [];
    for (const ip of ips) {
      managedIps.add(ip.ipv4_address);
    }
  }
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

  const isOverlayIp = (ip: string) =>
    ip.startsWith("172.29.0.") ||   // ZeroTier
    ip.startsWith("10.127.0.") ||   // WireGuard
    ip.startsWith("100.81.") ||     // Tailscale
    ip.startsWith("100.64.") ||     // Tailscale CGNAT
    ip.startsWith("172.18.") ||     // Docker bridge
    ip.startsWith("172.19.") ||     // Docker bridge
    ip.startsWith("172.20.") ||     // Docker bridge
    ip.startsWith("172.21.") ||     // Docker bridge
    ip.startsWith("10.128.") ||     // VPN tunnel
    ip.startsWith("127.") ||        // loopback
    ip.startsWith("169.254.") ||    // link-local
    ip.startsWith("172.17.");       // Docker default bridge

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

  // Build managed MAC set from ARP entries matching managed IPs
  const managedMacs = new Set<string>();
  for (const entry of allArpEntries) {
    if (managedIps.has(entry.ipv4_address)) {
      managedMacs.add(normalizeMac(entry.mac_address));
    }
  }

  // Also fetch port MACs from disabled devices to exclude their interfaces
  for (const d of allDevicesForExclusion) {
    if (devices.some(active => active.device_id === d.device_id)) continue;
    try {
      const res = await librenmsGet<{ ports: Array<{ ifPhysAddress?: string }> }>(`/devices/${d.hostname}/ports`, { columns: "port_id,ifPhysAddress" });
      for (const p of (res.ports ?? [])) {
        const mac = normalizeMac(p.ifPhysAddress ?? "");
        if (mac && mac.length === 12 && mac !== "000000000000") managedMacs.add(mac);
      }
    } catch { /* skip */ }
    await delay(50);
  }

  // --- Consolidation: union-find to merge MACs sharing an IP and IPs sharing a MAC ---
  const arpDevices = consolidateArpDevices(allArpEntries, managedIps, managedMacs, deviceIdToHostname, hostnameToLocation, isOverlayIp, portIdToIfName);

  cache.set("arpLinks", arpLinks, TTL.PORTS);
  cache.set("arpDevices", arpDevices, TTL.PORTS);
  console.log(`[poller] Cached ${arpLinks.length} ARP links, ${arpDevices.length} discovered devices (consolidated) from ${allArpEntries.length} ARP entries`);
}

function consolidateArpDevices(
  allArpEntries: LnmsArpEntry[],
  managedIps: Set<string>,
  managedMacs: Set<string>,
  deviceIdToHostname: Map<number, string>,
  hostnameToLocation: Map<string, string>,
  isOverlayIp: (ip: string) => boolean,
  portIdToIfName: Map<number, string>,
): ArpDiscoveredDevice[] {
  // Phase 1: collect valid (mac, ip) pairs
  const pairs: Array<{ mac: string; ip: string; deviceId: number; portId: number }> = [];
  const seen = new Set<string>();

  for (const entry of allArpEntries) {
    const mac = normalizeMac(entry.mac_address);
    const ip = entry.ipv4_address;
    if (!mac || !ip || ip === "0.0.0.0") continue;
    if (mac === "000000000000" || mac === "FFFFFFFFFFFF") continue;
    if (isBogus(mac)) continue;
    if (managedIps.has(ip) || managedMacs.has(mac)) continue;
    if (isOverlayIp(ip)) continue;

    const pairKey = `${mac}:${ip}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    pairs.push({ mac, ip, deviceId: entry.device_id, portId: entry.port_id });
  }

  // Phase 2: union-find — merge entries that share a MAC or an IP
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

  // Initialize: each MAC and each IP is its own parent
  for (const p of pairs) {
    const mk = `mac:${p.mac}`;
    const ik = `ip:${p.ip}`;
    if (!parent.has(mk)) parent.set(mk, mk);
    if (!parent.has(ik)) parent.set(ik, ik);
    union(mk, ik);
  }

  // Phase 3: group pairs by component
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

  // Phase 4: build output — one entry per component
  const arpDevices: ArpDiscoveredDevice[] = [];
  for (const [, comp] of components) {
    const seenBy = deviceIdToHostname.get(comp.deviceId);
    if (!seenBy) continue;
    const location = hostnameToLocation.get(seenBy) ?? "Unknown";
    const siteId = location.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    // Pick the best MAC: prefer universally-administered, then best vendor match
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
      ips,
      vendor: lookupVendor(bestMac),
      location,
      siteId,
      seenByHostname: seenBy,
      seenByInterface: portIdToIfName.get(comp.portId),
    });
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

export async function pollAlerts() {
  const alerts = await fetchAlerts();
  cache.set("alerts", alerts, TTL.ALERTS);
}

export async function warmCache() {
  console.log("[poller] Warming cache...");
  await loadOuiDatabases();
  await pollDevicesAndLocations();
  await pollAlerts();
  await pollPortsAndIps();
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
  // Devices + locations: every 1 hour
  safeInterval(pollDevicesAndLocations, TTL.DEVICES);

  // Ports + overlays: every 5 min
  safeInterval(pollPortsAndIps, TTL.PORTS);

  // Alerts: every 2 min
  safeInterval(pollAlerts, TTL.ALERTS);
}
