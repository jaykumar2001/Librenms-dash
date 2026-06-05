import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { MouseEvent, WheelEvent } from "react";
import type { TopologyResponse, DeviceSummary } from "@librenms-dash/shared";
import { useForceLayout } from "@/hooks/useForceLayout";
import { SiteGroup, DeviceGroupBorder } from "./SiteGroup";
import { OverlayLinkLine } from "./OverlayLink";
import { HoverableLinkPath } from "./HoverableLinkPath";
import { DeviceNode } from "./DeviceNode";
import { ArpDeviceNode } from "./ArpDeviceNode";
import { DevicePopover } from "./DevicePopover";
import { LinkTooltip, type LinkTooltipData } from "./LinkTooltip";
import { curvedLinkPath, DEVICE_HALF, ARP_HALF } from "@/lib/linkGeometry";

interface Props {
  data: TopologyResponse;
}

const GRID_SIZE = 24;
const ALIGN_SNAP_DISTANCE = 10;
const LINK_HOVER_DELAY = 350;

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
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });
  const [hoveredDevice, setHoveredDevice] = useState<{ hostname: string; x: number; y: number; icon: string } | null>(null);
  const [hoveredLink, setHoveredLink] = useState<LinkTooltipData | null>(null);
  const [hoveredLinkKey, setHoveredLinkKey] = useState<string | null>(null);
  const [hiddenOverlays, setHiddenOverlays] = useState<Record<string, boolean>>({ zerotier: true, wireguard: true, tailscale: true });
  const [showNeighbors, setShowNeighbors] = useState(false);
  const [showArp, setShowArp] = useState(false);
  const [showArpDevices, setShowArpDevices] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverHovered = useRef(false);
  const linkDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkTooltipHovered = useRef(false);
  const linkHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
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
    resetLayout,
    moveSite,
    moveDevice,
    resizeSite,
    toggleSiteOrientation,
  } = useForceLayout(data, dimensions.width, dimensions.height, showArpDevices);

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
      popoverHovered.current = false;
      const dev = deviceMap.get(hostname);
      setHoveredDevice({ hostname, x, y, icon: dev?.icon ?? "generic.svg" });
    } else {
      dismissTimer.current = setTimeout(() => {
        if (!popoverHovered.current) setHoveredDevice(null);
      }, 150);
    }
  }, [deviceMap]);

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
      {/* Controls */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-3 bg-gray-900/90 backdrop-blur border border-gray-700 rounded-lg px-4 py-2">
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
          Grid
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
      <div className="absolute top-4 right-4 z-10 flex items-center gap-4 bg-gray-900/90 backdrop-blur border border-gray-700 rounded-lg px-4 py-2 text-xs">
        <span className="text-gray-400">
          {data.sites.length} sites, {data.sites.reduce((s, site) => s + site.devices.length, 0)} devices
        </span>
        {data.alerts.length > 0 && (
          <span className="text-red-400 font-semibold">{data.alerts.length} alert{data.alerts.length > 1 ? "s" : ""}</span>
        )}
        <span className="text-gray-500">Updated {new Date(data.lastUpdated).toLocaleTimeString()}</span>
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
              onToggleOrientation={(e) => {
                e.stopPropagation();
                toggleSiteOrientation(site.id);
              }}
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
            return (
              <HoverableLinkPath
                key={key}
                linkKey={key}
                sx={sx} sy={sy} tx={tx} ty={ty}
                color={NEIGHBOR_COLOR}
                hovered={hoveredLinkKey === key}
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
            return (
              <HoverableLinkPath
                key={key}
                linkKey={key}
                sx={sx} sy={sy} tx={tx} ty={ty}
                color={ARP_COLOR}
                hovered={hoveredLinkKey === key}
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
            return (
              <OverlayLinkLine
                key={key}
                link={link}
                hovered={hoveredLinkKey === key}
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
                  sourceIp: link.fromIp,
                  targetIp: link.toIp,
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
              onHover={handleDeviceHover}
              onMouseDown={(e) => beginDeviceDrag(node.hostname, e)}
            />
          ))}

          {/* ARP discovered-device connector lines — link each discovered device
              back to the managed device that saw it in its ARP table. */}
          {showArpDevices && arpDeviceNodes.map((ad) => {
            const parent = nodeByHostname.get(ad.seenByHostname);
            if (!parent || parent.x == null || parent.y == null) return null;
            const d = curvedLinkPath(parent.x, parent.y, ad.x, ad.y, DEVICE_HALF, ARP_HALF);
            const key = `arpdev-link-${ad.mac}`;
            const hovered = hoveredLinkKey === key;
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
                    sourceIp: parentDev?.lanIp ?? parentDev?.ip ?? "",
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
                  strokeWidth={hovered ? 2 : 1}
                  strokeOpacity={hovered ? 0.9 : 0.35}
                  strokeDasharray="3 3"
                  fill="none"
                  pointerEvents="none"
                />
              </g>
            );
          })}

          {/* ARP Discovered Devices */}
          {showArpDevices && arpDeviceNodes.map((ad) => (
            <ArpDeviceNode key={ad.mac} node={ad} />
          ))}

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
    </div>
  );
}
