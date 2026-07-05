import { useState, useCallback } from "react";
import type { ArpDeviceLayoutNode } from "@/hooks/useForceLayout";

interface Props {
  node: ArpDeviceLayoutNode;
  highlighted?: boolean;
  searchMatch?: boolean;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: () => void;
  onClick?: (e: React.MouseEvent) => void;
}

const BOX_W = 132;
const BOX_H = 42;

export function ArpDeviceNode({ node, highlighted, searchMatch, onMouseEnter, onMouseLeave, onClick }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const x = node.x - BOX_W / 2;
  const y = node.y - BOX_H / 2;

  const vendorShort = node.vendor.length > 18 ? node.vendor.slice(0, 17) + "…" : node.vendor;
  const macFormatted = formatMac(node.mac);
  const ip0 = node.ips[0] ?? "";
  const ipTrunc = ip0.length > 20 ? ip0.slice(0, 19) + "…" : ip0;
  const ipDisplay = node.ips.length > 1 ? `${ipTrunc} +${node.ips.length - 1}` : ipTrunc;
  const active = isHovered || highlighted || searchMatch;
  const dimmed = node.stale && !active;
  const accentColor = searchMatch ? "#facc15" : node.sourceDown ? "#f87171" : "#fbbf24";

  const handleEnter = useCallback((e: React.MouseEvent) => {
    setIsHovered(true);
    onMouseEnter?.(e);
  }, [onMouseEnter]);

  const handleLeave = useCallback(() => {
    setIsHovered(false);
    onMouseLeave?.();
  }, [onMouseLeave]);

  return (
    <g
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onClick={onClick}
      style={{ cursor: "pointer" }}
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
        rx={6}
        fill={active ? "#1e293b" : "#0f172a"}
        fillOpacity={searchMatch ? 0.95 : isHovered ? 0.88 : highlighted ? 0.8 : dimmed ? 0.3 : 0.65}
        stroke={accentColor}
        strokeWidth={searchMatch ? 2.5 : active ? 1.5 : 1}
        strokeOpacity={active ? 0.8 : dimmed ? 0.2 : 0.4}
        className={searchMatch ? "search-match-box" : undefined}
      />
      {/* Vendor */}
      <text
        x={x + 5}
        y={y + 12}
        fill={accentColor}
        fillOpacity={0.9}
        fontSize={searchMatch ? 9.5 : 8.5}
        fontWeight={searchMatch ? 700 : 600}
        fontFamily="system-ui, sans-serif"
      >
        {vendorShort || "Unknown"}
      </text>
      {/* IP */}
      <text
        x={x + 5}
        y={y + 23}
        fill="#94a3b8"
        fontSize={8}
        fontFamily="monospace"
      >
        {ipDisplay}
      </text>
      {/* MAC */}
      <text
        x={x + 5}
        y={y + 34}
        fill="#64748b"
        fontSize={7.5}
        fontFamily="monospace"
      >
        {macFormatted}
      </text>
      {isHovered && node.ips.length > 1 && (
        <title>{node.ips.join("\n")}</title>
      )}
    </g>
  );
}

function formatMac(mac: string): string {
  const clean = mac.replace(/[:\-\.]/g, "").toLowerCase();
  if (clean.length !== 12) return mac;
  return clean.match(/.{2}/g)!.join(":");
}
