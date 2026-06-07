const BOX_W = 140;
const BOX_H = 88;

export interface HalfDims {
  halfW: number;
  halfH: number;
}

export const DEVICE_HALF: HalfDims = { halfW: BOX_W / 2, halfH: BOX_H / 2 };
export const ARP_HALF: HalfDims = { halfW: 132 / 2, halfH: 42 / 2 };

// Anchor a line endpoint to the centre of whichever box side faces the peer.
// Every line therefore originates/terminates on a single point per side (the
// midpoint), instead of sliding along the edge with the connection angle.
function anchorToSideCenter(
  cx: number, cy: number,
  tx: number, ty: number,
  half: HalfDims,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // Pick the side the peer lies toward, weighted by the box aspect ratio.
  if (Math.abs(dx) / half.halfW >= Math.abs(dy) / half.halfH) {
    // Left or right side.
    return { x: cx + Math.sign(dx) * half.halfW, y: cy };
  }
  // Top or bottom side.
  return { x: cx, y: cy + Math.sign(dy) * half.halfH };
}

export function pointToPointPath(
  ax: number, ay: number,
  bx: number, by: number,
): string {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const curvature = Math.min(dist * 0.25, 60);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);
  const cx = mx + nx * curvature;
  const cy = my + ny * curvature;
  return `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
}

export function curvedLinkPath(
  sx: number, sy: number,
  tx: number, ty: number,
  sourceHalf: HalfDims = DEVICE_HALF,
  targetHalf: HalfDims = DEVICE_HALF,
): string {
  const s = anchorToSideCenter(sx, sy, tx, ty, sourceHalf);
  const t = anchorToSideCenter(tx, ty, sx, sy, targetHalf);

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
