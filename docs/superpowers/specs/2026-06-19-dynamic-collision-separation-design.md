# Dynamic Collision Separation for Layout Boxes

## Problem

The topology map renders nested rectangular boxes — **site** boxes that contain
**device-group** and **device-node** boxes plus a **discovered-device** section.
Positions come from a deterministic auto-layout (`layoutAll`) overlaid with the
user's saved drags/resizes (`usePersistedLayout`).

Overlaps appear whenever the saved layout no longer fits the content:

- Toggling **Discovered** grows a site box downward into the box below it.
- Flipping a site's **orientation** (A4 portrait ⇄ landscape) changes its footprint.
- A manually **resized** or **dragged** box ends up on top of a neighbour.
- A device dragged inside a site lands on another device.

So far we've patched these case-by-case: row spacing reserves the discovered
section (`totalH`), and a `sitesOverlap()` guard *discards the entire saved layout*
and falls back to the auto-layout when boxes collide. The discard is blunt — it
throws away the user's whole arrangement the moment one pair overlaps, and it only
covers site-vs-site collisions, not device or discovered boxes.

We want a **general, dynamic** mechanism: let the boxes repel one another so that
any overlap — whatever caused it — is resolved by pushing the colliding boxes apart
just far enough to clear each other, **preserving the user's intended arrangement as
closely as possible** instead of regenerating it.

## Goals

- Any two sibling boxes that overlap are separated until they no longer overlap
  (plus a small margin), at every level of the hierarchy: site↔site,
  device↔device, device↔discovered, discovered↔discovered.
- Minimal displacement — boxes move the least distance needed, so a user's layout
  stays "more or less the same".
- A parent box always encloses its (separated) children.
- The pass is **idempotent and deterministic**: running it on an
  already-separated layout produces zero movement, so it does not drift on every
  background poll/refresh.
- During a drag, the box the user is holding does not get pushed — the *others*
  move out of its way.

## Non-Goals

- Not a physics animation with momentum/jitter. Settling is a render-time
  constraint solve, not a simulation the user watches bounce.
- Not viewport-aware. Separation may push content beyond the current viewport;
  existing pan/zoom (and auto-fit) handle reachability. We never re-introduce an
  overlap to keep things on-screen.
- Does not change box *sizing* (A4 ratio, discovered-section height) — only
  positions. A crowded site may grow to contain separated children (breaking A4),
  consistent with the existing "discovered extends below" decision.

## Design Decisions

- **Custom AABB separation (constraint relaxation), not `d3-force`.** `d3-force` is
  a dependency but unused, and its `forceCollide` models *circles*. Our boxes are
  axis-aligned rectangles with extreme aspect ratios (A4, wide device grids); a
  circular collider over-separates badly. We instead resolve overlaps with the
  **minimum translation vector (MTV)** along the axis of least penetration. This is
  deterministic (no random seed, no alpha schedule), moves boxes the minimum
  distance (best preserves the user layout), and is trivially idempotent (no
  overlap ⇒ no move). `d3-force` can be removed from `package.json` in a separate
  cleanup; this design does not depend on it.
- **Render-time pass, non-destructive to localStorage.** Separation runs over the
  restored (persisted ∪ fresh) layout each time the layout is (re)built and after
  each manipulation. It mutates the in-memory layout state — *not* the saved
  positions. We never rewrite `localStorage` on load. Resolved positions only
  become persisted when the user next drags/resizes (the drag handlers already
  persist the displayed state). This keeps the saved arrangement intact.
- **Replaces the `sitesOverlap` discard fallback.** The blunt "throw away the saved
  layout" branch added previously is removed; separation supersedes it. The
  `sitesOverlap()` predicate is kept and reused as the cheap "is there anything to
  do?" fast-path guard.
- **Hierarchical, inside-out.** Children are separated within a parent first, the
  parent is grown to contain them, then siblings are separated at the next level up
  — iterated until stable. Resolving the outer level first would let a grown child
  re-introduce an overlap.
