import type { MouseEvent } from "react";
import type { SiteCluster, DeviceGroup } from "@/hooks/useForceLayout";

const SITE_COLORS: string[] = [
  "#3b82f6", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#06b6d4",
];

export interface SiteStats {
  lldp: number;
  arp: number;
  discovered: number;
  routes: number;
}

interface SiteProps {
  site: SiteCluster;
  index: number;
  interactive?: boolean;
  stats?: SiteStats;
  onMouseDown?: (event: MouseEvent<SVGGElement>) => void;
  onResizeMouseDown?: (event: MouseEvent<SVGGElement>) => void;
}

const LLDP_COLOR = "#38bdf8";
const ARP_COLOR = "#fbbf24";
const DISCOVERED_COLOR = "#a3e635";
const ROUTES_COLOR = "#34d399";

export function SiteGroup({ site, index, interactive = true, stats, onMouseDown, onResizeMouseDown }: SiteProps) {
  const color = SITE_COLORS[index % SITE_COLORS.length];

  return (
    <g onMouseDown={onMouseDown} style={{ cursor: interactive ? "move" : "grab" }}>
      <rect
        x={site.x}
        y={site.y}
        width={site.width}
        height={site.height}
        rx={8}
        fill={color}
        fillOpacity={0.1}
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.7}
        pointerEvents="all"
      />
      <text
        x={site.x + 10}
        y={site.y + 15}
        fontFamily="system-ui, sans-serif"
      >
        <tspan fill={color} fillOpacity={0.9} fontSize={12} fontWeight={700}>{site.location}</tspan>
        {stats && (
          <>
            <tspan fill={ROUTES_COLOR} dx={10} fontSize={8.5} fontWeight={600}>Routes {stats.routes}</tspan>
            <tspan fill={LLDP_COLOR} dx={8} fontSize={8.5} fontWeight={600}>LLDP/CDP {stats.lldp}</tspan>
            <tspan fill={ARP_COLOR} dx={8} fontSize={8.5} fontWeight={600}>ARP {stats.arp}</tspan>
            <tspan fill={DISCOVERED_COLOR} dx={8} fontSize={8.5} fontWeight={600}>Discovered {stats.discovered}</tspan>
          </>
        )}
      </text>
      {interactive && (
        <g
          onMouseDown={onResizeMouseDown}
          style={{ cursor: "nwse-resize" }}
        >
          <rect
            x={site.x + site.width - 16}
            y={site.y + site.height - 16}
            width={12}
            height={12}
            rx={3}
            fill="#020617"
            fillOpacity={0.75}
            stroke={color}
            strokeOpacity={0.85}
          />
          <path
            d={`M ${site.x + site.width - 13} ${site.y + site.height - 6} L ${site.x + site.width - 6} ${site.y + site.height - 13}`}
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeOpacity={0.85}
          />
          <title>Resize site</title>
        </g>
      )}
    </g>
  );
}

interface SiteControlsProps {
  site: SiteCluster;
  index: number;
  onToggleOrientation?: (event: MouseEvent<SVGGElement>) => void;
}

export function SiteControls({ site, index, onToggleOrientation }: SiteControlsProps) {
  const color = SITE_COLORS[index % SITE_COLORS.length];
  const orientationLabel = site.orientation === "portrait" ? "L" : "P";

  return (
    <g
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onToggleOrientation}
      style={{ cursor: "pointer" }}
    >
      <rect
        x={site.x + site.width - 30}
        y={site.y + 5}
        width={22}
        height={14}
        rx={4}
        fill="#020617"
        fillOpacity={0.7}
        stroke={color}
        strokeOpacity={0.75}
      />
      <text
        x={site.x + site.width - 19}
        y={site.y + 15}
        textAnchor="middle"
        fill={color}
        fontSize={9}
        fontWeight={700}
        fontFamily="system-ui, sans-serif"
      >
        {orientationLabel}
      </text>
      <title>{site.orientation === "portrait" ? "Switch to landscape" : "Switch to portrait"}</title>
    </g>
  );
}

const OS_LABELS: Record<string, string> = {
  linux: "Linux",
  openwrt: "OpenWrt",
  proxmox: "Proxmox",
  opnsense: "OPNsense",
  dsm: "Synology",
  ciscosb: "Cisco",
  "linksys-ss": "Linksys",
  brother: "Brother",
  econet: "Econet",
  tplink: "TP-Link",
  generic: "Generic",
};

interface DeviceGroupProps {
  group: DeviceGroup;
}

export function DeviceGroupBorder({ group }: DeviceGroupProps) {
  const label = OS_LABELS[group.os] ?? group.os;

  return (
    <g>
      <rect
        x={group.x}
        y={group.y}
        width={group.width}
        height={group.height}
        rx={5}
        fill="#1e293b"
        fillOpacity={0.2}
        stroke="#334155"
        strokeWidth={1}
        strokeDasharray="4 3"
        strokeOpacity={0.6}
      />
      <text
        x={group.x + 6}
        y={group.y + 11}
        fill="#64748b"
        fontSize={9}
        fontWeight={500}
        fontFamily="system-ui, sans-serif"
      >
        {label}
      </text>
    </g>
  );
}
