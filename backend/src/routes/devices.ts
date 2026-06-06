import { Hono } from "hono";
import { cache, TTL } from "../cache/store.js";
import { librenmsGet } from "../librenms/client.js";
import { findDeviceIps, getOverlayPortSummaries } from "../librenms/overlays.js";
import type { DeviceOverview } from "@librenms-dash/shared";
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsAlert, LnmsHealthSensor } from "../librenms/types.js";

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

  const overview: DeviceOverview = {
    device: {
      device_id: device.device_id,
      hostname: device.hostname,
      ip: device.ip,
      ips: findDeviceIps(ips, ports),
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
    alerts: deviceAlerts.map((a) => ({
      id: a.id,
      device_id: a.device_id,
      hostname: a.hostname,
      rule: typeof a.rule === "string" ? a.rule : a.rule?.name ?? "",
      severity: a.severity,
      state: a.state,
      timestamp: a.timestamp,
    })),
  };

  return c.json(overview);
});

export default app;
