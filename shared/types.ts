export interface Device {
  device_id: number;
  hostname: string;
  ip: string;
  ips: string[];
  os: string;
  version: string;
  icon: string;
  status: number; // 1=up, 0=down
  status_reason: string;
  location: string;
  uptime: number;
  sysName: string;
  hardware: string;
  features: string;
  serial: string;
  sysContact: string;
  sysDescr: string;
  last_discovered: string;
  last_polled: string;
}

export interface Port {
  port_id: number;
  device_id: number;
  ifName: string;
  ifAlias: string;
  ifSpeed: number;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
  ifAdminStatus: string;
  ifType: string;
  overlayType?: OverlayType;
}

export interface HealthSensor {
  sensor_id: number;
  sensor_class: string; // "processor", "mempool", "temperature", "voltage"
  sensor_descr: string;
  sensor_current: number;
  sensor_limit: number | null;
  sensor_limit_low: number | null;
}

export interface Alert {
  id: number;
  device_id: number;
  hostname: string;
  rule: string;
  severity: string;
  state: number;
  timestamp: string;
}

export interface Site {
  id: string;
  location: string;
  lat: number | null;
  lng: number | null;
  devices: DeviceSummary[];
}

export interface DeviceSummary {
  device_id: number;
  hostname: string;
  displayName: string;
  ip: string;
  lanIp: string;
  ips: string[];
  os: string;
  icon: string;
  status: number;
  uptime: number;
  location: string;
  hardware: string;
  sysName: string;
  totalInRate: number;
  totalOutRate: number;
  portCount: number;
  overlayPorts: OverlayPortSummary[];
}

export interface OverlayPortSummary {
  ifName: string;
  overlayType: OverlayType;
  ip: string;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}

export type OverlayType = "zerotier" | "wireguard" | "tailscale";

export interface OverlayLink {
  type: OverlayType;
  from: string;
  to: string;
  fromIp: string;
  toIp: string;
  fromIface?: string;
  toIface?: string;
}

export interface OverlayGroup {
  type: OverlayType;
  subnet: string;
  color: string;
  links: OverlayLink[];
}

export interface NeighborLink {
  id: number;
  localDeviceId: number;
  localHostname: string;
  localPort: string;
  remoteDeviceId: number;
  remoteHostname: string;
  remotePort: string;
  protocol: string;
}

export interface ArpLink {
  fromHostname: string;
  toHostname: string;
  fromIp: string;
  toIp: string;
  mac: string;
  toInterface?: string;
}

export interface ArpDiscoveredDevice {
  mac: string;
  ips: string[];
  vendor: string;
  location: string;
  siteId: string;
  seenByHostname: string;
  seenByInterface?: string;
}

export interface TopologyResponse {
  sites: Site[];
  overlays: OverlayGroup[];
  neighbors: NeighborLink[];
  arpLinks: ArpLink[];
  arpDevices: ArpDiscoveredDevice[];
  alerts: Alert[];
  lastUpdated: string;
}

export interface DeviceOverview {
  device: Device;
  health: HealthSensor[];
  topPorts: Port[];
  alerts: Alert[];
}
