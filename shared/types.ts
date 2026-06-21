export interface Device {
  device_id: number;
  hostname: string;
  displayName: string;
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
  overlayIps?: Array<{ type: string; ip: string }>;
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
  overlayType?: string;
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
  macs: string[];
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
  routes?: DeviceRoute[];
}

export interface DeviceRoute {
  dest: string;
  prefix: number;
  nextHop: string;
  nextHopDevice?: string;
  iface: string;
  protocol: string;
  type: string;
}

export interface OverlayPortSummary {
  ifName: string;
  overlayType: string;
  ip: string;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
}

export interface OverlayLink {
  overlayType: string;
  subnet: string;
  from: string;
  to: string;
  fromIp: string;
  toIp: string;
  fromIface?: string;
  toIface?: string;
}

export interface SubnetGroup {
  overlayType: string;
  subnet: string;
  color: string;
  label: string;
  topology: "mesh" | "hub-spoke";
  hub?: string;
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
  fromInterface?: string;
  fromMac?: string;
  toInterface?: string;
  toMac?: string;
}

export interface ArpDiscoveredDevice {
  mac: string;
  macs: string[];
  ips: string[];
  vendor: string;
  location: string;
  siteId: string;
  seenByHostname: string;
  seenByInterface?: string;
  seenByIp?: string;
  seenByMac?: string;
}

export interface TopologyResponse {
  sites: Site[];
  overlays: SubnetGroup[];
  neighbors: NeighborLink[];
  arpLinks: ArpLink[];
  arpDevices: ArpDiscoveredDevice[];
  alerts: Alert[];
  lastUpdated: string;
  commitSha?: string;
}

export interface DeviceInterface {
  ifName: string;
  mac: string;
  ifOperStatus: string;
  ips: string[];
}

export interface DeviceOverview {
  device: Device;
  health: HealthSensor[];
  topPorts: Port[];
  alerts: Alert[];
  routes: DeviceRoute[];
  interfaces: DeviceInterface[];
}

export interface AssetEvent {
  id: number;
  timestamp: string;
  action: "added" | "removed";
  category: string;
  asset: string;
}
