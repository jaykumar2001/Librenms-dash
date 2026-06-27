import { Hono } from "hono";
import { cache } from "../cache/store.js";
import type { TopologyResponse, Site, DeviceSummary, SubnetGroup, NeighborLink, ArpLink, ArpDiscoveredDevice, DeviceRoute } from "@librenms-dash/shared";
import type { LnmsDevice, LnmsPort, LnmsLocation, LnmsAlert, LnmsDeviceIp, LnmsLink } from "../librenms/types.js";
import { getOverlayPortSummaries, findLanIp, findDeviceIps, isExcludedIface, engine } from "../librenms/overlays.js";
import { normalizeMac } from "../librenms/oui.js";

const commitSha: string | undefined = process.env.COMMIT_SHA || undefined;

const app = new Hono();

function deriveDisplayName(device: LnmsDevice): string {
  if (device.display) return device.display;
  const name = device.sysName || device.hostname;
  return name.replace(/\.local\.lan$/, "").replace(/\.local\.zt$/, "").replace(/\.[a-z]+\.[a-z]+$/, "");
}

app.get("/", (c) => {
  const devices = cache.get<LnmsDevice[]>("devices") ?? [];
  const locations = cache.get<LnmsLocation[]>("locations") ?? [];
  const overlays = cache.get<SubnetGroup[]>("overlays") ?? [];
  const alerts = cache.get<LnmsAlert[]>("alerts") ?? [];
  const lnmsLinks = cache.get<LnmsLink[]>("links") ?? [];

  const locationMap = new Map<string, LnmsLocation>();
  for (const loc of locations) {
    locationMap.set(loc.location, loc);
  }

  const arpLanIps = cache.get<Map<string, string>>("arpLanIps") ?? new Map<string, string>();

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

    // All addresses for search — includes link-local, ULA, and loopback IPv6
    const allIpsSet = new Set<string>(deviceIps);
    for (const entry of ips) {
      if (entry.ipv4_address) allIpsSet.add(entry.ipv4_address);
      const v6 = entry.ipv6_compressed ?? entry.ipv6_address;
      if (v6) allIpsSet.add(v6);
    }
    if (device.ip) allIpsSet.add(device.ip);

    // ND-scraped global IPv6 for this device (not available via REST API)
    const ndGlobalIpv6 = cache.get<Map<string, string[]>>("ndGlobalIpv6");
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

  // Build neighbor links from LLDP/CDP data
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

  const response: TopologyResponse = {
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

  return c.json(response);
});

export default app;
