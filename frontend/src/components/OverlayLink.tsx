import type { LayoutLink } from "@/hooks/useForceLayout";
import { curvedLinkPath, type Side } from "@/lib/linkGeometry";

interface Props {
  link: LayoutLink;
  hovered: boolean;
  highlighted?: boolean;
  sourceSide?: Side;
  targetSide?: Side;
  trafficColor?: string;
  trafficIntensity?: number;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}

export function OverlayLinkLine({ link, hovered, highlighted, sourceSide, targetSide, trafficColor, trafficIntensity = 0, onMouseEnter, onMouseLeave }: Props) {
  const sx = link.source.x;
  const sy = link.source.y;
  const tx = link.target.x;
  const ty = link.target.y;
  if (sx == null || sy == null || tx == null || ty == null) return null;

  const d = curvedLinkPath(sx, sy, tx, ty, sourceSide, targetSide);

  // Active state always uses the full palette color; idle state uses the
  // lightness-adjusted traffic color so brightness encodes throughput.
  const active = hovered || highlighted;
  const strokeColor = active ? link.color : (trafficColor ?? link.color);
  // Width grows slightly with traffic (1.8 → 2.4) as a secondary visual channel.
  const strokeWidth = active ? 2.5 : 1.8 + 0.6 * trafficIntensity;

  return (
    <g>
      {/* Wide invisible hit area */}
      <path
        d={d}
        stroke="transparent"
        strokeWidth={12}
        fill="none"
        style={{ cursor: "pointer" }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
      {/* Glow behind when active */}
      {active && (
        <path
          d={d}
          stroke={link.color}
          strokeWidth={6}
          strokeOpacity={hovered ? 0.25 : 0.15}
          fill="none"
          pointerEvents="none"
        />
      )}
      {/* Visible line */}
      <path
        d={d}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeOpacity={active ? 1 : 0.85}
        fill="none"
        pointerEvents="none"
      />
    </g>
  );
}
