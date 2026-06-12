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

function sideNormal(side: Side): { x: number; y: number } {
  switch (side) {
    case "left": return { x: -1, y: 0 };
    case "right": return { x: 1, y: 0 };
    case "top": return { x: 0, y: -1 };
    case "bottom": return { x: 0, y: 1 };
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

function computeControlPointOffset(
  anchor: { x: number; y: number },
  target: { x: number; y: number },
  side: Side,
  half: HalfDims,
): number {
  const n = sideNormal(side);
  const toTarget = { x: target.x - anchor.x, y: target.y - anchor.y };
  const dot = toTarget.x * n.x + toTarget.y * n.y;
  const dist = Math.sqrt(toTarget.x * toTarget.x + toTarget.y * toTarget.y) || 1;
  // dot < 0 means the target is behind the exit direction (opposite side)
  // Scale offset: minimum clearance of the box dimension, more for opposite-side targets
  const minOffset = Math.max(half.halfW, half.halfH) + 20;
  if (dot >= 0) {
    return Math.max(minOffset, dist * 0.35);
  }
  // Target is behind — need a wide swing to clear the box
  return Math.max(minOffset * 1.5, dist * 0.5);
}

function cubicPath(
  sx: number, sy: number,
  tx: number, ty: number,
  sSide: Side,
  tSide: Side,
  sHalf: HalfDims,
  tHalf: HalfDims,
): string {
  const s = anchorPointForSide(sx, sy, sSide, sHalf);
  const t = anchorPointForSide(tx, ty, tSide, tHalf);
  const sn = sideNormal(sSide);
  const tn = sideNormal(tSide);
  const sOff = computeControlPointOffset(s, t, sSide, sHalf);
  const tOff = computeControlPointOffset(t, s, tSide, tHalf);
  const cp1x = s.x + sn.x * sOff;
  const cp1y = s.y + sn.y * sOff;
  const cp2x = t.x + tn.x * tOff;
  const cp2y = t.y + tn.y * tOff;
  return `M ${s.x} ${s.y} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${t.x} ${t.y}`;
}

export function pointToPointPath(
  ax: number, ay: number,
  bx: number, by: number,
  sourceSide?: Side,
  targetSide?: Side,
  sourceHalf: HalfDims = DEVICE_HALF,
  targetHalf: HalfDims = ARP_HALF,
): string {
  const sSide = sourceSide ?? computeDominantSide(ax, ay, [{ x: bx, y: by }], sourceHalf);
  const tSide = targetSide ?? computeDominantSide(bx, by, [{ x: ax, y: ay }], targetHalf);
  return cubicPath(ax, ay, bx, by, sSide, tSide, sourceHalf, targetHalf);
}

export function curvedLinkPath(
  sx: number, sy: number,
  tx: number, ty: number,
  sourceSide?: Side,
  targetSide?: Side,
  sourceHalf: HalfDims = DEVICE_HALF,
  targetHalf: HalfDims = DEVICE_HALF,
): string {
  const sSide = sourceSide ?? computeDominantSide(sx, sy, [{ x: tx, y: ty }], sourceHalf);
  const tSide = targetSide ?? computeDominantSide(tx, ty, [{ x: sx, y: sy }], targetHalf);
  return cubicPath(sx, sy, tx, ty, sSide, tSide, sourceHalf, targetHalf);
}
