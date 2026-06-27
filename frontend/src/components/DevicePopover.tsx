import { Component } from "react";
import type { ReactNode } from "react";
import type { HealthSensor, Port, Alert, DeviceRoute, DeviceInterface } from "@librenms-dash/shared";
import { useDeviceDetail } from "@/hooks/useDeviceDetail";
import { graphUrl } from "@/lib/api";
import { formatRate } from "@/lib/format";
import { Copyable } from "./Copyable";

interface Props {
  hostname: string;
  icon: string;
  screenX: number;
  screenY: number;
  // When true, render anchored to the bottom of the screen (mobile bottom sheet)
  // instead of floating next to the cursor, so it never covers the canvas above.
  bottomSheet?: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClose?: () => void;
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

function DevicePopoverInner({ hostname, icon, screenX, screenY, bottomSheet, onMouseEnter, onMouseLeave, onClose }: Props) {
  const { data, isLoading } = useDeviceDetail(hostname);

  // Clamp width to the viewport so the box never exceeds the screen on mobile.
  const width = Math.min(420, window.innerWidth - 16);
  const left = Math.max(8, Math.min(screenX + 20, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(screenY - 20, window.innerHeight - 520));

  return (
    <div
      className={
        bottomSheet
          ? "fixed z-50 inset-x-0 bottom-0 bg-gray-900 border-t border-gray-600 rounded-t-xl shadow-2xl p-4 pt-3 text-sm text-gray-200 max-h-[55vh] overflow-y-auto"
          : "fixed z-50 bg-gray-900 border border-gray-600 rounded-lg shadow-2xl p-4 text-sm text-gray-200 max-h-[500px] overflow-y-auto"
      }
      style={bottomSheet ? undefined : { left, top, width }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 text-gray-400 hover:text-white text-xl leading-none"
        >
          ×
        </button>
      )}
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
                <span className="font-bold text-base truncate">{data.device.displayName}</span>
              </div>
              <span className="text-xs text-gray-400">{data.device.os} {data.device.hardware ? `— ${data.device.hardware}` : ""}</span>
            </div>
          </div>

          <table className="w-full mb-3 text-xs border-collapse rounded overflow-hidden table-fixed" style={{ background: "rgba(255,255,255,0.05)" }}>
            <colgroup>
              <col style={{ width: "76px" }} />
              <col />
            </colgroup>
            <tbody>
              {(() => {
                const deviceIps = data.device.ips?.length ? data.device.ips : [data.device.ip];
                const overlayLabels: Record<string, string> = { zerotier: "ZeroTier", wireguard: "WireGuard", tailscale: "Tailscale" };
                const overlayIps = data.device.overlayIps ?? [];
                const ipRows: [string, string, string][] = [
                  ...deviceIps.map((ip: string, i: number) => [i === 0 ? "IP" : "", ip, ip] as [string, string, string]),
                  ...overlayIps.map((o: { type: string; ip: string }, i: number) => [i === 0 ? "Overlay" : "", `${overlayLabels[o.type] ?? o.type}: ${o.ip}`, o.ip] as [string, string, string]),
                ];
                const textRows: [string, string, boolean?][] = [
                  ["OS", data.device.sysDescr || `${data.device.os} ${data.device.version}` || "—"],
                  ["Hardware", data.device.hardware || "—"],
                  ["Serial", data.device.serial || "—", true],
                  ["Contact", data.device.sysContact || "—"],
                  ["Uptime", formatUptime(data.device.uptime)],
                  ["Last Disc", formatTimestamp(data.device.last_discovered)],
                  ["Last Polled", formatTimestamp(data.device.last_polled)],
                  ["Location", data.device.location],
                ];
                let rowIdx = 0;
                return (
                  <>
                    {ipRows.map(([label, display, copyVal], i) => (
                      <tr key={`ip-${i}`} style={{ background: rowIdx++ % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                        <td className="py-1 px-2 text-gray-400 whitespace-nowrap align-top">{label}</td>
                        <td className="py-1 px-2 font-mono">
                          <Copyable text={copyVal} block>{display}</Copyable>
                        </td>
                      </tr>
                    ))}
                    {textRows.map(([label, value, mono], i) => (
                      <tr key={`txt-${i}`} style={{ background: rowIdx++ % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                        <td className="py-1 px-2 text-gray-400 whitespace-nowrap align-top">{label}</td>
                        <td className={`py-1 px-2 truncate ${mono ? "font-mono" : ""}`}>{value}</td>
                      </tr>
                    ))}
                  </>
                );
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
              <table className="w-full text-xs border-collapse rounded overflow-hidden table-fixed" style={{ background: "rgba(255,255,255,0.05)" }}>
                <colgroup>
                  <col className="w-[50%]" />
                  <col className="w-[25%]" />
                  <col className="w-[25%]" />
                </colgroup>
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
                      <td className="py-1 px-2 truncate text-gray-300">{p.ifName}{p.ifAlias && p.ifAlias !== p.ifName ? ` (${p.ifAlias})` : ""}</td>
                      <td className="py-1 px-2 text-right font-mono whitespace-nowrap text-green-400">↓{formatRate(p.ifInOctets_rate)}</td>
                      <td className="py-1 px-2 text-right font-mono whitespace-nowrap text-blue-400">↑{formatRate(p.ifOutOctets_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.routes.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-gray-400 mb-1 font-semibold">Routes</div>
              <table className="w-full text-xs border-collapse rounded overflow-hidden table-fixed" style={{ background: "rgba(255,255,255,0.05)" }}>
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[40%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.06)" }}>
                    <th className="py-1 px-1.5 text-left text-gray-400 font-semibold">Dst/Mask</th>
                    <th className="py-1 px-1.5 text-left text-gray-400 font-semibold">Next Hop</th>
                    <th className="py-1 px-1.5 text-left text-gray-400 font-semibold">Iface</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.map((r: DeviceRoute, i: number) => (
                    <tr key={`${r.dest}-${r.prefix}-${r.nextHop}`} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                      <td className="py-0.5 px-1.5 font-mono text-gray-300">
                        <Copyable text={`${r.dest}/${r.prefix}`} block>{r.dest}/{r.prefix}</Copyable>
                      </td>
                      <td className="py-0.5 px-1.5 font-mono">
                        <Copyable text={r.nextHop} className="text-gray-300" block>{r.nextHop}</Copyable>
                        {r.nextHopDevice && (
                          <div className="text-[10px] text-cyan-400 leading-tight truncate">{r.nextHopDevice}</div>
                        )}
                      </td>
                      <td className="py-0.5 px-1.5 text-gray-400 truncate">{r.iface}</td>
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

          {data.interfaces.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-gray-400 mb-1 font-semibold">Interfaces</div>
              <table className="w-full text-xs border-collapse rounded overflow-hidden table-fixed" style={{ background: "rgba(255,255,255,0.05)" }}>
                <colgroup>
                  <col className="w-[25%]" />
                  <col className="w-[40%]" />
                  <col className="w-[35%]" />
                </colgroup>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.06)" }}>
                    <th className="py-1 px-2 text-left text-gray-400 font-semibold">Name</th>
                    <th className="py-1 px-2 text-left text-gray-400 font-semibold">MAC</th>
                    <th className="py-1 px-2 text-left text-gray-400 font-semibold">IPs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.interfaces.map((iface: DeviceInterface, i: number) => (
                    <tr key={iface.ifName} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                      <td className="py-0.5 px-2 text-gray-300 truncate">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${iface.ifOperStatus === "up" ? "bg-green-500" : "bg-red-500"}`} />
                        {iface.ifName}
                      </td>
                      <td className="py-0.5 px-2 font-mono text-gray-400">
                        <Copyable text={iface.mac} block>{iface.mac}</Copyable>
                      </td>
                      <td className="py-0.5 px-2 font-mono text-gray-300 overflow-hidden">
                        {(() => {
                          const displayIps = iface.ips.filter((ip) => {
                            if (!ip.includes(":")) return true; // IPv4 always shown
                            const l = ip.toLowerCase();
                            return !l.startsWith("fe80:") && !l.startsWith("fc") && !l.startsWith("fd") && l !== "::1";
                          });
                          return displayIps.length > 0
                            ? displayIps.map((ip) => (
                                <div key={ip} className="leading-tight">
                                  <Copyable text={ip} block>{ip}</Copyable>
                                </div>
                              ))
                            : "—";
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
