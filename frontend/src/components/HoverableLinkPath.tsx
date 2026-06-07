import { curvedLinkPath, type Side } from "@/lib/linkGeometry";

interface Props {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  color: string;
  hovered: boolean;
  highlighted?: boolean;
  linkKey: string;
  sourceSide?: Side;
  targetSide?: Side;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}

export function HoverableLinkPath({ sx, sy, tx, ty, color, hovered, highlighted, sourceSide, targetSide, onMouseEnter, onMouseLeave }: Props) {
  const d = curvedLinkPath(sx, sy, tx, ty, sourceSide, targetSide);
  const active = hovered || highlighted;

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
          stroke={color}
          strokeWidth={6}
          strokeOpacity={hovered ? 0.3 : 0.2}
          fill="none"
          pointerEvents="none"
        />
      )}
      {/* Visible line */}
      <path
        d={d}
        stroke={color}
        strokeWidth={active ? 2.5 : 1.5}
        strokeOpacity={active ? 1 : 0.6}
        fill="none"
        pointerEvents="none"
      />
    </g>
  );
}
