import { useState } from "react";
import type { ArpDeviceLayoutNode } from "@/hooks/useForceLayout";

interface Props {
  node: ArpDeviceLayoutNode;
}

const BOX_W = 132;
const BOX_H = 42;

export function ArpDeviceNode({ node }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const x = node.x - BOX_W / 2;
  const y = node.y - BOX_H / 2;

  const vendorShort = node.vendor.length > 18 ? node.vendor.slice(0, 17) + "…" : node.vendor;
  const macFormatted = formatMac(node.mac);
  const ipDisplay = node.ips.length > 1
    ? `${node.ips[0]} +${node.ips.length - 1}`
    : node.ips[0] ?? "";

  return (
    <g
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <rect
        x={x}
        y={y}
        width={BOX_W}
        height={BOX_H}
        rx={6}
        fill={isHovered ? "#1e293b" : "#0f172a"}
        fillOpacity={isHovered ? 0.88 : 0.65}
        stroke="#fbbf24"
        strokeWidth={isHovered ? 1.5 : 1}
        strokeOpacity={isHovered ? 0.8 : 0.4}
      />
      {/* Vendor */}
      <text
        x={x + 5}
        y={y + 12}
        fill="#fbbf24"
        fillOpacity={0.9}
        fontSize={8.5}
        fontWeight={600}
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
