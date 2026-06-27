import { Hono } from "hono";
import { cache, TTL } from "../cache/store.js";
import { librenmsGet } from "../librenms/client.js";
import { findDeviceIps, getOverlayPortSummaries, engine } from "../librenms/overlays.js";
import type { DeviceOverview, DeviceInterface, DeviceRoute } from "@librenms-dash/shared";
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsAlert, LnmsHealthSensor } from "../librenms/types.js";

function formatMac(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g)!.join(":");
}

function deriveDisplayName(device: LnmsDevice): string {
  if (device.display) return device.display;
  const name = device.sysName || device.hostname;
  return name.replace(/\..*$/, "");
}

const app = new Hono();

app.get("/:hostname/overview", async (c) => {
  const hostname = c.req.param("hostname");

  const devices = cache.get<LnmsDevice[]>("devices") ?? [];
  const device = devices.find((d) => d.hostname === hostname);
  if (!device) {
    return c.json({ error: "Device not found" }, 404);
  }

  // Health sensors — fetch on demand, cache
  let health = cache.get<LnmsHealthSensor[]>(`health:${hostname}`);
  if (!health) {
    try {
      const res = await librenmsGet<{ data: LnmsHealthSensor[] }>(`/devices/${encodeURIComponent(hostname)}/health`);
      health = res.data ?? [];
      cache.set(`health:${hostname}`, health, TTL.HEALTH);
    } catch {
      health = [];
    }
  }

  const ports = cache.get<LnmsPort[]>(`ports:${hostname}`) ?? [];
  const topPorts = [...ports]
    .filter((p) => p.ifName !== "lo" && p.ifDescr !== "lo")
    .sort((a, b) => ((b.ifInOctets_rate ?? 0) + (b.ifOutOctets_rate ?? 0)) - ((a.ifInOctets_rate ?? 0) + (a.ifOutOctets_rate ?? 0)))
    .slice(0, 5);

  const allAlerts = cache.get<LnmsAlert[]>("alerts") ?? [];
  const deviceAlerts = allAlerts.filter((a) => a.device_id === device.device_id);

  const ips = cache.get<LnmsDeviceIp[]>(`ips:${hostname}`) ?? [];

  const ipsByPort = new Map<number, string[]>();
  for (const ip of ips) {
    const addrs: string[] = [];
    if (ip.ipv4_address) addrs.push(ip.ipv4_address);
    const v6 = ip.ipv6_compressed ?? ip.ipv6_address;
    if (v6) addrs.push(v6);
    if (addrs.length === 0) continue;
    const arr = ipsByPort.get(ip.port_id);
    if (arr) for (const a of addrs) arr.push(a);
    else ipsByPort.set(ip.port_id, addrs);
  }

  const dockerVethRe = /^br-[a-f0-9]{12}$|^docker0$|^veth[a-f0-9]+$/;
  const interfaces: DeviceInterface[] = ports
    .filter((p) => p.ifName !== "lo" && p.ifDescr !== "lo" && p.ifPhysAddress && !dockerVethRe.test(p.ifName || p.ifDescr))
    .map((p) => ({
      ifName: p.ifName || p.ifDescr,
      mac: formatMac(p.ifPhysAddress ?? ""),
      ifOperStatus: p.ifOperStatus,
      ips: ipsByPort.get(p.port_id) ?? [],
    }))
    .filter((iface) => iface.mac && iface.mac !== "00:00:00:00:00:00");

  const deviceIps = findDeviceIps(ips, ports);
  if (device.ip && !deviceIps.includes(device.ip) && !engine.isOverlayIp(device.ip)) deviceIps.push(device.ip);
  const arpLanIps = cache.get<Map<string, string>>("arpLanIps");
  const arpLanIp = arpLanIps?.get(hostname);
  if (arpLanIp && !deviceIps.includes(arpLanIp)) deviceIps.unshift(arpLanIp);
  const ndGlobalIpv6 = cache.get<Map<string, string[]>>("ndGlobalIpv6");
  for (const v6 of ndGlobalIpv6?.get(hostname) ?? []) {
    if (!deviceIps.includes(v6)) deviceIps.push(v6);
  }

  const overview: DeviceOverview = {
    device: {
      device_id: device.device_id,
      hostname: device.hostname,
      displayName: deriveDisplayName(device),
      ip: device.ip,
      ips: deviceIps,
      os: device.os,
      version: device.version,
      icon: device.icon,
      status: device.status,
      status_reason: device.status_reason,
      location: device.location,
      uptime: device.uptime,
      sysName: device.sysName,
      hardware: device.hardware,
      features: device.features,
      serial: device.serial,
      sysContact: device.sysContact,
      sysDescr: device.sysDescr,
      last_discovered: device.last_discovered,
      last_polled: device.last_polled,
      overlayIps: getOverlayPortSummaries(ports, ips)
        .filter((p) => p.ip)
        .map((p) => ({ type: p.overlayType, ip: p.ip })),
    },
    health: health.map((s) => ({
      sensor_id: s.sensor_id,
      sensor_class: s.sensor_class,
      sensor_descr: s.sensor_descr,
      sensor_current: s.sensor_current,
      sensor_limit: s.sensor_limit,
      sensor_limit_low: s.sensor_limit_low,
    })),
    topPorts: topPorts.map((p) => ({
      port_id: p.port_id,
      device_id: p.device_id,
      ifName: p.ifName,
      ifAlias: p.ifAlias,
      ifSpeed: p.ifSpeed,
      ifInOctets_rate: p.ifInOctets_rate,
      ifOutOctets_rate: p.ifOutOctets_rate,
      ifOperStatus: p.ifOperStatus,
      ifAdminStatus: p.ifAdminStatus,
      ifType: p.ifType,
    })),
    routes: (() => {
      const routes = cache.get<DeviceRoute[]>(`routes:${hostname}`) ?? [];
      if (routes.length === 0) return [];
      const overlayIps = new Set<string>();
      const samesite = new Map<string, string>();
      const overlay = new Map<string, string>();
      for (const d of devices) {
        const name = deriveDisplayName(d);
        const sameLoc = d.location === device.location;
        const dPorts = cache.get<LnmsPort[]>(`ports:${d.hostname}`) ?? [];
        const overlayPortIds = new Set(dPorts.filter((p) => engine.classifyPort(p)).map((p) => p.port_id));
        const dIps = cache.get<LnmsDeviceIp[]>(`ips:${d.hostname}`) ?? [];
        for (const ip of dIps) {
          if (overlayPortIds.has(ip.port_id) || engine.isOverlayIp(ip.ipv4_address)) {
            overlayIps.add(ip.ipv4_address);
            overlay.set(ip.ipv4_address, name);
          } else if (sameLoc) {
            samesite.set(ip.ipv4_address, name);
          }
        }
        if (engine.isOverlayIp(d.ip)) { overlayIps.add(d.ip); overlay.set(d.ip, name); }
        else if (sameLoc) samesite.set(d.ip, name);
      }
      const arpLanIpMap = cache.get<Map<string, string>>("arpLanIps");
      if (arpLanIpMap) {
        for (const d of devices) {
          if (d.location !== device.location) continue;
          const arpIp = arpLanIpMap.get(d.hostname);
          if (arpIp && !overlay.has(arpIp) && !samesite.has(arpIp)) {
            samesite.set(arpIp, deriveDisplayName(d));
          }
        }
      }
      return routes.map((r) => ({
        ...r,
        nextHopDevice: overlayIps.has(r.nextHop) ? overlay.get(r.nextHop) : samesite.get(r.nextHop),
      }));
    })(),
    alerts: deviceAlerts.map((a) => ({
      id: a.id,
      device_id: a.device_id,
      hostname: a.hostname,
      rule: typeof a.rule === "string" ? a.rule : a.rule?.name ?? "",
      severity: a.severity,
      state: a.state,
      timestamp: a.timestamp,
    })),
    interfaces,
  };

  return c.json(overview);
});

export default app;
