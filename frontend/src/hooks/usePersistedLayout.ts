import { useCallback, useEffect, useRef } from "react";
import type { SiteCluster, LayoutNode, SiteOrientation } from "./useForceLayout";

// Storage key versioned so stale shapes are automatically discarded on upgrade.
const STORAGE_KEY = "librenms-dash:layout:v1";

interface PersistedSitePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PersistedNodePosition {
  x: number;
  y: number;
}

export interface PersistedLayout {
  sitePositions: Record<string, PersistedSitePosition>;
  nodePositions: Record<string, PersistedNodePosition>;
  siteOrientations: Record<string, SiteOrientation>;
}

function readStorage(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sitePositions: {}, nodePositions: {}, siteOrientations: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
    return {
      sitePositions: parsed.sitePositions ?? {},
      nodePositions: parsed.nodePositions ?? {},
      siteOrientations: parsed.siteOrientations ?? {},
    };
  } catch {
    return { sitePositions: {}, nodePositions: {}, siteOrientations: {} };
  }
}

function writeStorage(data: PersistedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked — silently ignore.
  }
}

/**
 * Reads persisted layout from localStorage and applies saved positions/orientations
 * on top of freshly-computed sites and nodes.  Provides helpers to save individual
 * position updates without requiring a full re-render of the layout.
 */
export function usePersistedLayout() {
  // Keep a mutable cache so writes don't need to re-read storage.
  const cacheRef = useRef<PersistedLayout>(readStorage());

  // Apply saved positions onto a freshly-computed site array.
  // Sites whose IDs aren't in storage keep their computed positions.
  // Restore only the manually-resized SIZE; position is always derived from the
  // (content-driven) auto-layout so site boxes stay elastic and follow their devices.
  const applySitePositions = useCallback((sites: SiteCluster[]): SiteCluster[] => {
    const saved = cacheRef.current.sitePositions;
    return sites.map((site) => {
      const p = saved[site.id];
      if (!p) return site;
      return { ...site, width: p.width, height: p.height };
    });
  }, []);

  // Apply saved positions onto freshly-computed nodes.
  const applyNodePositions = useCallback((nodes: LayoutNode[]): LayoutNode[] => {
    const saved = cacheRef.current.nodePositions;
    return nodes.map((node) => {
      const p = saved[node.hostname];
      if (!p) return node;
      return { ...node, x: p.x, y: p.y };
    });
  }, []);

  // Return the saved site orientations to seed the hook state.
  const getSavedOrientations = useCallback((): Record<string, SiteOrientation> => {
    return { ...cacheRef.current.siteOrientations };
  }, []);

  // Persist a batch of updated site positions/sizes.
  const saveSitePositions = useCallback((sites: SiteCluster[]) => {
    const next: Record<string, PersistedSitePosition> = { ...cacheRef.current.sitePositions };
    for (const s of sites) {
      next[s.id] = { x: s.x, y: s.y, width: s.width, height: s.height };
    }
    cacheRef.current = { ...cacheRef.current, sitePositions: next };
    writeStorage(cacheRef.current);
  }, []);

  // Persist a batch of updated node positions.
  const saveNodePositions = useCallback((nodes: LayoutNode[]) => {
    const next: Record<string, PersistedNodePosition> = { ...cacheRef.current.nodePositions };
    for (const n of nodes) {
      next[n.hostname] = { x: n.x, y: n.y };
    }
    cacheRef.current = { ...cacheRef.current, nodePositions: next };
    writeStorage(cacheRef.current);
  }, []);

  // Swap a persisted box's width/height (no-op if the site has no saved size).
  // An A4-portrait box (w, w·√2) becomes A4-landscape (w·√2, w) and vice-versa,
  // so a manually-resized box stays locked to the ratio across an orientation flip.
  const swapSiteSize = useCallback((siteId: string) => {
    const p = cacheRef.current.sitePositions[siteId];
    if (!p) return;
    const next = { ...cacheRef.current.sitePositions, [siteId]: { ...p, width: p.height, height: p.width } };
    cacheRef.current = { ...cacheRef.current, sitePositions: next };
    writeStorage(cacheRef.current);
  }, []);

  // Persist a single site orientation change.
  const saveSiteOrientation = useCallback((siteId: string, orientation: SiteOrientation) => {
    const next = { ...cacheRef.current.siteOrientations, [siteId]: orientation };
    cacheRef.current = { ...cacheRef.current, siteOrientations: next };
    writeStorage(cacheRef.current);
  }, []);

  // Wipe all persisted layout data (called on "Reset Layout").
  const clearPersistedLayout = useCallback(() => {
    cacheRef.current = { sitePositions: {}, nodePositions: {}, siteOrientations: {} };
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return {
    applySitePositions,
    applyNodePositions,
    getSavedOrientations,
    saveSitePositions,
    saveNodePositions,
    saveSiteOrientation,
    swapSiteSize,
    clearPersistedLayout,
  };
}

// ─── Viewport transform persistence ───────────────────────────────────────────

const TRANSFORM_KEY = "librenms-dash:transform:v1";
export const USE_FIT_TRANSFORM_KEY = "librenms-dash:use-fit-transform";

interface PersistedTransform { x: number; y: number; scale: number }

/** Set after a fresh login so the dashboard uses fit-to-screen zoom, not localStorage. */
export function requestFitTransform(): void {
  try { sessionStorage.setItem(USE_FIT_TRANSFORM_KEY, "1"); } catch { /* ignore */ }
}

export function consumeFitTransformRequest(): boolean {
  try {
    if (sessionStorage.getItem(USE_FIT_TRANSFORM_KEY)) {
      sessionStorage.removeItem(USE_FIT_TRANSFORM_KEY);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function readPersistedTransform(): PersistedTransform | null {
  try {
    const raw = localStorage.getItem(TRANSFORM_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedTransform;
  } catch { return null; }
}

export function writePersistedTransform(t: PersistedTransform): void {
  try { localStorage.setItem(TRANSFORM_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

export function clearPersistedTransform(): void {
  try { localStorage.removeItem(TRANSFORM_KEY); } catch { /* ignore */ }
}

/**
 * Debounced write of the SVG viewport transform so we don't hammer localStorage
 * on every mouse-move during pan/zoom.
 */
export function useTransformPersistence(
  transform: PersistedTransform,
  enabled = true,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      writePersistedTransform(transform);
    }, 400);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [transform, enabled]);
}
