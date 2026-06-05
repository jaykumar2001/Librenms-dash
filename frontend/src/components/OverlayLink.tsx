import type { LayoutLink } from "@/hooks/useForceLayout";
import { curvedLinkPath } from "@/lib/linkGeometry";

interface Props {
  link: LayoutLink;
  hovered: boolean;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}

export function OverlayLinkLine({ link, hovered, onMouseEnter, onMouseLeave }: Props) {
  const sx = link.source.x;
  const sy = link.source.y;
  const tx = link.target.x;
  const ty = link.target.y;
  if (sx == null || sy == null || tx == null || ty == null) return null;

  const d = curvedLinkPath(sx, sy, tx, ty);

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
      {/* Glow behind when hovered */}
      {hovered && (
        <path
          d={d}
          stroke={link.color}
          strokeWidth={6}
          strokeOpacity={0.25}
          fill="none"
          pointerEvents="none"
        />
      )}
      {/* Visible line */}
      <path
        d={d}
        stroke={link.color}
        strokeWidth={hovered ? 2.5 : 1.8}
        strokeOpacity={hovered ? 1 : 0.6}
        fill="none"
        pointerEvents="none"
      />
    </g>
  );
}
