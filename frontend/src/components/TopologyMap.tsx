import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { MouseEvent } from "react";
import type { TopologyResponse, DeviceSummary, AssetEvent } from "@librenms-dash/shared";
import { useForceLayout } from "@/hooks/useForceLayout";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useTransformPersistence, readPersistedTransform, clearPersistedTransform, consumeFitTransformRequest } from "@/hooks/usePersistedLayout";
import { SiteGroup, SiteControls, DeviceGroupBorder } from "./SiteGroup";
import { OverlayLinkLine } from "./OverlayLink";
import { HoverableLinkPath } from "./HoverableLinkPath";
import { DeviceNode } from "./DeviceNode";
import { ArpDeviceNode } from "./ArpDeviceNode";
import { DevicePopover } from "./DevicePopover";
import { LinkTooltip, type LinkTooltipData } from "./LinkTooltip";
import { curvedLinkPath, pointToPointPath, computeDominantSide, DEVICE_HALF, ARP_HALF, type Side } from "@/lib/linkGeometry";
import { Logo } from "./Logo";
import { AssetEventToast } from "./AssetEventToast";

interface SSEState {
  allEvents: AssetEvent[];
  connected: boolean;
}

interface Props {
  data: TopologyResponse;
  sse: SSEState;
}

const GRID_SIZE = 24;
const ALIGN_SNAP_DISTANCE = 10;
const LINK_HOVER_DELAY = 1000;

const NEIGHBOR_COLOR = "#38bdf8";
const ARP_COLOR = "#fbbf24";
const OVERLAY_PALETTE = [
  "#a78bfa", "#f472b6", "#34d399", "#fbbf24",
  "#60a5fa", "#fb923c", "#2dd4bf", "#c084fc",
  "#f87171", "#4ade80", "#38bdf8", "#e879f9",
];

