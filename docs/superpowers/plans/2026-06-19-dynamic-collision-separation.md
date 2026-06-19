# Dynamic Collision Separation for Layout Boxes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve overlapping layout boxes (site / device / discovered) dynamically
by pushing colliding siblings apart with minimal displacement, preserving the user's
saved arrangement, instead of discarding the saved layout when an overlap is detected.

**Architecture:** A pure minimum-translation-vector (MTV) separation primitive
(`separateBoxes`) is applied hierarchically by `resolveCollisions`: separate device
+ discovered boxes within each site, grow the site to contain them (A4 as a floor),
then separate site boxes and translate each site's contents with it — iterated until
stable. Runs render-time over the restored layout and after every drag/resize/toggle,
with the dragged entity anchored. Non-destructive to localStorage. Replaces the
`sitesOverlap` discard fallback. See
`docs/superpowers/specs/2026-06-19-dynamic-collision-separation-design.md`.

**Tech Stack:** React, TypeScript, SVG. No new runtime dependencies (custom AABB
relaxation, not `d3-force`).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `frontend/src/hooks/layout/separation.ts` | Create | Pure `separateBoxes()` MTV relaxation, `Box` type, overlap helpers |
| `frontend/src/hooks/layout/separation.test.ts` | Create (if test infra present) | Unit tests for the primitive |
| `frontend/src/hooks/useForceLayout.ts` | Modify | `resolveCollisions`, `fitSitesToContents`; wire into effect + move/resize; remove discard branch |
| `frontend/src/components/TopologyMap.tsx` | Verify only | Confirm drag handlers need no change |

---

### Task 1: Separation primitive (pure, isolated)

**Files:** Create `frontend/src/hooks/layout/separation.ts`

- [ ] **Step 1: Box type + overlap helper.**

```ts
export interface Box { id: string; x: number; y: number; width: number; height: number; }

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) + margin;
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + margin;
  return ox > 0 && oy > 0;
}

export function anyOverlap(boxes: Box[], margin = 0): boolean {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (boxesOverlap(boxes[i], boxes[j], margin)) return true;
  return false;
}
```

- [ ] **Step 2: `separateBoxes` relaxation.** Implement the MTV loop from the spec.
  Operate on a local copy of `{x,y}`; return `Map<id,{dx,dy}>` of net displacement
  (omit zero entries). Honour `margin`, `anchorId`, `maxIters` (default 50). Push
  along the least-penetration axis; split evenly unless one box is the anchor.
  Use a deterministic pair order (index order); break when a full pass moves nothing.

- [ ] **Step 3: Self-check the invariants in code comments** — idempotent (no overlap
  ⇒ empty map), anchored box has no entry, symmetric split is order-independent.

**Verify:** `anyOverlap(result)` is false after applying displacements for a set of
overlapping boxes; an already-separated set yields an empty map.

---

### Task 2: Unit tests for the primitive (only if a test runner exists)

**Files:** Create `frontend/src/hooks/layout/separation.test.ts`

- [ ] **Step 1:** Check `frontend/package.json` for a `test` script / vitest. If none,
  **skip this task** and rely on Task 5's browser verification (note the skip).
- [ ] **Step 2:** Cases: (a) two boxes overlapping on X separate along X; (b) overlap
  on Y separates along Y; (c) already-separated ⇒ empty map (idempotent); (d) anchored
  box does not move, neighbour absorbs full push; (e) a row of three mutually
  overlapping boxes ends with `anyOverlap == false`; (f) margin leaves a visible gap.

**Verify:** `pnpm --filter frontend test` (or equivalent) green.

---

### Task 3: `resolveCollisions` + containment in `useForceLayout`

**Files:** Modify `frontend/src/hooks/useForceLayout.ts`

- [ ] **Step 1: `fitSitesToContents`.** Add alongside `fitSitesToDeviceGroups`. Same
  bounding-box logic but also include each site's discovered boxes, and clamp the
  resulting width/height to **at least** the site's current A4 size (A4 as a floor,
  grow-only). Reuse `toA4` to keep the floor A4-shaped.

- [ ] **Step 2: `resolveCollisions(sites, groups, nodes, arpNodes, anchor?)`.**
  Implement the inside-out pipeline from the spec:
  1. Per site: `separateBoxes([...siteNodes, ...siteArpNodes], { margin: NODE_GAP_X, anchorId: anchor?.node })`; apply displacements.
  2. `groups = fitDeviceGroupsToNodes(groups, nodes)`.
  3. `sites = fitSitesToContents(sites, groups, arpNodes)`.
  4. `const siteDisp = separateBoxes(sites, { margin: SITE_GAP, anchorId: anchor?.site })`; for each displaced site, translate the site **and** its groups, nodes, arpNodes by the same vector.
  5. Repeat step 4 (sizes now fixed) until `anyOverlap(sites, SITE_GAP)` is false or a small iteration cap.
  Return the updated arrays. Map device/site entities to `Box` via `{id|hostname|mac, x - width/2, y - height/2, width, height}` for nodes (nodes are center-anchored) and `{id, x, y, width, height}` for sites/groups (top-left anchored) — be careful with the two coordinate conventions.

