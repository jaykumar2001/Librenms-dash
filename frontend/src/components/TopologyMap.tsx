import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { MouseEvent, WheelEvent } from "react";
import type { TopologyResponse, DeviceSummary } from "@librenms-dash/shared";
import { useForceLayout } from "@/hooks/useForceLayout";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useTransformPersistence, readPersistedTransform } from "@/hooks/usePersistedLayout";
import { SiteGroup, SiteControls, DeviceGroupBorder } from "./SiteGroup";
import { OverlayLinkLine } from "./OverlayLink";
import { HoverableLinkPath } from "./HoverableLinkPath";
import { DeviceNode } from "./DeviceNode";
import { ArpDeviceNode } from "./ArpDeviceNode";
import { DevicePopover } from "./DevicePopover";
import { LinkTooltip, type LinkTooltipData } from "./LinkTooltip";
import { curvedLinkPath, pointToPointPath, computeDominantSide, DEVICE_HALF, ARP_HALF, type Side } from "@/lib/linkGeometry";

interface Props {
  data: TopologyResponse;
}

const GRID_SIZE = 24;
const ALIGN_SNAP_DISTANCE = 10;
const LINK_HOVER_DELAY = 1000;

const NEIGHBOR_COLOR = "#38bdf8";
const ARP_COLOR = "#fbbf24";
const OVERLAY_COLORS: Record<string, string> = {
  zerotier: "#a855f7",
  wireguard: "#f87171",
  tailscale: "#22d3ee",
};

