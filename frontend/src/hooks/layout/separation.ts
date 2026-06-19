// Minimum-translation-vector (MTV) collision separation for axis-aligned boxes.
//
// Pure, deterministic, idempotent: given a set of boxes, push any overlapping pair
// apart along their axis of least penetration until none overlap (plus a margin).
// No randomness and no animation — this is a constraint solve, not a physics sim.
// Used by useForceLayout to keep site / device / discovered boxes from overlapping
// while displacing them the minimum distance (so a user's layout stays put).

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SeparateOptions {
  /** Minimum gap to leave between boxes. */
  margin?: number;
  /** This box never moves; colliding neighbours absorb the full push. */
  anchorId?: string;
  /** Safety cap on relaxation passes. */
  maxIters?: number;
}

function overlapAmount(a: Box, b: Box, margin: number): { ox: number; oy: number } {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) + margin;
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + margin;
  return { ox, oy };
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  const { ox, oy } = overlapAmount(a, b, margin);
  return ox > 0 && oy > 0;
}

export function anyOverlap(boxes: Box[], margin = 0): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j], margin)) return true;
    }
  }
  return false;
}

/**
 * Resolve overlaps among `boxes` and return the net displacement per box id
 * (entries with zero displacement are omitted). The input boxes are not mutated.
 *
 * Invariants:
 *  - No overlap on entry => empty map (idempotent; safe to call every render).
 *  - The `anchorId` box never appears in the result (it does not move).
 *  - Without an anchor the push is split evenly between the pair, so the result is
 *    independent of which box of a pair is listed first (deterministic).
 */
export function separateBoxes(boxes: Box[], opts: SeparateOptions = {}): Map<string, { dx: number; dy: number }> {
  const margin = opts.margin ?? 0;
  const maxIters = opts.maxIters ?? 50;
  // Work on a mutable copy of just the positions.
  const work = boxes.map((b) => ({ ...b }));

  for (let iter = 0; iter < maxIters; iter++) {
    let movedThisPass = false;
    for (let i = 0; i < work.length; i++) {
      for (let j = i + 1; j < work.length; j++) {
        const a = work[i];
        const b = work[j];
        const { ox, oy } = overlapAmount(a, b, margin);
        if (ox <= 0 || oy <= 0) continue; // not overlapping within margin
        movedThisPass = true;

        const aAnchored = a.id === opts.anchorId;
        const bAnchored = b.id === opts.anchorId;
        // Fraction of the push each box takes.
        const aShare = aAnchored ? 0 : bAnchored ? 1 : 0.5;
        const bShare = bAnchored ? 0 : aAnchored ? 1 : 0.5;

        if (ox < oy) {
          // Separate along X (least penetration).
          const dir = (a.x + a.width / 2) <= (b.x + b.width / 2) ? -1 : 1;
          a.x += dir * ox * aShare;
          b.x -= dir * ox * bShare;
        } else {
          // Separate along Y.
          const dir = (a.y + a.height / 2) <= (b.y + b.height / 2) ? -1 : 1;
          a.y += dir * oy * aShare;
          b.y -= dir * oy * bShare;
        }
      }
    }
    if (!movedThisPass) break;
  }

  const disp = new Map<string, { dx: number; dy: number }>();
  for (let i = 0; i < boxes.length; i++) {
    const dx = work[i].x - boxes[i].x;
    const dy = work[i].y - boxes[i].y;
    if (dx !== 0 || dy !== 0) disp.set(boxes[i].id, { dx, dy });
  }
  return disp;
}
