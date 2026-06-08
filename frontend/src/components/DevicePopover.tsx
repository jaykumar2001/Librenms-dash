import { Component } from "react";
import type { ReactNode } from "react";
import type { HealthSensor, Port, Alert } from "@librenms-dash/shared";
import { useDeviceDetail } from "@/hooks/useDeviceDetail";
import { graphUrl } from "@/lib/api";
import { formatRate } from "@/lib/format";

interface Props {
  hostname: string;
  icon: string;
  screenX: number;
  screenY: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTimestamp(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts.replace(" ", "T"));
  if (isNaN(d.getTime())) return ts;
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return d.toLocaleString();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return d.toLocaleString();
}

class PopoverErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <div className="text-gray-400 py-4 text-center text-xs">Failed to load device details</div>;
    }
    return this.props.children;
  }
}

function DevicePopoverInner({ hostname, icon, screenX, screenY, onMouseEnter, onMouseLeave }: Props) {
  const { data, isLoading } = useDeviceDetail(hostname);

  // Clamp width to the viewport so the box never exceeds the screen on mobile.
  const width = Math.min(420, window.innerWidth - 16);
  const left = Math.max(8, Math.min(screenX + 20, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(screenY - 20, window.innerHeight - 520));

  return (
    <div
      className="fixed z-50 bg-gray-900 border border-gray-600 rounded-lg shadow-2xl p-4 text-sm text-gray-200 max-h-[500px] overflow-y-auto"
      style={{ left, top, width }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {isLoading ? (
        <div className="text-gray-400 py-4 text-center">Loading...</div>
      ) : !data ? (
        <div className="text-gray-400 py-4 text-center">No data</div>
      ) : (
        <>
          {/* Header with icon */}
          <div className="flex items-center gap-3 mb-3">
            <img
              src={`/api/graph/icon/${icon}`}
              alt=""
              className="w-8 h-8 shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${data.device.status === 1 ? "bg-green-500" : "bg-red-500"}`} />
                <span className="font-bold text-base truncate">{data.device.sysName || data.device.hostname}</span>
              </div>
              <span className="text-xs text-gray-400">{data.device.os} {data.device.hardware ? `— ${data.device.hardware}` : ""}</span>
            </div>
          </div>

          <table className="w-full mb-3 text-xs border-collapse rounded overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
            <tbody>
              {(() => {
                const deviceIps = data.device.ips?.length ? data.device.ips : [data.device.ip];
                const overlayLabels: Record<string, string> = { zerotier: "ZeroTier", wireguard: "WireGuard", tailscale: "Tailscale" };
                const overlayIps = data.device.overlayIps ?? [];
                const rows: [string, string, boolean?][] = [
                  ...deviceIps.map((ip: string, i: number) => [i === 0 ? "IP" : "", ip, true] as [string, string, boolean]),
                  ...overlayIps.map((o: { type: string; ip: string }, i: number) => [i === 0 ? "Overlay" : "", `${overlayLabels[o.type] ?? o.type}: ${o.ip}`, true] as [string, string, boolean]),
                  ["Operating System", data.device.sysDescr || `${data.device.os} ${data.device.version}` || "—"],
                  ["Hardware", data.device.hardware || "—"],
                  ["Serial", data.device.serial || "—"],
                  ["Contact", data.device.sysContact || "—"],
                  ["Uptime", formatUptime(data.device.uptime)],
                  ["Last Discovered", formatTimestamp(data.device.last_discovered)],
                  ["Last Polled", formatTimestamp(data.device.last_polled)],
                  ["Location", data.device.location],
                ];
                return rows.map(([label, value, mono], i) => (
                  <tr key={`${label}-${i}`} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                    <td className="py-1 px-2 text-gray-400 whitespace-nowrap align-top" style={{ width: "120px" }}>{label}</td>
                    <td className={`py-1 px-2 break-words ${mono || label === "Serial" ? "font-mono" : ""}`}>{value}</td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>

          {data.health.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-gray-400 mb-1 font-semibold">Health</div>
              <div className="space-y-0.5">
                {data.health.slice(0, 6).map((s: HealthSensor) => (
                  <div key={s.sensor_id} className="flex justify-between text-xs">
                    <span className="truncate mr-2">{s.sensor_descr}</span>
                    <span className="font-mono whitespace-nowrap">{s.sensor_current}{s.sensor_class === "processor" || s.sensor_class === "mempool" ? "%" : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-1 font-semibold">CPU (24h)</div>
            <img
              src={graphUrl(hostname, "device_processor", { width: 380, height: 100 })}
              alt="CPU"
              className="rounded w-full bg-gray-800"
              loading="eager"
            />
          </div>

          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-1 font-semibold">Memory (24h)</div>
            <img
              src={graphUrl(hostname, "device_mempool", { width: 380, height: 100 })}
              alt="Memory"
              className="rounded w-full bg-gray-800"
              loading="eager"
            />
          </div>

          {data.topPorts.length > 0 && (
            <div>
              <div className="text-xs text-gray-400 mb-1 font-semibold">Top Ports</div>
              <table className="w-full text-xs border-collapse rounded overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.06)" }}>
                    <th className="py-1 px-2 text-left text-gray-400 font-semibold">Port</th>
                    <th className="py-1 px-2 text-right text-gray-400 font-semibold">In</th>
                    <th className="py-1 px-2 text-right text-gray-400 font-semibold">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topPorts.map((p: Port, i: number) => (
                    <tr key={p.port_id} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                      <td className="py-1 px-2 truncate text-gray-300 max-w-[200px]">{p.ifName}{p.ifAlias && p.ifAlias !== p.ifName ? ` (${p.ifAlias})` : ""}</td>
                      <td className="py-1 px-2 text-right font-mono whitespace-nowrap text-green-400">↓{formatRate(p.ifInOctets_rate)}</td>
                      <td className="py-1 px-2 text-right font-mono whitespace-nowrap text-blue-400">↑{formatRate(p.ifOutOctets_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.alerts.length > 0 && (
            <div className="mt-3 p-2 bg-red-900/30 border border-red-800 rounded">
              <div className="text-xs text-red-400 font-semibold mb-1">Active Alerts</div>
              {data.alerts.map((a: Alert) => (
                <div key={a.id} className="text-xs text-red-300">{a.rule}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function DevicePopover(props: Props) {
  return (
    <PopoverErrorBoundary>
      <DevicePopoverInner {...props} />
    </PopoverErrorBoundary>
  );
}
