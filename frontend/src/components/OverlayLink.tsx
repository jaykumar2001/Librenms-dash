import type { LayoutLink } from "@/hooks/useForceLayout";
import { curvedLinkPath, type Side } from "@/lib/linkGeometry";

interface Props {
  link: LayoutLink;
  hovered: boolean;
  highlighted?: boolean;
  sourceSide?: Side;
  targetSide?: Side;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}

export function OverlayLinkLine({ link, hovered, highlighted, sourceSide, targetSide, onMouseEnter, onMouseLeave }: Props) {
  const sx = link.source.x;
  const sy = link.source.y;
  const tx = link.target.x;
  const ty = link.target.y;
  if (sx == null || sy == null || tx == null || ty == null) return null;

  const d = curvedLinkPath(sx, sy, tx, ty, sourceSide, targetSide);

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
      {(hovered || highlighted) && (
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
        stroke={link.color}
        strokeWidth={hovered || highlighted ? 2.5 : 1.8}
        strokeOpacity={hovered || highlighted ? 1 : 0.6}
        fill="none"
        pointerEvents="none"
      />
    </g>
  );
}
