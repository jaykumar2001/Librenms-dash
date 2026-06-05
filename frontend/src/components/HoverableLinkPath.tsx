import { curvedLinkPath } from "@/lib/linkGeometry";

interface Props {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  color: string;
  hovered: boolean;
  linkKey: string;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}

export function HoverableLinkPath({ sx, sy, tx, ty, color, hovered, onMouseEnter, onMouseLeave }: Props) {
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
          stroke={color}
          strokeWidth={6}
          strokeOpacity={0.3}
          fill="none"
          pointerEvents="none"
        />
      )}
      {/* Visible line */}
      <path
        d={d}
        stroke={color}
        strokeWidth={hovered ? 2.5 : 1.5}
        strokeOpacity={hovered ? 1 : 0.6}
        fill="none"
        pointerEvents="none"
      />
    </g>
  );
}