- **Anchoring.** Each separation accepts an optional `anchorId`. The anchored box is
  immovable; its colliding neighbours absorb the full MTV. Drag handlers anchor the
  dragged entity so it tracks the cursor while others give way. With no anchor
  (plain re-render), the MTV is split evenly between the pair — deterministic and
  symmetric.
- **Moving a site moves its contents.** Site-level separation produces a
  per-site displacement vector; the caller translates each site's device groups,
  nodes, and discovered boxes by the same vector so the box and its contents stay
  together.

## Architecture

### Entities & hierarchy

```
Site box                         ← siblings repel each other (global scope)
 ├─ Device-group box  ┐
 ├─ Device-node box   ├─ repel each other within the site (intra-site scope)
 └─ Discovered box    ┘          parent site grows to contain them
```

Collision units:

| Scope     | Entities that repel                                  | Container that grows |
|-----------|------------------------------------------------------|----------------------|
| Global    | all site boxes                                       | — (free space)       |
| Intra-site| device-node boxes + discovered-device boxes¹         | the site box         |

¹ Device-group borders are *derived* (they refit to enclose their nodes via
`fitDeviceGroupsToNodes`), so groups are recomputed after node separation rather
than separated directly.

### The separation primitive

A pure function over axis-aligned boxes. `Box = { id, x, y, width, height }`.

```ts
interface SeparateOptions {
  margin?: number;     // min gap to leave between boxes (default 0)
  anchorId?: string;   // this box never moves; neighbours absorb the full push
  maxIters?: number;   // safety cap (default 50)
}

// Returns a Map<id, {dx, dy}> of net displacements (zero entries omitted).
function separateBoxes(boxes: Box[], opts?: SeparateOptions): Map<string, {dx:number;dy:number}>
```

Algorithm (relaxation; iterate until a pass makes no move or `maxIters` hit):

```
for iter in 0..maxIters:
  movedThisPass = false
  for each unordered pair (a, b):
    ox = min(a.right, b.right) - max(a.left, b.left) + margin
    oy = min(a.bottom, b.bottom) - max(a.top, b.top) + margin
    if ox <= 0 or oy <= 0: continue            // not overlapping (within margin)
    movedThisPass = true
    if ox < oy:                                 // least-penetration axis = X
      push = ox
      dir  = sign(a.centerX - b.centerX) || 1
      applyPush(a, b, dx = dir * push, axis = X)
    else:                                        // least-penetration axis = Y
      push = oy
      dir  = sign(a.centerY - b.centerY) || 1
      applyPush(a, b, dy = dir * push, axis = Y)
  if not movedThisPass: break

applyPush(a, b, delta):
  if anchorId == a.id:        b moves by -delta
  elif anchorId == b.id:      a moves by +delta
  else:                       a moves by +delta/2 ; b moves by -delta/2
```

Properties: idempotent (no overlap ⇒ `movedThisPass` false on first pass ⇒ break),
deterministic (stable pair iteration order, no randomness), minimal (MTV along the
least-penetration axis). Convergence is monotone for the symmetric/anchored split;
`maxIters` bounds pathological chains.

### Hierarchical resolution pipeline

A single entry point, called wherever the layout is built or mutated:

```
resolveCollisions(sites, groups, nodes, arpNodes, anchor?):
  // 1. Intra-site: separate device nodes + discovered boxes within each site.
  for each site:
    children = nodes(site) ++ arpNodes(site)
    disp = separateBoxes(children, { margin: NODE_GAP, anchorId: anchor?.node })
    apply disp to nodes/arpNodes of this site
  groups = fitDeviceGroupsToNodes(groups, nodes)     // refit group borders
  sites  = fitSitesToContents(sites, groups, arpNodes) // grow site to contain (A4 floor)

  // 2. Global: separate site boxes, then translate each site's contents with it.
  siteDisp = separateBoxes(sites, { margin: SITE_GAP, anchorId: anchor?.site })
  for each site with siteDisp[id]:
    translate site + its groups + nodes + arpNodes by siteDisp[id]

  // 3. A grown/translated site may now overlap another → repeat 2 until stable
  //    (bounded; sizes are fixed in this pass so it converges quickly).
  return { sites, groups, nodes, arpNodes }
```