function snapValue(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function formatMac(mac: string): string {
  const clean = mac.replace(/[:\-.]/g, "").toLowerCase();
  if (clean.length !== 12) return mac;
  return clean.match(/.{2}/g)!.join(":");
}

function normalizeMacSearch(input: string): string {
  return input.replace(/[:\-.\s]/g, "").toLowerCase();
}

function readViewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1200, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function snapToNearby(value: number, candidates: number[]): number | null {
  let best: number | null = null;
  let bestDistance = ALIGN_SNAP_DISTANCE + 1;
  for (const candidate of candidates) {
    const distance = Math.abs(value - candidate);
    if (distance <= ALIGN_SNAP_DISTANCE && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function TopologyMap({ data, sse }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  // Vertical space the floating top bars occupy, so the layout never places
  // content under them. Measured at runtime since the bars wrap (and grow
  // taller) on narrow screens.
  const [topInset, setTopInset] = useState(56);
  // True on devices with a real hover pointer (desktop); false on touch screens.
  const canHover = useMemo(
    () => typeof window === "undefined" || !window.matchMedia ? true : window.matchMedia("(hover: hover)").matches,
    [],
  );
  const [dimensions, setDimensions] = useState(readViewportSize);
  const [hoveredDevice, setHoveredDevice] = useState<{ hostname: string; x: number; y: number; icon: string } | null>(null);
  // Device shown in the mobile bottom sheet (touch devices only).
  const [infoDevice, setInfoDevice] = useState<{ hostname: string; icon: string } | null>(null);
  const [hoveredLink, setHoveredLink] = useState<LinkTooltipData | null>(null);
  const [hoveredLinkKey, setHoveredLinkKey] = useState<string | null>(null);
  // A discovered-device tooltip pinned open by a click (stays until dismissed).
  const [pinnedLink, setPinnedLink] = useState<LinkTooltipData | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // ── Persistent filter / toggle state ────────────────────────────────────────
  const [hiddenOverlays, setHiddenOverlays] = useLocalStorage<Record<string, boolean>>(
    "librenms-dash:hiddenOverlays:v2",
    {},
  );
  const [showNeighbors, setShowNeighbors] = useLocalStorage("librenms-dash:showNeighbors:v1", false);
  const [showArp, setShowArp] = useLocalStorage("librenms-dash:showArp:v1", false);
  const [showArpDevices, setShowArpDevices] = useLocalStorage("librenms-dash:showArpDevices:v1", false);
  const [snapToGrid, setSnapToGrid] = useLocalStorage("librenms-dash:snapToGrid:v1", false);
  const [isDragging, setIsDragging] = useState(false);
  // ── Ephemeral UI state (not persisted) ──────────────────────────────────────
  const linkDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkTooltipHovered = useRef(false);
  const linkHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAlertTooltip, setShowAlertTooltip] = useState(false);
  const [alertTooltipPos, setAlertTooltipPos] = useState({ x: 0, y: 0 });
  const alertHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertTooltipHovered = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCommitSha = useRef(data.commitSha);
  const [shaChanged, setShaChanged] = useState(false);

  useEffect(() => {
    if (prevCommitSha.current && data.commitSha && prevCommitSha.current !== data.commitSha) {
      setShaChanged(true);
      const timer = setTimeout(() => setShaChanged(false), 15000);
      prevCommitSha.current = data.commitSha;
      return () => clearTimeout(timer);
    }
    prevCommitSha.current = data.commitSha;
  }, [data.commitSha]);

  // After login, fit to screen instead of restoring a saved zoom/pan.
  const useFitTransformRef = useRef(consumeFitTransformRequest());
  // Seed viewport transform from localStorage on first render, then persist changes.
  const restoredTransformRef = useRef(
    useFitTransformRef.current ? null : readPersistedTransform(),
  );
  const [transform, setTransform] = useState(() => restoredTransformRef.current ?? { x: 0, y: 0, scale: 1 });
  const lastInitialScaleRef = useRef(1);
  // When a transform was restored from localStorage, don't let auto-fit override
  // it — so a refresh preserves the saved zoom/pan. Cleared on Reset Layout.
  const suppressAutoFit = useRef(restoredTransformRef.current != null);
  // Some user actions reflow the layout (changing initialScale) but should preserve
  // the current zoom/pan — toggling discovered devices and flipping a site's
  // orientation. Set just before such an action and consumed by the auto-fit effect
  // to skip the one resulting re-fit.
  const skipAutoFitOnceRef = useRef(false);
  // Debounce-write the transform so pan/zoom doesn't hammer localStorage on every frame.
  useTransformPersistence(transform);

  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  // True once a pan/drag actually moved, so the trailing click is ignored (a drag
  // that starts on a box must not also open that box's detail).
  const didPan = useRef(false);
  // The node whose detail box is currently pinned open (device hostname or ARP
  // mac), so hovering elsewhere reverts the highlight back to it on mouse-leave.
  const pinnedId = useRef<string | null>(null);
  // Touch-gesture state: last single-finger position (pan) and last 2-finger
  // distance (pinch). Only one is active at a time.
  const touchPan = useRef<{ x: number; y: number } | null>(null);
  const pinchDist = useRef<number | null>(null);
  const dragTarget = useRef<{
    type: "site" | "device" | "site-resize";
    id: string;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    startWidth?: number;
    startHeight?: number;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setDimensions({ width, height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track the top bars' height (they wrap on small screens) and reserve that
  // much space at the top of the layout, plus a small gap.
  useEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // offsetHeight includes the wrapper padding, so this is the full footprint.
      setTopInset((el.offsetHeight || 56) + 8);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const {
    nodes,
    links,
    neighborLinks,
    arpLinks,
    arpDeviceNodes,
    sites,
    deviceGroups,
    initialScale,
    resetLayout,
    moveSite,
    moveDevice,
    resizeSite,
    toggleSiteOrientation,
  } = useForceLayout(data, dimensions.width, dimensions.height, showArpDevices, topInset, isDragging);

  // When the layout regenerates (new topology, orientation change, reset), snap
  // the SVG transform back to the computed fit-scale so nothing overflows.
  useEffect(() => {
    if (initialScale === lastInitialScaleRef.current) return;
    lastInitialScaleRef.current = initialScale;
    if (skipAutoFitOnceRef.current) {
      // Discovered toggle reflowed the layout — keep the user's current zoom/pan.
      skipAutoFitOnceRef.current = false;
      return;
    }
    if (suppressAutoFit.current) return;
    setTransform({ x: 0, y: 0, scale: initialScale });
  }, [initialScale]);

  const deviceMap = useMemo(() => {
    const map = new Map<string, DeviceSummary>();
    for (const site of data.sites) {
      for (const dev of site.devices) {
        map.set(dev.hostname, dev);
      }
    }
    return map;
  }, [data.sites]);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();
    const qMac = normalizeMacSearch(q);
    const looksLikeMac = /^[0-9a-f]{2,}$/i.test(qMac) && qMac.length >= 4;
    const matches: string[] = [];

    for (const site of data.sites) {
      for (const dev of site.devices) {
        if (
          dev.hostname.toLowerCase().includes(qLower) ||
          dev.displayName.toLowerCase().includes(qLower) ||
          dev.sysName?.toLowerCase().includes(qLower) ||
          dev.ip?.includes(qLower) ||
          dev.lanIp?.includes(qLower) ||
          dev.ips?.some((ip) => ip.includes(qLower)) ||
          dev.allIps?.some((ip) => ip.includes(qLower)) ||
          dev.overlayPorts?.some((p) => p.ip?.includes(qLower)) ||
          (looksLikeMac && dev.macs?.some((m) => normalizeMacSearch(m).includes(qMac)))
        ) {
          matches.push(dev.hostname);
        }
      }
    }

    for (const ad of data.arpDevices ?? []) {
      if (
        ad.vendor?.toLowerCase().includes(qLower) ||
        ad.ips?.some((ip) => ip.includes(qLower)) ||
        (looksLikeMac && (
          normalizeMacSearch(ad.mac).includes(qMac) ||
          ad.macs?.some((m) => normalizeMacSearch(m).includes(qMac))
        ))
      ) {
        matches.push(ad.mac);
      }
    }

    return matches;
  }, [searchQuery, data.sites, data.arpDevices]);

  const [searchMatchIndex, setSearchMatchIndex] = useState(0);

  useEffect(() => {
    setSearchMatchIndex(0);
  }, [searchMatches]);

  const searchMatchId = searchMatches.length > 0 ? searchMatches[searchMatchIndex % searchMatches.length] : null;

  const centerOnMatch = useCallback((matchId: string) => {
    const node = nodes.find((n) => n.hostname === matchId);
    if (node) {
      setTransform((prev) => ({
        scale: prev.scale,
        x: dimensions.width / 2 - node.x * prev.scale,
        y: dimensions.height / 2 - node.y * prev.scale,
      }));
      return;
    }
    const arpNode = arpDeviceNodes.find((ad) => ad.mac === matchId);
    if (arpNode) {
      setTransform((prev) => ({
        scale: prev.scale,
        x: dimensions.width / 2 - arpNode.x * prev.scale,
        y: dimensions.height / 2 - arpNode.y * prev.scale,
      }));
    }
  }, [nodes, arpDeviceNodes, dimensions]);

  useEffect(() => {
    if (searchMatchId) centerOnMatch(searchMatchId);
  }, [searchMatchId, centerOnMatch]);

  const handleSearchEnter = useCallback(() => {
    if (searchMatches.length <= 1) return;
    setSearchMatchIndex((prev) => (prev + 1) % searchMatches.length);
  }, [searchMatches]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const displayName = useCallback((hostname: string) => {
    return deviceMap.get(hostname)?.displayName ?? hostname;
  }, [deviceMap]);

  const nodeByHostname = useMemo(() => {
    const map = new Map<string, (typeof nodes)[number]>();
    for (const node of nodes) map.set(node.hostname, node);
    return map;
  }, [nodes]);

  const overlayColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < (data?.overlays ?? []).length; i++) {
      const o = data!.overlays[i];
      map.set(`${o.overlayType}:${o.subnet}`, OVERLAY_PALETTE[i % OVERLAY_PALETTE.length]);
    }
    return map;
  }, [data]);

  const visibleLinks = useMemo(() =>
    links
      .filter((l) => !hiddenOverlays[l.overlayKey])
      .map((l) => {
        const c = overlayColorMap.get(l.overlayKey);
        return c && c !== l.color ? { ...l, color: c } : l;
      }),
    [links, hiddenOverlays, overlayColorMap],
  );

  // Pre-compute a single anchor side per device based on all its visible peers.
  const deviceSide = useMemo(() => {
    const peersMap = new Map<string, { x: number; y: number }[]>();
    const addPeer = (hostname: string, px: number, py: number) => {
      let arr = peersMap.get(hostname);
      if (!arr) { arr = []; peersMap.set(hostname, arr); }
      arr.push({ x: px, y: py });
    };
    // Overlay links
    for (const l of visibleLinks) {
      if (l.source.x != null && l.target.x != null) {
        addPeer(l.source.hostname, l.target.x, l.target.y);
        addPeer(l.target.hostname, l.source.x, l.source.y);
      }
    }
    // Neighbor links
    if (showNeighbors) {
      for (const nl of neighborLinks) {
        if (nl.source.x != null && nl.target.x != null) {
          addPeer(nl.source.hostname, nl.target.x, nl.target.y);
          addPeer(nl.target.hostname, nl.source.x, nl.source.y);
        }
      }
    }
    // ARP links
    if (showArp) {
      for (const al of arpLinks) {
        if (al.source.x != null && al.target.x != null) {
          addPeer(al.source.hostname, al.target.x, al.target.y);
          addPeer(al.target.hostname, al.source.x, al.source.y);
        }
      }
    }
    // ARP device connector links
    if (showArpDevices) {
      for (const ad of arpDeviceNodes) {
        addPeer(ad.seenByHostname, ad.x, ad.y);
      }
    }
    const result = new Map<string, Side>();
    for (const node of nodes) {
      const peers = peersMap.get(node.hostname);
      if (peers && peers.length > 0) {
        result.set(node.hostname, computeDominantSide(node.x, node.y, peers, DEVICE_HALF));
      }
    }
    // Also compute sides for ARP device nodes
    if (showArpDevices) {
      for (const ad of arpDeviceNodes) {
        const parent = nodeByHostname.get(ad.seenByHostname);
        if (parent) {
          result.set(ad.mac, computeDominantSide(ad.x, ad.y, [{ x: parent.x, y: parent.y }], ARP_HALF));
        }
      }
    }
    return result;
  }, [visibleLinks, showNeighbors, neighborLinks, showArp, arpLinks, showArpDevices, arpDeviceNodes, nodes, nodeByHostname]);

  const getSnapCandidates = useCallback((exclude?: { type: "site" | "device" | "site-resize"; id: string }) => {
    const x: number[] = [];
    const y: number[] = [];

    for (const site of sites) {
      if (exclude?.id === site.id && (exclude.type === "site" || exclude.type === "site-resize")) continue;
      x.push(site.x, site.x + site.width / 2, site.x + site.width);
      y.push(site.y, site.y + site.height / 2, site.y + site.height);
    }

    for (const group of deviceGroups) {
      if (exclude?.id === group.siteId && (exclude.type === "site" || exclude.type === "site-resize")) continue;
      x.push(group.x, group.x + group.width / 2, group.x + group.width);
      y.push(group.y, group.y + group.height / 2, group.y + group.height);
    }

    for (const node of nodes) {
      if (exclude?.id === node.hostname || (exclude?.id === node.siteId && exclude.type === "site")) continue;
      x.push(node.x);
      y.push(node.y);
    }

    return { x, y };
  }, [deviceGroups, nodes, sites]);

  const resolveSnap = useCallback((value: number, candidates: number[]) => {
    if (!snapToGrid) return value;
    return snapToNearby(value, candidates) ?? snapValue(value);
  }, [snapToGrid]);

  // Hovering only highlights a device's connected links now; the detail box is
  // opened by a click (see handleDeviceClick). On mouse-leave the highlight
  // reverts to whatever box is pinned open, if any.
  const handleDeviceHover = useCallback((hostname: string | null) => {
    setHighlightedId(hostname ?? pinnedId.current);
  }, []);

  // Dismiss any open detail box (managed-device popover or pinned discovered tooltip).
  const closeInfo = useCallback(() => {
    pinnedId.current = null;
    setHoveredDevice(null);
    setInfoDevice(null);
    setPinnedLink(null);
    setHighlightedId(null);
  }, []);

  // Click a managed device → open its detail box (floating popover on desktop,
  // bottom sheet on touch). Clicking the already-open device closes it (toggle).
  const handleDeviceClick = useCallback((hostname: string, e: MouseEvent<SVGGElement>) => {
    e.stopPropagation();
    if (didPan.current) return;
    const isOpen = canHover ? hoveredDevice?.hostname === hostname : infoDevice?.hostname === hostname;
    if (isOpen) { closeInfo(); return; }
    setPinnedLink(null); // never show a device popover and a pinned tooltip at once
    const icon = deviceMap.get(hostname)?.icon ?? "generic.svg";
    pinnedId.current = hostname;
    setHighlightedId(hostname);
    if (canHover) setHoveredDevice({ hostname, x: e.clientX, y: e.clientY, icon });
    else setInfoDevice({ hostname, icon });
  }, [canHover, hoveredDevice, infoDevice, deviceMap, closeInfo]);

  // Click a discovered (ARP) box → pin its info tooltip open (toggle).
  const handleArpClick = useCallback((mac: string, tooltipData: LinkTooltipData, e: MouseEvent) => {
    e.stopPropagation();
    if (didPan.current) return;
    if (linkHoverTimer.current) { clearTimeout(linkHoverTimer.current); linkHoverTimer.current = null; }
    if (linkDismissTimer.current) { clearTimeout(linkDismissTimer.current); linkDismissTimer.current = null; }
    const isOpen = pinnedLink?.targetHostname === mac;
    setHoveredDevice(null);
    setInfoDevice(null);
    pinnedId.current = isOpen ? null : mac;
    setHighlightedId(isOpen ? null : mac);
    setPinnedLink(isOpen ? null : tooltipData);
  }, [pinnedLink]);

  // --- Link hover handlers ---
  const showLinkTooltip = useCallback((key: string, tooltipData: LinkTooltipData) => {
    if (linkHoverTimer.current) clearTimeout(linkHoverTimer.current);
    if (linkDismissTimer.current) { clearTimeout(linkDismissTimer.current); linkDismissTimer.current = null; }
    linkHoverTimer.current = setTimeout(() => {
      linkTooltipHovered.current = false;
      setHoveredLink(tooltipData);
      setHoveredLinkKey(key);
    }, LINK_HOVER_DELAY);
    setHoveredLinkKey(key);
  }, []);

  const hideLinkTooltip = useCallback(() => {
    if (linkHoverTimer.current) { clearTimeout(linkHoverTimer.current); linkHoverTimer.current = null; }
    linkDismissTimer.current = setTimeout(() => {
      if (!linkTooltipHovered.current) {
        setHoveredLink(null);
        setHoveredLinkKey(null);
      }
    }, 150);
  }, []);

  const handleAlertEnter = useCallback((e: React.MouseEvent) => {
    if (alertHoverTimer.current) clearTimeout(alertHoverTimer.current);
    if (alertDismissTimer.current) { clearTimeout(alertDismissTimer.current); alertDismissTimer.current = null; }
    alertTooltipHovered.current = false;
    alertHoverTimer.current = setTimeout(() => {
      setAlertTooltipPos({ x: e.clientX, y: e.clientY });
      setShowAlertTooltip(true);
    }, LINK_HOVER_DELAY);
  }, []);

  const handleAlertLeave = useCallback(() => {
    if (alertHoverTimer.current) { clearTimeout(alertHoverTimer.current); alertHoverTimer.current = null; }
    alertDismissTimer.current = setTimeout(() => {
      if (!alertTooltipHovered.current) setShowAlertTooltip(false);
    }, 150);
  }, []);

  // Wheel + touch gestures. Attached as native, non-passive listeners (React's
  // synthetic onWheel/onTouch are passive, so preventDefault would be ignored)
  // so we can suppress the browser's own page scroll/zoom.
  //   • Ctrl+wheel / trackpad pinch  → zoom anchored at the cursor
  //   • plain wheel / 2-finger scroll → pan (both axes)
  //   • 1-finger touch drag           → pan
  //   • 2-finger touch pinch          → zoom anchored at the gesture midpoint
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const clamp = (s: number) => Math.min(Math.max(s, 0.2), 3);
    // Zoom by `factor` while keeping the point (px,py) — in container-relative
    // coordinates — fixed on screen.
    const zoomAt = (factor: number, px: number, py: number) =>
      setTransform((prev) => {
        const s = clamp(prev.scale * factor);
        const k = s / prev.scale;
        return { scale: s, x: px - (px - prev.x) * k, y: py - (py - prev.y) * k };
      });

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey) {
        // Trackpad pinch and Ctrl+wheel both arrive here; deltaY is the pinch amount.
        zoomAt(Math.exp(-e.deltaY * 0.003), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setTransform((prev) => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
      }
    };

    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchDist.current = dist(e.touches);
        touchPan.current = null;
      } else if (e.touches.length === 1) {
        touchPan.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        pinchDist.current = null;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const rect = el.getBoundingClientRect();
      if (e.touches.length === 2 && pinchDist.current != null) {
        e.preventDefault();
        const d = dist(e.touches);
        const ratio = d / pinchDist.current;
        pinchDist.current = d;
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        zoomAt(ratio, mx, my);
      } else if (e.touches.length === 1 && touchPan.current) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - touchPan.current.x;
        const dy = t.clientY - touchPan.current.y;
        touchPan.current = { x: t.clientX, y: t.clientY };
        setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        // A finger lifted after a pinch — hand off to single-finger panning.
        pinchDist.current = null;
        touchPan.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 0) {
        pinchDist.current = null;
        touchPan.current = null;
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const beginSiteDrag = useCallback((siteId: string, e: MouseEvent<SVGGElement>) => {
    if (!snapToGrid) return; // boxes are movable only while Grid is enabled
    const site = sites.find((s) => s.id === siteId);
    if (!site) return;
    e.preventDefault();
    e.stopPropagation();
    dragTarget.current = {
      type: "site",
      id: siteId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: site.x,
      startY: site.y,
      currentX: site.x,
      currentY: site.y,
    };
    setIsDragging(true);
    didPan.current = false;
    isPanning.current = false;
    setHoveredDevice(null);
  }, [sites, snapToGrid]);

  const beginDeviceDrag = useCallback((hostname: string, e: MouseEvent<SVGGElement>) => {
    if (!snapToGrid) return; // boxes are movable only while Grid is enabled
    const node = nodes.find((n) => n.hostname === hostname);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    dragTarget.current = {
      type: "device",
      id: hostname,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: node.x,
      startY: node.y,
      currentX: node.x,
      currentY: node.y,
    };
    setIsDragging(true);
    didPan.current = false;
    isPanning.current = false;
    setHoveredDevice(null);
  }, [nodes, snapToGrid]);

  const beginSiteResize = useCallback((siteId: string, e: MouseEvent<SVGGElement>) => {
    if (!snapToGrid) return; // boxes are resizable only while Grid is enabled
    const site = sites.find((s) => s.id === siteId);
    if (!site) return;
    e.preventDefault();
    e.stopPropagation();
    dragTarget.current = {
      type: "site-resize",
      id: siteId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: site.x,
      startY: site.y,
      currentX: site.x + site.width,
      currentY: site.y + site.height,
      startWidth: site.width,
      startHeight: site.height,
    };
    setIsDragging(true);
    didPan.current = false;
    isPanning.current = false;
    setHoveredDevice(null);
  }, [sites, snapToGrid]);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    // Box move/resize handlers stopPropagation, so if a mousedown reaches the SVG
    // it's either empty canvas or a box while editing is disabled — pan in both cases.
    didPan.current = false;
    isPanning.current = true;
    panStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  }, [transform]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (dragTarget.current) {
      const target = dragTarget.current;
      const candidates = getSnapCandidates({ type: target.type, id: target.id });

      if (target.type === "site-resize") {
        const rawRight = target.startX + (target.startWidth ?? 0) + (e.clientX - target.startClientX) / transform.scale;
        const rawBottom = target.startY + (target.startHeight ?? 0) + (e.clientY - target.startClientY) / transform.scale;
        const nextRight = resolveSnap(rawRight, candidates.x);
        const nextBottom = resolveSnap(rawBottom, candidates.y);
        if (nextRight === target.currentX && nextBottom === target.currentY) return;
        didPan.current = true;
        dragTarget.current = { ...target, currentX: nextRight, currentY: nextBottom };
        resizeSite(target.id, nextRight - target.startX, nextBottom - target.startY);
        return;
      }

      const rawX = target.startX + (e.clientX - target.startClientX) / transform.scale;
      const rawY = target.startY + (e.clientY - target.startClientY) / transform.scale;
      const nextX = resolveSnap(rawX, candidates.x);
      const nextY = resolveSnap(rawY, candidates.y);
      const dx = nextX - target.currentX;
      const dy = nextY - target.currentY;
      if (dx === 0 && dy === 0) return;
      didPan.current = true;
      dragTarget.current = { ...target, currentX: nextX, currentY: nextY };
      if (target.type === "site") {
        moveSite(target.id, dx, dy);
      } else {
        moveDevice(target.id, dx, dy);
      }
      return;
    }

    if (!isPanning.current) return;
    didPan.current = true;
    setTransform((prev) => ({
      ...prev,
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    }));
  }, [getSnapCandidates, moveDevice, moveSite, resizeSite, resolveSnap, transform.scale]);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
    setIsDragging(false);
    dragTarget.current = null;
  }, []);

  // A click on empty canvas (devices/boxes stopPropagation) dismisses any open
  // detail box; a real drag-pan sets didPan so the trailing click is ignored.
  const handleCanvasClick = useCallback(() => {
    if (didPan.current) return;
    closeInfo();
  }, [closeInfo]);

  // Escape also dismisses the open detail box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeInfo(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeInfo]);

  const toggleOverlay = useCallback((type: string) => {
    setHiddenOverlays((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  const handleReset = useCallback(() => {
    // Reset Layout should also discard a saved zoom/pan and snap back to fit.
    suppressAutoFit.current = false;
    skipAutoFitOnceRef.current = false;
    clearPersistedTransform();
    resetLayout();
    setTransform({ x: 0, y: 0, scale: initialScale });
  }, [resetLayout, initialScale]);

  const toggleArpDevices = useCallback(() => {
    // Reflow the layout to make room for discovered devices, but keep the current
    // zoom/pan instead of snapping back to fit.
    skipAutoFitOnceRef.current = true;
    setShowArpDevices((v) => !v);
  }, [setShowArpDevices]);

  // Per-location counts shown in each site header. Neighbor/ARP links are always
  // computed (independent of the visibility toggles); discovered devices come
  // straight from the source data so the count shows even when the layer is off.
  const siteStats = useMemo(() => {
    const map = new Map<string, { lldp: number; arp: number; discovered: number; routes: number }>();
    const bucket = (id: string) => {
      let s = map.get(id);
      if (!s) { s = { lldp: 0, arp: 0, discovered: 0, routes: 0 }; map.set(id, s); }
      return s;
    };
    for (const site of data.sites) {
      const b = bucket(site.id);
      const seen = new Set<string>();
      for (const dev of site.devices) {
        for (const r of dev.routes ?? []) {
          const key = `${r.dest}/${r.prefix}>${r.nextHop}`;
          if (!seen.has(key)) { seen.add(key); b.routes++; }
        }
      }
    }
    for (const nl of neighborLinks) {
      for (const id of new Set([nl.source.siteId, nl.target.siteId])) bucket(id).lldp++;
    }
    for (const al of arpLinks) {
      for (const id of new Set([al.source.siteId, al.target.siteId])) bucket(id).arp++;
    }
    for (const ad of (data.arpDevices ?? [])) bucket(ad.siteId).discovered++;
    return map;
  }, [neighborLinks, arpLinks, data.arpDevices, data.sites]);

  const totalRoutes = useMemo(() => {
    const seen = new Set<string>();
    for (const site of data.sites) {
      for (const dev of site.devices) {
        for (const r of dev.routes ?? []) {
          seen.add(`${r.dest}/${r.prefix}>${r.nextHop}`);
        }
      }
    }
    return seen.size;
  }, [data.sites]);

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {/* Top floating bars — single flex row keeps left/right bars equal-height
          (items-stretch) and never overlapping (justify-between; outer flex-wrap
          drops the right bar below the left on very narrow screens). The wrapper
          is pointer-transparent so panning still works in the gap between bars. */}
      <div ref={topBarRef} className="absolute top-0 inset-x-0 z-10 p-4 flex flex-wrap items-stretch justify-between gap-3 pointer-events-none max-w-[calc(100%-72px)]">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 bg-gray-900/90 backdrop-blur border border-gray-700 rounded-lg px-4 py-2 pointer-events-auto">
        <button
          onClick={() => setShowNeighbors((v) => !v)}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
            showNeighbors ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
          }`}
        >
          <span className="w-3 h-0.5 inline-block rounded" style={{ backgroundColor: NEIGHBOR_COLOR, opacity: showNeighbors ? 1 : 0.3 }} />
          LLDP/CDP ({neighborLinks.length})
        </button>
        <button
          onClick={() => setShowArp((v) => !v)}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
            showArp ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
          }`}
        >
          <span className="w-3 h-0.5 inline-block rounded" style={{ backgroundColor: ARP_COLOR, opacity: showArp ? 1 : 0.3 }} />
          ARP ({arpLinks.length})
        </button>
        <button
          onClick={toggleArpDevices}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
            showArpDevices ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
          }`}
        >
          <span
            className="w-2.5 h-2.5 inline-block rounded-sm border"
            style={{ borderColor: ARP_COLOR, opacity: showArpDevices ? 1 : 0.3 }}
          />
          Discovered ({data.arpDevices?.length ?? 0})
        </button>
        <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-gray-800 text-gray-400">
          <span className="w-2 h-2 inline-block rounded-full" style={{ backgroundColor: "#34d399" }} />
          Routes ({totalRoutes})
        </span>
        <span className="text-gray-600">|</span>
        <span className="text-xs text-gray-400 font-semibold mr-2">Overlays:</span>
        {data.overlays.map((o, i) => {
          const key = `${o.overlayType}:${o.subnet}`;
          const color = OVERLAY_PALETTE[i % OVERLAY_PALETTE.length];
          const visible = !hiddenOverlays[key];
          return (
            <button
              key={key}
              onClick={() => toggleOverlay(key)}
              className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
                visible ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
              }`}
            >
              <span className="flex flex-col items-start leading-tight">
                <span>{o.label.replace(/\s*\(.*\)\s*$/, "")} ({o.links.length})</span>
                <span
                  className="text-[10px] font-mono font-bold"
                  style={{ color: visible ? color : undefined, opacity: visible ? 1 : 0.5 }}
                >{o.subnet}</span>
              </span>
            </button>
          );
        })}
        <button
          onClick={() => setSnapToGrid((v) => !v)}
          title="Enable to move and resize boxes (with grid snapping)"
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ml-2 ${
            snapToGrid ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
          }`}
        >
          <span className="grid grid-cols-2 gap-0.5">
            <span className="w-1 h-1 rounded-sm bg-current" />
            <span className="w-1 h-1 rounded-sm bg-current" />
            <span className="w-1 h-1 rounded-sm bg-current" />
            <span className="w-1 h-1 rounded-sm bg-current" />
          </span>
          Edit Layout
        </button>
        <button
          onClick={handleReset}
          className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        >
          Reset Layout
        </button>
      </div>

      {/* Status + Search */}
      <div className="flex flex-wrap items-center gap-4 bg-gray-900/90 backdrop-blur border border-gray-700 rounded-lg px-4 py-2 text-xs pointer-events-auto">
        <span className="text-gray-400">
          {data.sites.length} sites, {data.sites.reduce((s, site) => s + site.devices.length, 0)} devices
        </span>
        {data.alerts.length > 0 && (
          <span
            className="text-red-400 font-semibold cursor-default"
            onMouseEnter={handleAlertEnter}
            onMouseLeave={handleAlertLeave}
          >
            {data.alerts.length} alert{data.alerts.length > 1 ? "s" : ""}
          </span>
        )}
        <span className="text-gray-500">Updated {new Date(data.lastUpdated).toLocaleTimeString()}</span>
        <span className="text-gray-700">|</span>
        {searchOpen ? (
          <span className="flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setSearchQuery(""); setSearchOpen(false); }
                if (e.key === "Enter") handleSearchEnter();
                e.stopPropagation();
              }}
              placeholder="Name, IP, or MAC..."
              className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-gray-200 placeholder-gray-500 outline-none focus:border-yellow-500 w-44"
              autoFocus
            />
            {searchQuery && searchMatches.length === 0 && (
              <span className="text-red-400">No match</span>
            )}
            {searchQuery && searchMatches.length === 1 && (
              <span className="text-green-400">1 match</span>
            )}
            {searchQuery && searchMatches.length > 1 && (
              <span className="text-yellow-400 tabular-nums">
                {(searchMatchIndex % searchMatches.length) + 1}/{searchMatches.length}
                <span className="text-gray-500 ml-1">↵</span>
              </span>
            )}
            <button
              onClick={() => { setSearchQuery(""); setSearchOpen(false); }}
              className="text-gray-500 hover:text-gray-300 ml-0.5"
              title="Close search"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>
        ) : (
          <button
            onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); }}
            className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors"
            title="Search devices (Ctrl+F)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Search
          </button>
        )}
      </div>
      </div>

      {/* SVG */}
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleCanvasClick}
        style={{ cursor: dragTarget.current ? "move" : isPanning.current ? "grabbing" : "grab", touchAction: "none" }}
      >
        <defs>
          <pattern id="topology-grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" stroke="#334155" strokeWidth={0.8} strokeOpacity={0.35} />
          </pattern>
        </defs>
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          {snapToGrid && (
            <rect
              x={-4000}
              y={-4000}
              width={12000}
              height={12000}
              fill="url(#topology-grid)"
              pointerEvents="none"
            />
          )}

          {/* Site boxes */}
          {sites.map((site, i) => (
            <SiteGroup
              key={site.id}
              site={site}
              index={i}
              interactive={snapToGrid}
              stats={siteStats.get(site.id)}
              onMouseDown={(e) => beginSiteDrag(site.id, e)}
              onResizeMouseDown={(e) => beginSiteResize(site.id, e)}
            />
          ))}

          {/* Device group boundaries */}
          {deviceGroups.map((g) => (
            <DeviceGroupBorder key={`${g.siteId}-${g.os}`} group={g} />
          ))}

          {/* Neighbor (LLDP/CDP) links */}
          {showNeighbors && neighborLinks.map((nl) => {
            const sx = nl.source.x;
            const sy = nl.source.y;
            const tx = nl.target.x;
            const ty = nl.target.y;
            if (sx == null || sy == null || tx == null || ty == null) return null;
            const key = `nl-${nl.source.hostname}-${nl.target.hostname}-${nl.localPort}`;
            const linked = highlightedId === nl.source.hostname || highlightedId === nl.target.hostname;
            return (
              <HoverableLinkPath
                key={key}
                linkKey={key}
                sx={sx} sy={sy} tx={tx} ty={ty}
                color={NEIGHBOR_COLOR}
                hovered={hoveredLinkKey === key}
                highlighted={linked}
                sourceSide={deviceSide.get(nl.source.hostname)}
                targetSide={deviceSide.get(nl.target.hostname)}
                onMouseEnter={(e) => showLinkTooltip(key, {
                  type: "lldp",
                  screenX: e.clientX,
                  screenY: e.clientY,
                  sourceHostname: nl.source.hostname,
                  targetHostname: nl.target.hostname,
                  sourceDisplayName: displayName(nl.source.hostname),
                  targetDisplayName: displayName(nl.target.hostname),
                  color: NEIGHBOR_COLOR,
                  localPort: nl.localPort,
                  remotePort: nl.remotePort,
                  sourceInterface: nl.localPort,
                  targetInterface: nl.remotePort,
                  protocol: nl.protocol,
                })}
                onMouseLeave={hideLinkTooltip}
              />
            );
          })}

          {/* ARP links */}
          {showArp && arpLinks.map((al) => {
            const sx = al.source.x;
            const sy = al.source.y;
            const tx = al.target.x;
            const ty = al.target.y;
            if (sx == null || sy == null || tx == null || ty == null) return null;
            const key = `arp-${al.source.hostname}-${al.target.hostname}`;
            const linked = highlightedId === al.source.hostname || highlightedId === al.target.hostname;
            return (
              <HoverableLinkPath
                key={key}
                linkKey={key}
                sx={sx} sy={sy} tx={tx} ty={ty}
                color={ARP_COLOR}
                hovered={hoveredLinkKey === key}
                highlighted={linked}
                sourceSide={deviceSide.get(al.source.hostname)}
                targetSide={deviceSide.get(al.target.hostname)}
                onMouseEnter={(e) => showLinkTooltip(key, {
                  type: "arp",
                  screenX: e.clientX,
                  screenY: e.clientY,
                  sourceHostname: al.source.hostname,
                  targetHostname: al.target.hostname,
                  sourceDisplayName: displayName(al.source.hostname),
                  targetDisplayName: displayName(al.target.hostname),
                  color: ARP_COLOR,
                  sourceIp: al.fromIp,
                  sourceInterface: al.fromInterface,
                  targetIp: al.toIp,
                  targetInterface: al.toInterface,
                  mac: formatMac(al.fromMac ?? al.mac),
                  targetMac: al.toMac ? formatMac(al.toMac) : undefined,
                })}
                onMouseLeave={hideLinkTooltip}
              />
            );
          })}

          {/* Overlay links */}
          {visibleLinks.map((link) => {
            const key = `ol-${link.overlayType}-${link.source.hostname}-${link.target.hostname}`;
            const linked = highlightedId === link.source.hostname || highlightedId === link.target.hostname;
            const srcDev = deviceMap.get(link.source.hostname);
            const tgtDev = deviceMap.get(link.target.hostname);
            const srcOverlayIp = link.fromIp
              || srcDev?.overlayPorts?.find((p) => p.overlayType === link.overlayType)?.ip
              || "";
            const tgtOverlayIp = link.toIp
              || tgtDev?.overlayPorts?.find((p) => p.overlayType === link.overlayType)?.ip
              || "";
            return (
              <OverlayLinkLine
                key={key}
                link={link}
                hovered={hoveredLinkKey === key}
                highlighted={linked}
                sourceSide={deviceSide.get(link.source.hostname)}
                targetSide={deviceSide.get(link.target.hostname)}
                onMouseEnter={(e) => showLinkTooltip(key, {
                  type: "overlay",
                  screenX: e.clientX,
                  screenY: e.clientY,
                  sourceHostname: link.source.hostname,
                  targetHostname: link.target.hostname,
                  sourceDisplayName: displayName(link.source.hostname),
                  targetDisplayName: displayName(link.target.hostname),
                  color: link.color,
                  overlayType: link.overlayType,
                  sourceIp: srcOverlayIp,
                  targetIp: tgtOverlayIp,
                  sourceInterface: link.fromIface,
                  targetInterface: link.toIface,
                })}
                onMouseLeave={hideLinkTooltip}
              />
            );
          })}

          {/* Devices */}
          {nodes.map((node) => (
            <DeviceNode
              key={node.id}
              node={node}
              device={deviceMap.get(node.hostname)}
              interactive={snapToGrid}
              highlighted={highlightedId === node.hostname}
              searchMatch={searchMatchId === node.hostname}
              onHover={handleDeviceHover}
              onMouseDown={(e) => beginDeviceDrag(node.hostname, e)}
              onClick={(e) => handleDeviceClick(node.hostname, e)}
            />
          ))}

          {/* ARP discovered-device connector lines — link each discovered device
              back to the managed device that saw it in its ARP table. */}
          {showArpDevices && arpDeviceNodes.map((ad) => {
            const parent = nodeByHostname.get(ad.seenByHostname);
            if (!parent || parent.x == null || parent.y == null) return null;
            const d = pointToPointPath(
              parent.x, parent.y,
              ad.x, ad.y,
              deviceSide.get(ad.seenByHostname),
              deviceSide.get(ad.mac),
            );
            const key = `arpdev-link-${ad.mac}`;
            const hovered = hoveredLinkKey === key;
            const linked = highlightedId === ad.seenByHostname || highlightedId === ad.mac;
            const parentDev = deviceMap.get(ad.seenByHostname);
            return (
              <g key={key}>
                {/* Wide invisible hit area */}
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={12}
                  fill="none"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => showLinkTooltip(key, {
                    type: "arp-device",
                    screenX: e.clientX,
                    screenY: e.clientY,
                    sourceHostname: ad.seenByHostname,
                    targetHostname: ad.mac,
                    sourceDisplayName: displayName(ad.seenByHostname),
                    targetDisplayName: ad.vendor || "Unknown device",
                    color: ARP_COLOR,
                    sourceIp: ad.seenByIp ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
                    targetIps: ad.ips,
                    mac: formatMac(ad.mac),
                    interface: ad.seenByInterface,
                    sourceMac: ad.seenByMac ? formatMac(ad.seenByMac) : undefined,
                    vendor: ad.vendor,
                  })}
                  onMouseLeave={hideLinkTooltip}
                />
                <path
                  d={d}
                  stroke={ARP_COLOR}
                  strokeWidth={hovered || linked ? 2 : 1}
                  strokeOpacity={hovered || linked ? 0.9 : 0.35}
                  strokeDasharray="3 3"
                  fill="none"
                  pointerEvents="none"
                />
              </g>
            );
          })}

          {/* ARP Discovered Devices */}
          {showArpDevices && arpDeviceNodes.map((ad) => {
            const parentDev = deviceMap.get(ad.seenByHostname);
            const tooltip = (e: { clientX: number; clientY: number }): LinkTooltipData => ({
              type: "arp-device",
              screenX: e.clientX,
              screenY: e.clientY,
              sourceHostname: ad.seenByHostname,
              targetHostname: ad.mac,
              sourceDisplayName: displayName(ad.seenByHostname),
              targetDisplayName: ad.vendor || "Unknown device",
              color: ARP_COLOR,
              sourceIp: ad.seenByIp ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
              targetIps: ad.ips,
              mac: formatMac(ad.mac),
              interface: ad.seenByInterface,
              sourceMac: ad.seenByMac ? formatMac(ad.seenByMac) : undefined,
              vendor: ad.vendor,
            });
            return (
              <ArpDeviceNode
                key={ad.mac}
                node={ad}
                highlighted={highlightedId === ad.mac || highlightedId === ad.seenByHostname}
                searchMatch={searchMatchId === ad.mac}
                onMouseEnter={() => setHighlightedId(ad.mac)}
                onMouseLeave={() => setHighlightedId(pinnedId.current)}
                onClick={(e) => handleArpClick(ad.mac, tooltip(e), e)}
              />
            );
          })}

          {/* ARP Discovered section labels */}
          {showArpDevices && (() => {
            const siteIds = new Set(arpDeviceNodes.map((n) => n.siteId));
            return [...siteIds].map((siteId) => {
              const siteDevices = arpDeviceNodes.filter((n) => n.siteId === siteId);
              if (siteDevices.length === 0) return null;
              const minY = Math.min(...siteDevices.map((n) => n.y)) - 21 - 8;
              const site = sites.find((s) => s.id === siteId);
              const labelX = (site?.x ?? 0) + 16 + 8;
              return (
                <text
                  key={`arp-label-${siteId}`}
                  x={labelX}
                  y={minY + 11}
                  fill="#fbbf24"
                  fillOpacity={0.6}
                  fontSize={9}
                  fontWeight={600}
                  fontFamily="system-ui, sans-serif"
                >
                  Discovered ({siteDevices.length})
                </text>
              );
            });
          })()}

          {/* Site orientation controls — rendered last so they sit above links */}
          {sites.map((site, i) => (
            <SiteControls
              key={`ctrl-${site.id}`}
              site={site}
              index={i}
              onToggleOrientation={(e) => {
                e.stopPropagation();
                // Re-orienting reflows the layout (changing initialScale) — keep the
                // user's current zoom/pan instead of snapping back to fit.
                skipAutoFitOnceRef.current = true;
                toggleSiteOrientation(site.id);
              }}
            />
          ))}

        </g>
      </svg>

      {/* Device popover — click-pinned: stays open until you click the device
          again, click empty canvas, or press Escape (so moving the mouse onto it
          to read/scroll doesn't dismiss it). */}
      {hoveredDevice && (
        <DevicePopover
          hostname={hoveredDevice.hostname}
          icon={hoveredDevice.icon}
          screenX={hoveredDevice.x}
          screenY={hoveredDevice.y}
          onMouseEnter={() => {}}
          onMouseLeave={() => {}}
          onClose={closeInfo}
        />
      )}

      {/* Touch: "View details" chip — appears when a device is tapped/highlighted
          and the bottom sheet isn't already open. Tapping it opens the sheet. */}
      {!canHover && !infoDevice && highlightedId && deviceMap.has(highlightedId) && (
        <button
          onClick={() => setInfoDevice({ hostname: highlightedId, icon: deviceMap.get(highlightedId)?.icon ?? "generic.svg" })}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-sky-600 text-white text-sm font-semibold rounded-full shadow-lg px-4 py-2.5"
        >
          <span className="w-4 h-4 flex items-center justify-center rounded-full border border-white text-xs">i</span>
          View {displayName(highlightedId)} details
        </button>
      )}

      {/* Touch: device details as a bottom sheet that leaves the canvas visible. */}
      {!canHover && infoDevice && (
        <DevicePopover
          hostname={infoDevice.hostname}
          icon={infoDevice.icon}
          screenX={0}
          screenY={0}
          bottomSheet
          onMouseEnter={() => {}}
          onMouseLeave={() => {}}
          onClose={() => setInfoDevice(null)}
        />
      )}

      {/* Link tooltip. A pinned discovered-device tooltip (set by clicking the box)
          takes priority and ignores hover-leave; dismiss it via canvas click or
          Escape. Otherwise it's the transient hover tooltip for links. */}
      {(pinnedLink ?? hoveredLink) && (
        <LinkTooltip
          data={pinnedLink ?? hoveredLink!}
          onMouseEnter={pinnedLink ? () => {} : () => {
            linkTooltipHovered.current = true;
            if (linkDismissTimer.current) { clearTimeout(linkDismissTimer.current); linkDismissTimer.current = null; }
          }}
          onMouseLeave={pinnedLink ? () => {} : () => {
            linkTooltipHovered.current = false;
            setHoveredLink(null);
            setHoveredLinkKey(null);
          }}
        />
      )}

      {/* Alert tooltip */}
      {showAlertTooltip && data.alerts.length > 0 && (
        <div
          className="fixed z-50 bg-gray-900 border border-red-700 rounded-lg shadow-2xl px-3 py-2.5 text-xs text-gray-200 min-w-[280px] max-w-[400px] max-h-[360px] overflow-y-auto"
          style={{
            left: Math.min(alertTooltipPos.x + 16, window.innerWidth - 420),
            top: Math.max(8, Math.min(alertTooltipPos.y + 8, window.innerHeight - 380)),
          }}
          onMouseEnter={() => {
            alertTooltipHovered.current = true;
            if (alertDismissTimer.current) { clearTimeout(alertDismissTimer.current); alertDismissTimer.current = null; }
          }}
          onMouseLeave={() => {
            alertTooltipHovered.current = false;
            setShowAlertTooltip(false);
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-red-500" />
            <span className="font-bold text-sm text-red-400">
              Active Alerts ({data.alerts.length})
            </span>
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.06)" }}>
                <th className="py-1 px-2 text-left text-gray-400 font-semibold">Device</th>
                <th className="py-1 px-2 text-left text-gray-400 font-semibold">Rule</th>
                <th className="py-1 px-2 text-left text-gray-400 font-semibold">Severity</th>
                <th className="py-1 px-2 text-right text-gray-400 font-semibold">Time</th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map((a, i) => (
                <tr key={a.id} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                  <td className="py-1 px-2 text-gray-200 whitespace-nowrap">
                    {displayName(a.hostname)}
                  </td>
                  <td className="py-1 px-2 text-red-300 break-words max-w-[180px]">{a.rule}</td>
                  <td className="py-1 px-2 text-gray-300 whitespace-nowrap capitalize">{a.severity}</td>
                  <td className="py-1 px-2 text-gray-400 whitespace-nowrap text-right font-mono">
                    {a.timestamp ? new Date(a.timestamp.replace(" ", "T")).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top-right: Logo */}
      <div className="absolute top-4 right-4 z-10 pointer-events-none">
        <Logo size={48} />
      </div>

      {/* Asset change toasts — above copyright bar */}
      <AssetEventToast allEvents={sse.allEvents} connected={sse.connected} />

      {/* Bottom-right: GPLv3 copyright, GitHub link, commit SHA */}
      <div className="absolute bottom-2 right-2 z-10 pointer-events-auto flex items-center gap-2 text-[10px] text-gray-500">
        <span>© {new Date().getFullYear()} GPLv3</span>
        <span className="text-gray-700">·</span>
        <a
          href="https://github.com/jaykumar2001/Librenms-dash"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-300 transition-colors underline underline-offset-2"
        >
          GitHub
        </a>
        {data.commitSha && (
          <>
            <span className="text-gray-700">·</span>
            <a
              href={`https://github.com/jaykumar2001/Librenms-dash/commit/${data.commitSha}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-mono transition-colors ${shaChanged ? "text-yellow-400 font-bold animate-pulse" : "hover:text-gray-300"}`}
            >
              {data.commitSha}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
