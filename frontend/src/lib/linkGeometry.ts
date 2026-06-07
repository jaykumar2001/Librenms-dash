const BOX_W = 140;
const BOX_H = 88;

export interface HalfDims {
  halfW: number;
  halfH: number;
}

export type Side = "left" | "right" | "top" | "bottom";

export const DEVICE_HALF: HalfDims = { halfW: BOX_W / 2, halfH: BOX_H / 2 };
export const ARP_HALF: HalfDims = { halfW: 132 / 2, halfH: 42 / 2 };

export function anchorPointForSide(
  cx: number, cy: number,
  side: Side,
  half: HalfDims,
): { x: number; y: number } {
  switch (side) {
    case "left": return { x: cx - half.halfW, y: cy };
    case "right": return { x: cx + half.halfW, y: cy };
    case "top": return { x: cx, y: cy - half.halfH };
    case "bottom": return { x: cx, y: cy + half.halfH };
  }
}

/**
 * Given a device center and all its peer centers, pick the single side
 * that faces the most peers. Ties broken by: right > bottom > left > top.
 */
export function computeDominantSide(
  cx: number, cy: number,
  peers: { x: number; y: number }[],
  half: HalfDims = DEVICE_HALF,
): Side {
  const counts: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const p of peers) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (dx === 0 && dy === 0) continue;
    if (Math.abs(dx) / half.halfW >= Math.abs(dy) / half.halfH) {
      counts[dx >= 0 ? "right" : "left"]++;
    } else {
      counts[dy >= 0 ? "bottom" : "top"]++;
    }
  }
  let best: Side = "right";
  let bestCount = -1;
  for (const side of ["right", "bottom", "left", "top"] as Side[]) {
    if (counts[side] > bestCount) {
      bestCount = counts[side];
      best = side;
    }
  }
  return best;
}

export function pointToPointPath(
  ax: number, ay: number,
  bx: number, by: number,
  sourceSide?: Side,
  targetSide?: Side,
  sourceHalf: HalfDims = DEVICE_HALF,
  targetHalf: HalfDims = ARP_HALF,
): string {
  const a = sourceSide
    ? anchorPointForSide(ax, ay, sourceSide, sourceHalf)
    : anchorPointForSide(ax, ay, computeDominantSide(ax, ay, [{ x: bx, y: by }], sourceHalf), sourceHalf);
  const b = targetSide
    ? anchorPointForSide(bx, by, targetSide, targetHalf)
    : anchorPointForSide(bx, by, computeDominantSide(bx, by, [{ x: ax, y: ay }], targetHalf), targetHalf);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const curvature = Math.min(dist * 0.25, 60);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);
  const cx = mx + nx * curvature;
  const cy = my + ny * curvature;
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

export function curvedLinkPath(
  sx: number, sy: number,
  tx: number, ty: number,
  sourceSide?: Side,
  targetSide?: Side,
  sourceHalf: HalfDims = DEVICE_HALF,
  targetHalf: HalfDims = DEVICE_HALF,
): string {
  const s = sourceSide
    ? anchorPointForSide(sx, sy, sourceSide, sourceHalf)
    : anchorPointForSide(sx, sy, computeDominantSide(sx, sy, [{ x: tx, y: ty }], sourceHalf), sourceHalf);
  const t = targetSide
    ? anchorPointForSide(tx, ty, targetSide, targetHalf)
    : anchorPointForSide(tx, ty, computeDominantSide(tx, ty, [{ x: sx, y: sy }], targetHalf), targetHalf);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const curvature = Math.min(dist * 0.25, 60);

  const mx = (s.x + t.x) / 2;
  const my = (s.y + t.y) / 2;

  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);

  const cx1 = mx + nx * curvature;
  const cy1 = my + ny * curvature;

  return `M ${s.x} ${s.y} Q ${cx1} ${cy1} ${t.x} ${t.y}`;
}
