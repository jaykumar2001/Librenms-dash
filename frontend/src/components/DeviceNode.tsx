import { useState, useCallback } from "react";
import type { MouseEvent } from "react";
import type { LayoutNode } from "@/hooks/useForceLayout";
import type { DeviceSummary } from "@librenms-dash/shared";
import { formatRateCompact } from "@/lib/format";

interface Props {
  node: LayoutNode;
  device?: DeviceSummary;
  interactive?: boolean;
  highlighted?: boolean;
  searchMatch?: boolean;
  onHover: (hostname: string | null) => void;
  onMouseDown?: (event: MouseEvent<SVGGElement>) => void;
  onClick?: (event: MouseEvent<SVGGElement>) => void;
}

const BOX_W = 140;
const BOX_H = 88;
const ICON_SIZE = 22;

const OVERLAY_COLORS: Record<string, string> = {
  zerotier: "#9333ea",
  wireguard: "#dc2626",
  tailscale: "#06b6d4",
};

const OVERLAY_LABELS: Record<string, string> = {
  zerotier: "ZT",
  wireguard: "WG",
  tailscale: "TS",
};

export function DeviceNode({ node, device, interactive = true, highlighted, searchMatch, onHover, onMouseDown, onClick }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const x = (node.x ?? 0) - BOX_W / 2;
  const y = (node.y ?? 0) - BOX_H / 2;

  const handleEnter = useCallback(() => {
    setIsHovered(true);
    onHover(node.hostname);
  }, [node.hostname, onHover]);

  const handleLeave = useCallback(() => {
    setIsHovered(false);
    onHover(null);
  }, [onHover]);

  const statusColor = node.status === 1 ? "#22c55e" : "#ef4444";
  const displayName = device?.displayName ?? node.hostname;
  const deviceIps = device?.ips?.length ? device.ips : [device?.lanIp ?? device?.ip ?? ""];
  const overlayPorts = (device?.overlayPorts ?? []).filter((p) => p.ip);
  const active = isHovered || highlighted || searchMatch;

  return (
    <g
      onMouseDown={onMouseDown}
      onClick={onClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ cursor: interactive ? "move" : "pointer" }}
    >
      {searchMatch && (
        <rect
          x={x - 6}
          y={y - 6}
          width={BOX_W + 12}
          height={BOX_H + 12}
          rx={9}
          fill="#facc15"
          fillOpacity={0.08}
          stroke="#facc15"
          strokeWidth={2}
          className="search-match-glow"
        />
      )}
      <rect
        x={x}
        y={y}
        width={BOX_W}
        height={BOX_H}
        rx={5}
        fill={searchMatch ? "#1e293b" : active ? "#1e293b" : "#0f172a"}
        fillOpacity={searchMatch ? 0.95 : isHovered ? 0.92 : highlighted ? 0.88 : 0.78}
        stroke={searchMatch ? "#facc15" : statusColor}
        strokeWidth={searchMatch ? 2.5 : active ? 2 : 1.5}
        strokeOpacity={active ? 1 : 0.65}
        className={searchMatch ? "search-match-box" : undefined}
      />

      {/* Icon */}
      <image
        href={`/api/graph/icon/${device?.icon ?? "generic.svg"}`}
        x={x + 6}
        y={y + 6}
        width={ICON_SIZE}
        height={ICON_SIZE}
      />

      {/* Device name */}
      <text
        x={x + 6 + ICON_SIZE + 5}
        y={y + 18}
        fill={searchMatch ? "#facc15" : "#f1f5f9"}
        fontSize={searchMatch ? 12 : 11}
        fontWeight={searchMatch ? 700 : 600}
        fontFamily="system-ui, sans-serif"
      >
        {displayName.length > 13 ? displayName.slice(0, 12) + "…" : displayName}
      </text>

      {/* Status dot */}
      <circle cx={x + BOX_W - 10} cy={y + 14} r={3.5} fill={statusColor} />

      {/* Device IPs */}
      {deviceIps.slice(0, 2).map((ip, i) => (
        <text
          key={ip}
          x={x + 6}
          y={y + 34 + i * 10}
          fill="#94a3b8"
          fontSize={ip.includes(":") ? 7 : 9}
          fontFamily="monospace"
        >
          {ip.length > 20 ? ip.slice(0, 19) + "…" : ip}
        </text>
      ))}
      {deviceIps.length > 2 && (
        <text x={x + BOX_W - 8} y={y + 42} fill="#64748b" fontSize={7} fontFamily="monospace" textAnchor="end">
          +{deviceIps.length - 2}
        </text>
      )}

      {/* Overlay IPs — one per overlay type, deduped */}
      {(() => {
        const ipRows = Math.min(deviceIps.length, 2);
        const overlayY = y + 34 + ipRows * 10 + 3;
        return overlayPorts.slice(0, 3).map((p, i) => {
          const color = OVERLAY_COLORS[p.overlayType] ?? "#6b7280";
          const label = OVERLAY_LABELS[p.overlayType] ?? p.overlayType.slice(0, 2).toUpperCase();
          return (
            <g key={p.overlayType}>
              <text x={x + 6} y={overlayY + i * 11} fill={color} fontSize={8} fontWeight={600} fontFamily="monospace">{label}</text>
              <text x={x + 24} y={overlayY + i * 11} fill={color} fillOpacity={0.8} fontSize={8} fontFamily="monospace">{p.ip}</text>
            </g>
          );
        });
      })()}

      {/* Total traffic at bottom */}
      {device && (device.totalInRate > 0 || device.totalOutRate > 0) && (
        <text
          x={x + BOX_W / 2}
          y={y + BOX_H - 4}
          textAnchor="middle"
          fill="#475569"
          fontSize={8}
          fontFamily="monospace"
        >
          ↓{formatRateCompact(device.totalInRate)} ↑{formatRateCompact(device.totalOutRate)}
        </text>
      )}
    </g>
  );
}