`fitSitesToContents` is `fitSitesToDeviceGroups` extended to also include the
discovered boxes in the bounding box, with the A4 dimensions as a *floor* (the site
never shrinks below its A4 size; it only grows to contain).

### Data flow

```
layoutAll (fresh, A4, never overlaps)
      │
      ▼
applySitePositions / applyNodePositions   ← user's saved drags/resizes
      │
      ▼
relayoutArpNodes                           ← place discovered below content
      │
      ▼
resolveCollisions(...)                     ← NEW: push overlaps apart, contain
      │   (fast-path: skip if sitesOverlap()==false AND no intra-site overlap)
      ▼
setSites / setNodes / setDeviceGroups / setArpDeviceNodes
```

### Integration points

| Trigger | Today | With this design |
|---------|-------|------------------|
| Layout (re)build effect | applies saved positions; **discards them if sites overlap** | applies saved positions, then `resolveCollisions(...)` (no anchor) — discard fallback removed |
| `moveSite(id, dx, dy)` | translates site + contents | then `resolveCollisions(..., anchor:{site:id})` — neighbours give way |
| `moveDevice(host, dx, dy)` | translates node, refits group/site | then `resolveCollisions(..., anchor:{node:host})` — sibling devices/discovered give way |
| `resizeSite(id, w, h)` | reflows content, refits | then `resolveCollisions(..., anchor:{site:id})` — neighbours give way to the larger box |
| Discovered toggle / orientation flip | grows boxes (can overlap) | layout rebuild runs `resolveCollisions` — growth pushes neighbours apart |

### Idempotence & stability

- On a background poll with an unchanged layout signature, the effect already
  early-returns (no rebuild). When it does rebuild, `resolveCollisions` over an
  already-separated layout moves nothing.
- The fast-path guard (`sitesOverlap` + a cheap intra-site overlap check) skips the
  whole pass when there is nothing to resolve, so the common case costs one O(n²)
  scan over a handful of sites.
- Optional refinement (future): after global separation, translate the whole set so
  its bounding-box top-left matches the pre-separation top-left, eliminating slow
  drift of the overall map under repeated resolves.

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/hooks/layout/separation.ts` **(new)** | Pure `separateBoxes()` MTV relaxation + `Box` type. No React. Unit-testable. |
| `frontend/src/hooks/useForceLayout.ts` | Add `resolveCollisions(...)` and `fitSitesToContents(...)`. Call `resolveCollisions` in the layout effect (remove the `sitesOverlap` discard branch), and at the end of `moveSite`, `moveDevice`, `resizeSite` with the appropriate anchor. Keep `sitesOverlap` as the fast-path guard. |
| `frontend/src/hooks/usePersistedLayout.ts` | None (separation is non-destructive; existing save paths persist the resolved state on next drag). |
| `frontend/src/components/TopologyMap.tsx` | None required (drag handlers already call `moveSite`/`moveDevice`/`resizeSite`, which now resolve internally). |
| `frontend/package.json` | Optional follow-up: drop the now-confirmed-unused `d3-force` / `@types/d3-force` deps. Out of scope for this change. |

## What This Does NOT Change

- Box sizing: A4 ratio lock, discovered-section height math, `reflowSiteContents`.
- The auto-layout (`layoutAll`) — it remains the overlap-free baseline.
- `usePersistedLayout` storage format or the `layoutSignature` early-return.
- Zoom/pan behaviour, the `skipAutoFitOnceRef` viewport lock, or auto-fit.
- The deterministic, non-animated nature of the layout (positions resolve in one
  synchronous pass; any visual smoothing is a separate CSS-transition concern).
```