- [ ] **Step 3: Fast-path guard.** At the top of `resolveCollisions`, if
  `!anyOverlap(siteBoxes, SITE_GAP)` and no per-site child overlap, return the inputs
  unchanged (common case — costs one scan).

**Verify:** Pure-ish; exercised via Task 5.

---

### Task 4: Wire `resolveCollisions` into the layout lifecycle

**Files:** Modify `frontend/src/hooks/useForceLayout.ts`

- [ ] **Step 1: Layout effect — replace the discard fallback.** In the rebuild
  effect, after `relayoutArpNodes(...)`, **remove** the `if (sitesOverlap(arp.sites)) { …setResult…; return; }` block added previously. Replace with:

```ts
const resolved = resolveCollisions(arp.sites, restoredGroups, restoredNodes, arp.arpNodes);
setSites(resolved.sites);
setNodes(resolved.nodes);
setLinks(result.links.map(rebind));        // rebind to resolved.nodes
setNeighborLinks(result.neighborLinks.map(rebind));
setArpLinks(result.arpLinks.map(rebind));
setArpDeviceNodes(resolved.arpNodes);
setDeviceGroups(resolved.groups);
setInitialScale(result.initialScale);
```

Ensure `rebind`/`relinkNodes` use `resolved.nodes` (links derive from node positions).

- [ ] **Step 2: `moveSite`** — after translating the site + contents, call
  `resolveCollisions(..., { site: siteId })` and set the resolved arrays. Persist the
  dragged site (existing) — neighbours move in-memory only until the user drags them.

- [ ] **Step 3: `moveDevice`** — after the existing node/group/site refit, call
  `resolveCollisions(..., { node: hostname })`. Set resolved arrays; keep existing
  persistence of the dragged node + sites.

- [ ] **Step 4: `resizeSite`** — after reflow + A4 re-snap, call
  `resolveCollisions(..., { site: siteId })` so the enlarged box pushes neighbours.

- [ ] **Step 5: Keep `sitesOverlap`** as the guard inside `resolveCollisions`/fast-path
  (do not delete it — only its discard usage in the effect is removed).

**Verify:** `pnpm --filter frontend build` (tsc) clean; then Task 5.

---

### Task 5: Verify in the browser (runtime observation)

> Use the **verify** skill. App runs in Docker (`docker-compose up -d --build`,
> host network, port 3001, login `admin`/`changeme`). Drive headless Chrome over CDP
> (pattern already established in scratchpad scripts). Read site/device rects from
> `svg rect[rx="8"]` (sites) and device/discovered rects; compute pairwise overlap in
> natural SVG coordinates.

- [ ] **Step 1: No-overlap on rebuild.** Inject an overlapping saved layout into
  `localStorage["librenms-dash:layout:v1"]` (all sites piled on one spot), reload,
  assert **zero** site overlaps AND that the boxes are *near* their injected spot
  (separated, not regenerated from scratch) — proving "kept more or less the same".
- [ ] **Step 2: Discovered toggle.** With a tight saved layout, toggle Discovered on;
  assert zero overlaps and zoom/pan preserved (`skipAutoFitOnceRef` still holds).
- [ ] **Step 3: Orientation flip.** Flip a site to portrait; assert zero overlaps,
  zoom preserved.
- [ ] **Step 4: Drag anchoring.** Drag one site onto a neighbour; assert the dragged
  site stays under the cursor (its rect matches the drag target) and the neighbour
  moved away (zero overlap).
- [ ] **Step 5: Idempotence.** Trigger two consecutive rebuilds (e.g. toggle Discovered
  off→on→off) and assert site rects return to the same coordinates (no drift).

**Verify:** All five assertions pass; capture screenshots of the before/after for the
overlap and drag cases.

---

## Rollback / Risk

- The change is additive + one deletion (the discard branch). If `resolveCollisions`
  misbehaves, reverting Task 4 Step 1 restores the discard fallback.
- Determinism risk: ensure `separateBoxes` uses a fixed pair order and the symmetric
  split, so repeated resolves don't drift. Task 5 Step 5 guards this.
- Coordinate-convention risk: device **nodes are center-anchored** (`x,y` = center)
  while site/group boxes are **top-left anchored**. The `Box` adapter in Task 3
  Step 2 must convert consistently or separation will be offset by half a box.
```