function snapValue(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function formatMac(mac: string): string {
  const clean = mac.replace(/[:\-.]/g, "").toLowerCase();
  if (clean.length !== 12) return mac;
  return clean.match(/.{2}/g)!.join(":");
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

export function TopologyMap({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // True on devices with a real hover pointer (desktop); false on touch screens.
  const canHover = useMemo(
    () => typeof window === "undefined" || !window.matchMedia ? true : window.matchMedia("(hover: hover)").matches,
    [],
  );
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });
  const [hoveredDevice, setHoveredDevice] = useState<{ hostname: string; x: number; y: number; icon: string } | null>(null);
  const [hoveredLink, setHoveredLink] = useState<LinkTooltipData | null>(null);
  const [hoveredLinkKey, setHoveredLinkKey] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // ── Persistent filter / toggle state ────────────────────────────────────────
  const [hiddenOverlays, setHiddenOverlays] = useLocalStorage<Record<string, boolean>>(
    "librenms-dash:hiddenOverlays:v1",
    { zerotier: true, wireguard: true, tailscale: true },
  );
  const [showNeighbors, setShowNeighbors] = useLocalStorage("librenms-dash:showNeighbors:v1", false);
  const [showArp, setShowArp] = useLocalStorage("librenms-dash:showArp:v1", false);
  const [showArpDevices, setShowArpDevices] = useLocalStorage("librenms-dash:showArpDevices:v1", false);
  const [snapToGrid, setSnapToGrid] = useLocalStorage("librenms-dash:snapToGrid:v1", false);
  // ── Ephemeral UI state (not persisted) ──────────────────────────────────────
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverHovered = useRef(false);
  const deviceHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkTooltipHovered = useRef(false);
  const linkHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAlertTooltip, setShowAlertTooltip] = useState(false);
  const [alertTooltipPos, setAlertTooltipPos] = useState({ x: 0, y: 0 });
  const alertHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertTooltipHovered = useRef(false);

  // Seed viewport transform from localStorage on first render, then persist changes.
  const [transform, setTransform] = useState(() => readPersistedTransform() ?? { x: 0, y: 0, scale: 1 });
  const lastInitialScaleRef = useRef(1);
  // Debounce-write the transform so pan/zoom doesn't hammer localStorage on every frame.
  useTransformPersistence(transform);

  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
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
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
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
  } = useForceLayout(data, dimensions.width, dimensions.height, showArpDevices);

  // When the layout regenerates (new topology, orientation change, reset), snap
  // the SVG transform back to the computed fit-scale so nothing overflows.
  useEffect(() => {
    if (initialScale === lastInitialScaleRef.current) return;
    lastInitialScaleRef.current = initialScale;
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

  const displayName = useCallback((hostname: string) => {
    return deviceMap.get(hostname)?.displayName ?? hostname;
  }, [deviceMap]);

  const nodeByHostname = useMemo(() => {
    const map = new Map<string, (typeof nodes)[number]>();
    for (const node of nodes) map.set(node.hostname, node);
    return map;
  }, [nodes]);

  const visibleLinks = links.filter((l) => !hiddenOverlays[l.overlayType]);

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

  const handleDeviceHover = useCallback((hostname: string | null, x: number, y: number) => {
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
    if (hostname) {
      if (deviceHoverTimer.current) clearTimeout(deviceHoverTimer.current);
      popoverHovered.current = false;
      setHighlightedId(hostname);
      // On touch devices a tap fires synthetic hover; the full popover would
      // cover the highlighted links, so only highlight and skip the popover.
      if (canHover) {
        deviceHoverTimer.current = setTimeout(() => {
          const dev = deviceMap.get(hostname);
          setHoveredDevice({ hostname, x, y, icon: dev?.icon ?? "generic.svg" });
        }, LINK_HOVER_DELAY);
      }
    } else {
      if (deviceHoverTimer.current) { clearTimeout(deviceHoverTimer.current); deviceHoverTimer.current = null; }
      dismissTimer.current = setTimeout(() => {
        if (!popoverHovered.current) {
          setHoveredDevice(null);
          setHighlightedId(null);
        }
      }, 150);
    }
  }, [deviceMap, canHover]);

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

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    setTransform((prev) => {
      const s = Math.min(Math.max(prev.scale * factor, 0.2), 3);
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { ...prev, scale: s };
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      return { scale: s, x: mx - (mx - prev.x) * (s / prev.scale), y: my - (my - prev.y) * (s / prev.scale) };
    });
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
    isPanning.current = false;
    setHoveredDevice(null);
  }, [sites, snapToGrid]);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    // Box move/resize handlers stopPropagation, so if a mousedown reaches the SVG
    // it's either empty canvas or a box while editing is disabled — pan in both cases.
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
      dragTarget.current = { ...target, currentX: nextX, currentY: nextY };
      if (target.type === "site") {
        moveSite(target.id, dx, dy);
      } else {
        moveDevice(target.id, dx, dy);
      }
      return;
    }

    if (!isPanning.current) return;
    setTransform((prev) => ({
      ...prev,
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    }));
  }, [getSnapCandidates, moveDevice, moveSite, resizeSite, resolveSnap, transform.scale]);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
    dragTarget.current = null;
  }, []);

  const toggleOverlay = useCallback((type: string) => {
    setHiddenOverlays((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {/* Top floating bars — single flex row keeps left/right bars equal-height
          (items-stretch) and never overlapping (justify-between; outer flex-wrap
          drops the right bar below the left on very narrow screens). The wrapper
          is pointer-transparent so panning still works in the gap between bars. */}
      <div className="absolute top-0 inset-x-0 z-10 p-4 flex flex-wrap items-stretch justify-between gap-3 pointer-events-none">
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
          onClick={() => setShowArpDevices((v) => !v)}
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
        <button
          onClick={() => setSnapToGrid((v) => !v)}
          title="Enable to move and resize boxes (with grid snapping)"
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
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
        <span className="text-gray-600">|</span>
        <span className="text-xs text-gray-400 font-semibold mr-2">Overlays:</span>
        {data.overlays.map((o) => {
          const visible = !hiddenOverlays[o.type];
          const color = OVERLAY_COLORS[o.type] ?? "#666";
          return (
            <button
              key={o.type}
              onClick={() => toggleOverlay(o.type)}
              className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
                visible ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500"
              }`}
            >
              <span
                className="w-3 h-0.5 inline-block rounded"
                style={{ backgroundColor: color, opacity: visible ? 1 : 0.3 }}
              />
              {o.type} ({o.links.length})
            </button>
          );
        })}
        <button
          onClick={resetLayout}
          className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors ml-2"
        >
          Reset Layout
        </button>
      </div>

      {/* Status */}
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
      </div>
      </div>

      {/* SVG */}
      <svg
        width={dimensions.width}
        height={dimensions.height}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragTarget.current ? "move" : isPanning.current ? "grabbing" : "grab" }}
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
                  targetIp: al.toIp,
                  targetInterface: al.toInterface,
                  mac: formatMac(al.mac),
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
              onHover={handleDeviceHover}
              onMouseDown={(e) => beginDeviceDrag(node.hostname, e)}
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
                    sourceIp: parentDev?.ips?.[0] ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
                    targetIp: ad.ips.join(", "),
                    mac: formatMac(ad.mac),
                    interface: ad.seenByInterface,
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
            const key = `arpdev-${ad.mac}`;
            const parentDev = deviceMap.get(ad.seenByHostname);
            return (
              <ArpDeviceNode
                key={ad.mac}
                node={ad}
                highlighted={highlightedId === ad.mac || highlightedId === ad.seenByHostname}
                onMouseEnter={(e) => { setHighlightedId(ad.mac); showLinkTooltip(key, {
                  type: "arp-device",
                  screenX: e.clientX,
                  screenY: e.clientY,
                  sourceHostname: ad.seenByHostname,
                  targetHostname: ad.mac,
                  sourceDisplayName: displayName(ad.seenByHostname),
                  targetDisplayName: ad.vendor || "Unknown device",
                  color: ARP_COLOR,
                  sourceIp: parentDev?.ips?.[0] ?? parentDev?.lanIp ?? parentDev?.ip ?? "",
                  targetIp: ad.ips.join(", "),
                  mac: formatMac(ad.mac),
                  interface: ad.seenByInterface,
                  vendor: ad.vendor,
                }); }}
                onMouseLeave={() => { setHighlightedId(null); hideLinkTooltip(); }}
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
                toggleSiteOrientation(site.id);
              }}
            />
          ))}

        </g>
      </svg>

      {/* Device popover */}
      {hoveredDevice && (
        <DevicePopover
          hostname={hoveredDevice.hostname}
          icon={hoveredDevice.icon}
          screenX={hoveredDevice.x}
          screenY={hoveredDevice.y}
          onMouseEnter={() => { popoverHovered.current = true; if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; } }}
          onMouseLeave={() => { popoverHovered.current = false; setHoveredDevice(null); }}
        />
      )}

      {/* Link tooltip */}
      {hoveredLink && (
        <LinkTooltip
          data={hoveredLink}
          onMouseEnter={() => {
            linkTooltipHovered.current = true;
            if (linkDismissTimer.current) { clearTimeout(linkDismissTimer.current); linkDismissTimer.current = null; }
          }}
          onMouseLeave={() => {
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
    </div>
  );
}
