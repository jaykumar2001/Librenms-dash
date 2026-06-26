import type { TopologyResponse, DeviceOverview } from "@librenms-dash/shared";

const BASE = "/api";

export class ServerWarmingError extends Error {
  constructor() {
    super("Server is starting up");
    this.name = "ServerWarmingError";
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (res.status === 401) throw new Error("Unauthorized");
  if (res.status === 503) throw new ServerWarmingError();
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export function fetchTopology(): Promise<TopologyResponse> {
  return get("/topology");
}

export function fetchDeviceOverview(hostname: string): Promise<DeviceOverview> {
  return get(`/devices/${hostname}/overview`);
}

export function graphUrl(hostname: string, type: string, opts?: { from?: string; width?: number; height?: number }): string {
  const params = new URLSearchParams({
    from: opts?.from ?? "-1d",
    width: String(opts?.width ?? 400),
    height: String(opts?.height ?? 150),
  });
  return `${BASE}/graph/device/${hostname}/${type}?${params}`;
}

export function iconUrl(icon: string): string {
  return `${BASE}/graph/icon/${icon || "generic.svg"}`;
}
