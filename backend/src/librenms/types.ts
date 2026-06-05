export interface LnmsDevice {
  device_id: number;
  hostname: string;
  ip: string;
  os: string;
  version: string;
  icon: string;
  status: number;
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
  disabled: number; // 1=polling disabled
  ignore: number;
}

export interface LnmsPort {
  port_id: number;
  device_id: number;
  ifName: string;
  ifDescr: string;
  ifAlias: string;
  ifSpeed: number;
  ifInOctets_rate: number;
  ifOutOctets_rate: number;
  ifOperStatus: string;
  ifAdminStatus: string;
  ifType: string;
}

export interface LnmsDeviceIp {
  ipv4_address: string;
  ipv4_prefixlen: number;
  port_id: number;
  context_name: string;
  ipv4_network_id: string;
}

export interface LnmsLocation {
  id: number;
  location: string;
  lat: number | null;
  lng: number | null;
}

export interface LnmsAlert {
  id: number;
  device_id: number;
  hostname: string;
  rule: string | { name: string };
  severity: string;
  state: number;
  timestamp: string;
}

export interface LnmsHealthSensor {
  sensor_id: number;
  sensor_class: string;
  sensor_descr: string;
  sensor_current: number;
  sensor_limit: number | null;
  sensor_limit_low: number | null;
  device_id: number;
}

export interface LnmsLink {
  id: number;
  local_port_id: number;
  local_device_id: number;
  remote_port_id: number;
  remote_device_id: number;
  active: number;
  protocol: string;
  remote_hostname: string;
  remote_port: string;
  remote_platform: string | null;
  remote_version: string | null;
}

export interface LnmsArpEntry {
  id: number;
  port_id: number;
  device_id: number;
  mac_address: string;
  ipv4_address: string;
  context_name: string;
}

export interface LnmsListResponse<T> {
  count: number;
  [key: string]: T[] | number | string;
}
