import { Copyable } from "./Copyable";
import { formatTimestamp } from "./DevicePopover";

export interface LinkTooltipData {
  type: "lldp" | "arp" | "overlay" | "arp-device";
  screenX: number;
  screenY: number;
  sourceHostname: string;
  targetHostname: string;
  sourceDisplayName: string;
  targetDisplayName: string;
  color: string;
  // LLDP/CDP
  localPort?: string;
  remotePort?: string;
  protocol?: string;
  // ARP
  sourceIp?: string;
  targetIp?: string;
  targetIps?: string[];
  mac?: string;
  targetMac?: string;
  // Overlay
  overlayType?: string;
  // Per-endpoint interface (LLDP ports, overlay/ARP interfaces)
  sourceInterface?: string;
  targetInterface?: string;
  // ARP discovered device
  interface?: string;
  vendor?: string;
  sourceMac?: string;
  stale?: boolean;
  lastSeen?: string;
  sourceDown?: boolean;
}

const OVERLAY_LABELS: Record<string, string> = {
  zerotier: "ZeroTier",
  wireguard: "WireGuard",
  tailscale: "Tailscale",
};

interface Props {
  data: LinkTooltipData;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function LinkTooltip({ data, onMouseEnter, onMouseLeave }: Props) {
  const left = Math.min(data.screenX + 16, window.innerWidth - 320);
  const top = Math.max(8, Math.min(data.screenY - 12, window.innerHeight - 200));

  return (
    <div
      className="fixed z-50 bg-gray-900 border rounded-lg shadow-2xl px-3 py-2.5 text-xs text-gray-200 min-w-[220px] max-w-[300px]"
      style={{ left, top, borderColor: data.color }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: data.color }}
        />
        <span className="font-bold text-sm" style={{ color: data.color }}>
          {data.type === "lldp" ? (data.protocol?.toUpperCase() ?? "LLDP/CDP") : null}
          {data.type === "arp" ? "ARP" : null}
          {data.type === "arp-device" ? "ARP Discovered" : null}
          {data.type === "overlay" ? (OVERLAY_LABELS[data.overlayType ?? ""] ?? data.overlayType) : null}
        </span>
      </div>

      {data.type === "arp-device" ? (
        <table className="w-full border-collapse text-xs">
          <tbody>
            <SectionLabel label="Seen by" />
            <Row label="Device" value={data.sourceDisplayName} />
            {data.interface && <Row label="Interface" value={data.interface} mono />}
            {data.sourceIp && <Row label="IP" value={data.sourceIp} mono copyable />}
            {data.sourceMac && <Row label="MAC" value={data.sourceMac} mono copyable />}
            {data.sourceDown && <Row label="Source" value="Device down — cached ARP" />}
            <SectionLabel label="Discovered device" />
            <Row label="Vendor" value={data.vendor || data.targetDisplayName || "Unknown"} />
            {data.targetIps && data.targetIps.length > 0 ? (
              <tr>
                <td className="py-0.5 pr-2 text-gray-500 whitespace-nowrap align-top">IP</td>
                <td className="py-0.5 font-mono">
                  {data.targetIps.map((ip) => (
                    <div key={ip} className="truncate max-w-[170px]" title={ip}>
                      <Copyable text={ip}>{ip}</Copyable>
                    </div>
                  ))}
                </td>
              </tr>
            ) : (
              <Row label="IP" value={data.targetIp ?? "—"} mono copyable />
            )}
            <Row label="MAC" value={data.mac ?? "—"} mono copyable />
            {data.stale && data.lastSeen && <Row label="Last seen" value={formatTimestamp(data.lastSeen)} />}
          </tbody>
        </table>
      ) : data.type === "arp" ? (
        <table className="w-full border-collapse text-xs">
          <tbody>
            <SectionLabel label="Device" />
            <Row label="Name" value={data.sourceDisplayName} />
            {data.sourceInterface && <Row label="Interface" value={data.sourceInterface} mono />}
            {data.sourceIp && <Row label="IP" value={data.sourceIp} mono copyable />}
            {data.mac && <Row label="MAC" value={data.mac} mono copyable />}
            <SectionLabel label="Seen by" />
            <Row label="Device" value={data.targetDisplayName} />
            {data.targetInterface && <Row label="Interface" value={data.targetInterface} mono />}
            {data.targetIp && <Row label="IP" value={data.targetIp} mono copyable />}
            {data.targetMac && <Row label="MAC" value={data.targetMac} mono copyable />}
            {data.sourceDown && <Row label="Source" value="Device down — cached ARP" />}
          </tbody>
        </table>
      ) : (
        <table className="w-full border-collapse text-xs">
          <tbody>
            <DeviceSection
              role="Source"
              device={data.sourceDisplayName}
              iface={data.sourceInterface}
              ip={data.sourceIp}
              ipLabel={data.type === "overlay" ? "Overlay IP" : "IP"}
            />
            <DeviceSection
              role="Destination"
              device={data.targetDisplayName}
              iface={data.targetInterface}
              ip={data.targetIp}
              ipLabel={data.type === "overlay" ? "Overlay IP" : "IP"}
            />
          </tbody>
        </table>
      )}
    </div>
  );
}

function DeviceSection({ role, device, iface, ip, ipLabel = "IP", mac }: {
  role: string;
  device: string;
  iface?: string;
  ip?: string;
  ipLabel?: string;
  mac?: string;
}) {
  return (
    <>
      <SectionLabel label={role} />
      <Row label="Device" value={device} />
      {iface && <Row label="Interface" value={iface} mono />}
      {ip && <Row label={ipLabel} value={ip} mono copyable />}
      {mac && <Row label="MAC" value={mac} mono copyable />}
    </>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <tr>
      <td colSpan={2} className="pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
        {label}
      </td>
    </tr>
  );
}

function Row({ label, value, mono, copyable }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  return (
    <tr>
      <td className="py-0.5 pr-2 text-gray-500 whitespace-nowrap align-top">{label}</td>
      <td className={`py-0.5 text-gray-200 break-all ${mono ? "font-mono" : ""}`}>
        {copyable && value && value !== "—" ? <Copyable text={value}>{value}</Copyable> : value}
      </td>
    </tr>
  );
}
