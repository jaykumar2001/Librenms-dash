import { useEffect, useState, useCallback, useRef } from "react";
import type { TopologyResponse, DeviceSummary, ArpDiscoveredDevice } from "@librenms-dash/shared";
import { usePersistedLayout } from "./usePersistedLayout";

export interface LayoutNode {
  id: string;
  hostname: string;
  siteId: string;
  status: number;
  icon: string;
  os: string;
  x: number;
  y: number;
}

export interface LayoutLink {
  source: LayoutNode;
  target: LayoutNode;
  overlayType: string;
  overlayKey: string;
  color: string;
  fromIp: string;
  toIp: string;
  fromIface?: string;
  toIface?: string;
}

export interface NeighborLayoutLink {
  source: LayoutNode;
  target: LayoutNode;
  localPort: string;
  remotePort: string;
  protocol: string;
}

export interface ArpLayoutLink {
  source: LayoutNode;
  target: LayoutNode;
  fromIp: string;
  toIp: string;
  mac: string;
  fromInterface?: string;
  fromMac?: string;
  toInterface?: string;
  toMac?: string;
}

export interface SiteCluster {
  id: string;
  location: string;
  orientation: SiteOrientation;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeviceGroup {
  os: string;
  siteId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArpDeviceLayoutNode {
  mac: string;
  ips: string[];
  vendor: string;
  siteId: string;
  seenByHostname: string;
  seenByInterface?: string;
  seenByIp?: string;
  seenByMac?: string;
  x: number;
  y: number;
}

const NODE_W = 148;
const NODE_H = 96;
const NODE_GAP_X = 16;
const NODE_GAP_Y = 14;
const SITE_PAD = 16;
const SITE_LABEL_H = 22;
const GROUP_PAD = 8;
const GROUP_LABEL_H = 16;
const GROUP_GAP = 12;
const SITE_GAP = 24;

const ARP_NODE_W = 132;
const ARP_NODE_H = 42;
const ARP_NODE_GAP_X = 8;
const ARP_NODE_GAP_Y = 6;
const ARP_SECTION_LABEL_H = 16;
const ARP_SECTION_PAD = 8;

export type SiteOrientation = "landscape" | "portrait";

// How many columns for N devices in a group row
function groupCols(n: number): number {
  if (n <= 2) return n;
  if (n <= 6) return 3;
  return 4;
}

interface GroupLayout {
  os: string;
  devices: DeviceSummary[];
  cols: number;
  rows: number;
  w: number;
  h: number;
}

function layoutGroup(devices: DeviceSummary[], orientation: SiteOrientation): GroupLayout {
  const os = devices[0]?.os ?? "unknown";
  const n = devices.length;
  const landscapeCols = groupCols(n);
  const landscapeRows = Math.ceil(n / landscapeCols);
  const cols = orientation === "portrait" ? landscapeRows : landscapeCols;
  const rows = Math.ceil(n / cols);
  const w = GROUP_PAD * 2 + cols * NODE_W + Math.max(0, cols - 1) * NODE_GAP_X;
  const h = GROUP_LABEL_H + GROUP_PAD * 2 + rows * NODE_H + Math.max(0, rows - 1) * NODE_GAP_Y;
  return { os, devices, cols, rows, w, h };
}

// Pack groups into rows within a site, return site dimensions
function layoutSite(
  groups: GroupLayout[],
  orientation: SiteOrientation,
): { siteW: number; siteH: number; groupPositions: Array<{ gx: number; gy: number }> } {
  let curX = SITE_PAD;
  let curY = SITE_LABEL_H + SITE_PAD;
  let rowH = 0;
  let maxW = 0;
  const positions: Array<{ gx: number; gy: number }> = [];

  // Sort groups: largest first
  const sorted = [...groups].sort((a, b) => b.devices.length - a.devices.length);

  const maxGroupW = Math.max(...sorted.map((g) => g.w));
  const targetW = Math.max(maxGroupW * 2 + GROUP_GAP + SITE_PAD * 2, 400);

  for (const group of sorted) {
    if (curX + group.w + SITE_PAD > targetW && curX > SITE_PAD) {
      curX = SITE_PAD;
      curY += rowH + GROUP_GAP;
      rowH = 0;
    }
    positions.push({ gx: curX, gy: curY });
    curX += group.w + GROUP_GAP;
    maxW = Math.max(maxW, curX - GROUP_GAP + SITE_PAD);
    rowH = Math.max(rowH, group.h);
  }

  return {
    siteW: maxW,
    siteH: curY + rowH + SITE_PAD,
    groupPositions: positions,
  };
}

function layoutAll(
  data: TopologyResponse,
  viewW: number,
  siteOrientations: Record<string, SiteOrientation> = {},
  showArpDevices = false,
  viewH = 800,
  topReserve = 56,
): { sites: SiteCluster[]; nodes: LayoutNode[]; links: LayoutLink[]; neighborLinks: NeighborLayoutLink[]; arpLinks: ArpLayoutLink[]; deviceGroups: DeviceGroup[]; arpDeviceNodes: ArpDeviceLayoutNode[]; initialScale: number } {

  // Sort sites: largest first
  const sorted = [...data.sites].sort((a, b) => b.devices.length - a.devices.length);

  // Group ARP discovered devices by siteId
  const arpDevicesBySite = new Map<string, ArpDiscoveredDevice[]>();
  for (const ad of (data.arpDevices ?? [])) {
    if (!arpDevicesBySite.has(ad.siteId)) arpDevicesBySite.set(ad.siteId, []);
    arpDevicesBySite.get(ad.siteId)!.push(ad);
  }

  // Pre-compute site dimensions to determine optimal placement
  const sitePreLayout: Array<{
    site: (typeof sorted)[number];
    orientation: SiteOrientation;
    groups: GroupLayout[];
    groupPositions: Array<{ gx: number; gy: number }>;
    siteW: number;
    siteH: number;
    arpSectionH: number;
    arpCols: number;
    totalH: number;
  }> = [];

  for (const site of sorted) {
    const orientation = siteOrientations[site.id] ?? "landscape";
    const osBuckets = new Map<string, DeviceSummary[]>();
    for (const dev of site.devices) {
      const key = dev.os;
      if (!osBuckets.has(key)) osBuckets.set(key, []);
      osBuckets.get(key)!.push(dev);
    }
    const groups = [...osBuckets.values()].map((devices) => layoutGroup(devices, orientation));
    groups.sort((a, b) => b.devices.length - a.devices.length);
    const { siteW, siteH, groupPositions } = layoutSite(groups, orientation);

    const siteArpDevices = arpDevicesBySite.get(site.id) ?? [];
    let arpSectionH = 0;
    let arpCols = 1;
    if (showArpDevices && siteArpDevices.length > 0) {
      arpCols = Math.max(1, Math.floor((siteW - SITE_PAD * 2 - ARP_SECTION_PAD * 2 + ARP_NODE_GAP_X) / (ARP_NODE_W + ARP_NODE_GAP_X)));
      const arpRows = Math.ceil(siteArpDevices.length / arpCols);
      arpSectionH = ARP_SECTION_LABEL_H + ARP_SECTION_PAD * 2 + arpRows * ARP_NODE_H + Math.max(0, arpRows - 1) * ARP_NODE_GAP_Y + GROUP_GAP;
    }

    sitePreLayout.push({ site, orientation, groups, groupPositions, siteW, siteH, arpSectionH, arpCols, totalH: siteH + arpSectionH });
  }

  // Determine placement: try to fit all sites within viewW × viewH.
  // Reserve space for the top control bars (measured at runtime, defaults to ~56px).
  const TOP_RESERVE = topReserve;
  const usableH = Math.max(viewH - TOP_RESERVE, 300);
  const usableW = Math.max(viewW, 400);

  // Place sites using a row-wrapping algorithm that respects both width and height.
  // Try the natural flow first; if it overflows vertically, allow wider wrapping.
  const sitePositions: Array<{ x: number; y: number }> = [];
  let curSiteX = SITE_GAP;
  let curSiteY = SITE_GAP;
  let siteRowH = 0;

  for (const pre of sitePreLayout) {
    if (curSiteX + pre.siteW + SITE_GAP > usableW && curSiteX > SITE_GAP) {
      curSiteX = SITE_GAP;
      curSiteY += siteRowH + SITE_GAP;
      siteRowH = 0;
    }
    sitePositions.push({ x: curSiteX, y: curSiteY });
    curSiteX += pre.siteW + SITE_GAP;
    siteRowH = Math.max(siteRowH, pre.totalH);
  }

  const totalLayoutH = curSiteY + siteRowH + SITE_GAP;
  const totalLayoutW = Math.max(...sitePositions.map((p, i) => p.x + sitePreLayout[i].siteW + SITE_GAP));

  // Compute the scale needed so everything fits in the viewport.
  // This is returned as `initialScale` and applied as a uniform SVG transform
  // in TopologyMap — so ALL elements (boxes, nodes, text) scale together correctly.
  let scale = 1;
  if (totalLayoutH > usableH || totalLayoutW > usableW) {
    const scaleX = totalLayoutW > usableW ? usableW / totalLayoutW : 1;
    const scaleY = totalLayoutH > usableH ? usableH / totalLayoutH : 1;
    scale = Math.min(scaleX, scaleY);
  }

  // Natural-space centering: place coordinates so that when scaled by `scale`
  // the result is centered in the viewport.
  // scaled content width  = totalLayoutW * scale
  // we want it at x = (usableW - totalLayoutW * scale) / 2 in screen space
  // which in natural space means offsetX = (usableW/scale - totalLayoutW) / 2  ... but
  // it is simpler to just place everything at 0,TOP_RESERVE and let the SVG transform handle centering.
  const offsetX = SITE_GAP;
  const offsetY = TOP_RESERVE / scale;

  const siteClusters: SiteCluster[] = [];
  const allNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();
  const allGroups: DeviceGroup[] = [];
  const allArpDeviceNodes: ArpDeviceLayoutNode[] = [];

  for (let si = 0; si < sitePreLayout.length; si++) {
    const pre = sitePreLayout[si];
    const pos = sitePositions[si];
    const { site, groups, groupPositions, siteW, siteH, arpCols } = pre;

    // All coordinates are in natural (unscaled) layout space.
    // The caller applies initialScale as a uniform SVG transform so that
    // site boxes, device nodes, and text all scale together.
    const siteX = pos.x + offsetX;
    const siteY = pos.y + offsetY;

    siteClusters.push({
      id: site.id,
      location: site.location,
      orientation: pre.orientation,
      x: siteX,
      y: siteY,
      width: siteW,
      height: pre.totalH,
    });

    // Place devices within groups
    groups.forEach((group, gi) => {
      const gp = groupPositions[gi];
      const absGx = siteX + gp.gx;
      const absGy = siteY + gp.gy;

      allGroups.push({
        os: group.os,
        siteId: site.id,
        x: absGx,
        y: absGy,
        width: group.w,
        height: group.h,
      });

      group.devices.forEach((dev, di) => {
        const col = di % group.cols;
        const row = Math.floor(di / group.cols);
        const x = absGx + GROUP_PAD + NODE_W / 2 + col * (NODE_W + NODE_GAP_X);
        const y = absGy + GROUP_LABEL_H + GROUP_PAD + NODE_H / 2 + row * (NODE_H + NODE_GAP_Y);

        const node: LayoutNode = {
          id: dev.hostname,
          hostname: dev.hostname,
          siteId: site.id,
          status: dev.status,
          icon: dev.icon,
          os: dev.os,
          x,
          y,
        };
        allNodes.push(node);
        nodeMap.set(dev.hostname, node);
      });
    });

    // Place ARP discovered devices below the managed device groups
    const siteArpDevices = arpDevicesBySite.get(site.id) ?? [];
    if (showArpDevices && siteArpDevices.length > 0) {
      const arpStartY = siteY + siteH + GROUP_GAP;
      const arpStartX = siteX + SITE_PAD + ARP_SECTION_PAD;

      siteArpDevices.forEach((ad, i) => {
        const col = i % arpCols;
        const row = Math.floor(i / arpCols);
        allArpDeviceNodes.push({
          mac: ad.mac,
          ips: ad.ips,
          vendor: ad.vendor,
          siteId: site.id,
          seenByHostname: ad.seenByHostname,
          seenByInterface: ad.seenByInterface,
          seenByIp: ad.seenByIp,
          seenByMac: ad.seenByMac,
          x: arpStartX + ARP_NODE_W / 2 + col * (ARP_NODE_W + ARP_NODE_GAP_X),
          y: arpStartY + ARP_SECTION_LABEL_H + ARP_SECTION_PAD + ARP_NODE_H / 2 + row * (ARP_NODE_H + ARP_NODE_GAP_Y),
        });
      });
    }
  }

  // Build overlay links
  const links: LayoutLink[] = [];
  for (const overlay of data.overlays) {
    for (const link of overlay.links) {
      const src = nodeMap.get(link.from);
      const tgt = nodeMap.get(link.to);
      if (src && tgt) {
        links.push({
          source: src,
          target: tgt,
          overlayType: overlay.overlayType,
          overlayKey: `${overlay.overlayType}:${overlay.subnet}`,
          color: overlay.color,
          fromIp: link.fromIp,
          toIp: link.toIp,
          fromIface: link.fromIface,
          toIface: link.toIface,
        });
      }
    }
  }

  // Build neighbor (LLDP/CDP) links
  const neighborLinks: NeighborLayoutLink[] = [];
  for (const n of (data.neighbors ?? [])) {
    const src = nodeMap.get(n.localHostname);
    const tgt = nodeMap.get(n.remoteHostname);
    if (src && tgt) {
      neighborLinks.push({
        source: src,
        target: tgt,
        localPort: n.localPort,
        remotePort: n.remotePort,
        protocol: n.protocol,
      });
    }
  }

  // Build ARP links
  const arpLinks: ArpLayoutLink[] = [];
  for (const a of (data.arpLinks ?? [])) {
    const src = nodeMap.get(a.fromHostname);
    const tgt = nodeMap.get(a.toHostname);
    if (src && tgt) {
      arpLinks.push({
        source: src,
        target: tgt,
        fromIp: a.fromIp,
        toIp: a.toIp,
        mac: a.mac,
        fromInterface: a.fromInterface,
        fromMac: a.fromMac,
        toInterface: a.toInterface,
        toMac: a.toMac,
      });
    }
  }

  return { sites: siteClusters, nodes: allNodes, links, neighborLinks, arpLinks, deviceGroups: allGroups, arpDeviceNodes: allArpDeviceNodes, initialScale: scale };
}

function fitDeviceGroupsToNodes(groups: DeviceGroup[], nextNodes: LayoutNode[]): DeviceGroup[] {
  return groups.map((group) => {
    const groupNodes = nextNodes.filter((node) => node.siteId === group.siteId && node.os === group.os);
    if (groupNodes.length === 0) return group;

    const minX = Math.min(...groupNodes.map((node) => node.x - NODE_W / 2)) - GROUP_PAD;
    const minY = Math.min(...groupNodes.map((node) => node.y - NODE_H / 2)) - GROUP_PAD - GROUP_LABEL_H;
    const maxX = Math.max(...groupNodes.map((node) => node.x + NODE_W / 2)) + GROUP_PAD;
    const maxY = Math.max(...groupNodes.map((node) => node.y + NODE_H / 2)) + GROUP_PAD;

    return {
      ...group,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  });
}

function fitSitesToDeviceGroups(sites: SiteCluster[], nextGroups: DeviceGroup[]): SiteCluster[] {
  return sites.map((site) => {
    const siteGroups = nextGroups.filter((group) => group.siteId === site.id);
    if (siteGroups.length === 0) return site;

    const minX = Math.min(...siteGroups.map((group) => group.x));
    const minY = Math.min(...siteGroups.map((group) => group.y));
    const maxX = Math.max(...siteGroups.map((group) => group.x + group.width));
    const maxY = Math.max(...siteGroups.map((group) => group.y + group.height));
    const x = minX - SITE_PAD;
    const y = minY - SITE_LABEL_H - SITE_PAD;

    return {
      ...site,
      x,
      y,
      width: Math.max(maxX + SITE_PAD - x, 160),
      height: Math.max(maxY + SITE_PAD - y, SITE_LABEL_H + SITE_PAD * 2),
    };
  });
}

function getSiteContentMinSize(siteId: string, groups: DeviceGroup[], site?: SiteCluster): { width: number; height: number } {
  const siteGroups = groups.filter((group) => group.siteId === siteId);
  if (siteGroups.length === 0 || !site) {
    return { width: 160, height: SITE_LABEL_H + SITE_PAD * 2 };
  }

  const maxRight = Math.max(...siteGroups.map((group) => group.x + group.width));
  const maxBottom = Math.max(...siteGroups.map((group) => group.y + group.height));
  return {
    width: Math.max(maxRight - site.x + SITE_PAD, 160),
    height: Math.max(maxBottom - site.y + SITE_PAD, SITE_LABEL_H + SITE_PAD * 2),
  };
}

function reflowSiteContents(
  site: SiteCluster,
  nextWidth: number,
  nextHeight: number,
  currentNodes: LayoutNode[],
  currentGroups: DeviceGroup[],
): { site: SiteCluster; nodes: LayoutNode[]; groups: DeviceGroup[] } {
  const siteGroups = currentGroups
    .filter((group) => group.siteId === site.id)
    .sort((a, b) => {
      const countA = currentNodes.filter((node) => node.siteId === a.siteId && node.os === a.os).length;
      const countB = currentNodes.filter((node) => node.siteId === b.siteId && node.os === b.os).length;
      return countB - countA;
    });

  if (siteGroups.length === 0) {
    return {
      site: { ...site, width: Math.max(nextWidth, 160), height: Math.max(nextHeight, SITE_LABEL_H + SITE_PAD * 2) },
      nodes: currentNodes,
      groups: currentGroups,
    };
  }

  const maxContentW = Math.max(nextWidth - SITE_PAD * 2, NODE_W + GROUP_PAD * 2);
  const updatedNodes = [...currentNodes];
  const updatedGroupMap = new Map<string, DeviceGroup>();

  let curX = site.x + SITE_PAD;
  let curY = site.y + SITE_LABEL_H + SITE_PAD;
  let rowH = 0;
  let maxRight = site.x + SITE_PAD;
  let maxBottom = site.y + SITE_LABEL_H + SITE_PAD;

  for (const group of siteGroups) {
    const groupNodes = updatedNodes
      .filter((node) => node.siteId === site.id && node.os === group.os)
      .sort((a, b) => a.hostname.localeCompare(b.hostname));

    if (groupNodes.length === 0) continue;

    const maxCols = Math.max(1, Math.floor((maxContentW - GROUP_PAD * 2 + NODE_GAP_X) / (NODE_W + NODE_GAP_X)));
    const lCols = groupCols(groupNodes.length);
    const lRows = Math.ceil(groupNodes.length / lCols);
    const cols = site.orientation === "portrait"
      ? Math.min(lRows, maxCols)
      : Math.min(groupNodes.length, maxCols);
    const rows = Math.ceil(groupNodes.length / cols);
    const baseW = GROUP_PAD * 2 + cols * NODE_W;
    const availableGapX = maxContentW - baseW;
    const gapX = cols > 1 ? Math.max(NODE_GAP_X, availableGapX / (cols - 1)) : 0;
    const groupW = Math.min(maxContentW, GROUP_PAD * 2 + cols * NODE_W + Math.max(0, cols - 1) * gapX);
    const groupH = GROUP_LABEL_H + GROUP_PAD * 2 + rows * NODE_H + Math.max(0, rows - 1) * NODE_GAP_Y;

    if (curX + groupW > site.x + nextWidth - SITE_PAD && curX > site.x + SITE_PAD) {
      curX = site.x + SITE_PAD;
      curY += rowH + GROUP_GAP;
      rowH = 0;
    }

    updatedGroupMap.set(`${group.siteId}:${group.os}`, {
      ...group,
      x: curX,
      y: curY,
      width: groupW,
      height: groupH,
    });

    groupNodes.forEach((node, index) => {
      const nodeIndex = updatedNodes.findIndex((candidate) => candidate.hostname === node.hostname);
      if (nodeIndex < 0) return;
      const col = index % cols;
      const row = Math.floor(index / cols);
      updatedNodes[nodeIndex] = {
        ...updatedNodes[nodeIndex],
        x: curX + GROUP_PAD + NODE_W / 2 + col * (NODE_W + gapX),
        y: curY + GROUP_LABEL_H + GROUP_PAD + NODE_H / 2 + row * (NODE_H + NODE_GAP_Y),
      };
    });

    maxRight = Math.max(maxRight, curX + groupW);
    maxBottom = Math.max(maxBottom, curY + groupH);
    curX += groupW + GROUP_GAP;
    rowH = Math.max(rowH, groupH);
  }

  const updatedGroups = currentGroups.map((group) => updatedGroupMap.get(`${group.siteId}:${group.os}`) ?? group);
  const minWidth = maxRight - site.x + SITE_PAD;
  const minHeight = maxBottom - site.y + SITE_PAD;

  return {
    site: {
      ...site,
      width: Math.max(nextWidth, minWidth, 160),
      height: Math.max(nextHeight, minHeight, SITE_LABEL_H + SITE_PAD * 2),
    },
    nodes: updatedNodes,
    groups: updatedGroups,
  };
}

// Re-place ARP discovered-device boxes below each site's managed content and grow
// the site box to enclose them. Mirrors the ARP section math in layoutAll so a
// dragged/resized site keeps its discovered devices inside it instead of leaving
// them behind. No-op when there are no ARP device nodes (feature toggled off).
function relayoutArpNodes(
  sites: SiteCluster[],
  groups: DeviceGroup[],
  arpNodes: ArpDeviceLayoutNode[],
): { sites: SiteCluster[]; arpNodes: ArpDeviceLayoutNode[] } {
  if (arpNodes.length === 0) return { sites, arpNodes };

  const bySite = new Map<string, ArpDeviceLayoutNode[]>();
  for (const ad of arpNodes) {
    if (!bySite.has(ad.siteId)) bySite.set(ad.siteId, []);
    bySite.get(ad.siteId)!.push(ad);
  }

  const placed: ArpDeviceLayoutNode[] = [];
  const heightPatch = new Map<string, number>();

  for (const site of sites) {
    const siteArp = bySite.get(site.id);
    if (!siteArp || siteArp.length === 0) continue;

    const siteGroups = groups.filter((g) => g.siteId === site.id);
    const contentBottom = siteGroups.length > 0
      ? Math.max(...siteGroups.map((g) => g.y + g.height))
      : site.y + SITE_LABEL_H + SITE_PAD;

    const arpCols = Math.max(1, Math.floor(
      (site.width - SITE_PAD * 2 - ARP_SECTION_PAD * 2 + ARP_NODE_GAP_X) / (ARP_NODE_W + ARP_NODE_GAP_X),
    ));
    const arpStartY = contentBottom + SITE_PAD + GROUP_GAP;
    const arpStartX = site.x + SITE_PAD + ARP_SECTION_PAD;

    siteArp.forEach((ad, i) => {
      const col = i % arpCols;
      const row = Math.floor(i / arpCols);
      placed.push({
        ...ad,
        x: arpStartX + ARP_NODE_W / 2 + col * (ARP_NODE_W + ARP_NODE_GAP_X),
        y: arpStartY + ARP_SECTION_LABEL_H + ARP_SECTION_PAD + ARP_NODE_H / 2 + row * (ARP_NODE_H + ARP_NODE_GAP_Y),
      });
    });

    const arpRows = Math.ceil(siteArp.length / arpCols);
    const lastNodeBottom = arpStartY + ARP_SECTION_LABEL_H + ARP_SECTION_PAD
      + arpRows * ARP_NODE_H + Math.max(0, arpRows - 1) * ARP_NODE_GAP_Y;
    heightPatch.set(site.id, lastNodeBottom + ARP_SECTION_PAD + SITE_PAD - site.y);
  }

  // Carry through any nodes whose site wasn't found (shouldn't happen in practice).
  const placedMacs = new Set(placed.map((n) => n.mac));
  for (const ad of arpNodes) if (!placedMacs.has(ad.mac)) placed.push(ad);

  const nextSites = sites.map((s) => {
    const required = heightPatch.get(s.id);
    return required != null ? { ...s, height: Math.max(s.height, required) } : s;
  });

  return { sites: nextSites, arpNodes: placed };
}

// Identifies the structural shape of the topology (which sites/devices/arp devices
// exist) plus the inputs that affect the generated layout. When this is unchanged
// across a refetch, we keep the user's manual positions instead of regenerating.
function layoutSignature(
  data: TopologyResponse,
  containerWidth: number,
  containerHeight: number,
  siteOrientations: Record<string, SiteOrientation>,
  showArpDevices: boolean,
  topReserve: number,
): string {
  const sites = data.sites
    .map((s) => `${s.id}:${s.devices.map((d) => d.hostname).sort().join(",")}`)
    .sort()
    .join("|");
  const arp = (data.arpDevices ?? []).map((a) => a.mac).sort().join(",");
  return `${sites}#${arp}@${containerWidth}x${containerHeight}|${JSON.stringify(siteOrientations)}|${showArpDevices}|${topReserve}`;
}

export function useForceLayout(
  data: TopologyResponse | undefined,
  containerWidth: number,
  containerHeight: number,
  showArpDevices = false,
  topReserve = 56,
  isDragging = false,
) {
  const persist = usePersistedLayout();

  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [links, setLinks] = useState<LayoutLink[]>([]);
  const [neighborLinks, setNeighborLinks] = useState<NeighborLayoutLink[]>([]);
  const [arpLinks, setArpLinks] = useState<ArpLayoutLink[]>([]);
  const [arpDeviceNodes, setArpDeviceNodes] = useState<ArpDeviceLayoutNode[]>([]);
  const [sites, setSites] = useState<SiteCluster[]>([]);
  const [deviceGroups, setDeviceGroups] = useState<DeviceGroup[]>([]);
  // Seed orientations from localStorage so portrait/landscape choices survive reload.
  const [siteOrientations, setSiteOrientations] = useState<Record<string, SiteOrientation>>(
    () => persist.getSavedOrientations(),
  );
  const [initialScale, setInitialScale] = useState(1);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const sitesRef = useRef(sites);
  sitesRef.current = sites;
  const deviceGroupsRef = useRef(deviceGroups);
  deviceGroupsRef.current = deviceGroups;
  const arpDeviceNodesRef = useRef(arpDeviceNodes);
  arpDeviceNodesRef.current = arpDeviceNodes;
  const layoutSigRef = useRef<string>("");
  const pendingDataRef = useRef<TopologyResponse | undefined>();

  const relinkNodes = useCallback((nextNodes: LayoutNode[]) => {
    const nodeMap = new Map(nextNodes.map((node) => [node.hostname, node]));
    setLinks((prev) => prev.map((link) => ({
      ...link,
      source: nodeMap.get(link.source.hostname) ?? link.source,
      target: nodeMap.get(link.target.hostname) ?? link.target,
    })));
    setNeighborLinks((prev) => prev.map((link) => ({
      ...link,
      source: nodeMap.get(link.source.hostname) ?? link.source,
      target: nodeMap.get(link.target.hostname) ?? link.target,
    })));
    setArpLinks((prev) => prev.map((link) => ({
      ...link,
      source: nodeMap.get(link.source.hostname) ?? link.source,
      target: nodeMap.get(link.target.hostname) ?? link.target,
    })));
  }, []);

  useEffect(() => {
    if (!data || !containerWidth) return;
    if (isDragging) {
      pendingDataRef.current = data;
      return;
    }
    const effectiveData = pendingDataRef.current ?? data;
    pendingDataRef.current = undefined;
    // Skip regenerating the layout (which discards manual drags/resizes) when the
    // topology and layout inputs are unchanged — e.g. on the 5-minute background poll.
    const sig = layoutSignature(effectiveData, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve);
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
    const result = layoutAll(effectiveData, containerWidth, siteOrientations, showArpDevices, containerHeight, topReserve);
    // Overlay saved positions on top of freshly-computed ones so manual drags
    // and resizes from a previous session are restored after reload.
    const restoredSites = persist.applySitePositions(result.sites);
    const restoredNodes = persist.applyNodePositions(result.nodes);
    // Links and device-group borders are derived from node positions. The freshly
    // built links/groups still point at the pre-restore node coordinates, so rebind
    // links to the restored nodes and refit the group borders — otherwise overlay
    // lines and category boxes snap back to their original spots on refresh.
    const restoredNodeMap = new Map(restoredNodes.map((n) => [n.hostname, n]));
    const rebind = <T extends { source: LayoutNode; target: LayoutNode }>(link: T): T => ({
      ...link,
      source: restoredNodeMap.get(link.source.hostname) ?? link.source,
      target: restoredNodeMap.get(link.target.hostname) ?? link.target,
    });
    const restoredGroups = fitDeviceGroupsToNodes(result.deviceGroups, restoredNodes);
    // ARP discovered-device boxes are placed relative to the restored site/group
    // positions and the site grows to enclose them. They were set straight from
    // the fresh layout (original site coords), so they snapped back on refresh.
    const arp = relayoutArpNodes(restoredSites, restoredGroups, result.arpDeviceNodes);
    setSites(arp.sites);
    setNodes(restoredNodes);
    setLinks(result.links.map(rebind));
    setNeighborLinks(result.neighborLinks.map(rebind));
    setArpLinks(result.arpLinks.map(rebind));
    setArpDeviceNodes(arp.arpNodes);
    setDeviceGroups(restoredGroups);
    setInitialScale(result.initialScale);
  }, [data, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve, isDragging]);

  const resetLayout = useCallback(() => {
    if (!data || !containerWidth) return;
    // Wipe saved positions so reset truly goes back to auto-layout.
    persist.clearPersistedLayout();
    setSiteOrientations({});
    layoutSigRef.current = layoutSignature(data, containerWidth, containerHeight, {}, showArpDevices, topReserve);
    const result = layoutAll(data, containerWidth, {}, showArpDevices, containerHeight, topReserve);
    setSites(result.sites);
    setNodes(result.nodes);
    setLinks(result.links);
    setNeighborLinks(result.neighborLinks);
    setArpLinks(result.arpLinks);
    setArpDeviceNodes(result.arpDeviceNodes);
    setDeviceGroups(result.deviceGroups);
    setInitialScale(result.initialScale);
  }, [data, containerWidth, containerHeight, showArpDevices, topReserve]);

  const toggleSiteOrientation = useCallback((siteId: string) => {
    setSiteOrientations((prev) => {
      const next = { ...prev, [siteId]: prev[siteId] === "portrait" ? "landscape" : ("portrait" as SiteOrientation) };
      persist.saveSiteOrientation(siteId, next[siteId]);
      return next;
    });
  }, []);

  const moveSite = useCallback((siteId: string, dx: number, dy: number) => {
    setSites((prev) => {
      const next = prev.map((site) =>
        site.id === siteId ? { ...site, x: site.x + dx, y: site.y + dy } : site,
      );
      persist.saveSitePositions(next.filter((s) => s.id === siteId));
      return next;
    });
    setDeviceGroups((prev) => prev.map((group) => (
      group.siteId === siteId ? { ...group, x: group.x + dx, y: group.y + dy } : group
    )));
    setArpDeviceNodes((prev) => prev.map((ad) => (
      ad.siteId === siteId ? { ...ad, x: ad.x + dx, y: ad.y + dy } : ad
    )));
    setNodes((prev) => {
      const nextNodes = prev.map((node) => (
        node.siteId === siteId ? { ...node, x: node.x + dx, y: node.y + dy } : node
      ));
      persist.saveNodePositions(nextNodes.filter((n) => n.siteId === siteId));
      relinkNodes(nextNodes);
      return nextNodes;
    });
  }, [relinkNodes]);

  const moveDevice = useCallback((hostname: string, dx: number, dy: number) => {
    const nextNodes = nodesRef.current.map((node) => (
      node.hostname === hostname ? { ...node, x: node.x + dx, y: node.y + dy } : node
    ));
    const nextGroups = fitDeviceGroupsToNodes(deviceGroupsRef.current, nextNodes);
    const fittedSites = fitSitesToDeviceGroups(sitesRef.current, nextGroups);
    const arp = relayoutArpNodes(fittedSites, nextGroups, arpDeviceNodesRef.current);

    persist.saveNodePositions(nextNodes.filter((n) => n.hostname === hostname));
    persist.saveSitePositions(arp.sites);
    setNodes(nextNodes);
    setDeviceGroups(nextGroups);
    setSites(arp.sites);
    setArpDeviceNodes(arp.arpNodes);
    relinkNodes(nextNodes);
  }, [relinkNodes]);

  const resizeSite = useCallback((siteId: string, width: number, height: number) => {
    const site = sitesRef.current.find((candidate) => candidate.id === siteId);
    if (!site) return;

    const minSize = getSiteContentMinSize(siteId, deviceGroupsRef.current, site);
    const result = reflowSiteContents(
      site,
      Math.max(width, minSize.width),
      Math.max(height, minSize.height),
      nodesRef.current,
      deviceGroupsRef.current,
    );

    const resizedSites = sitesRef.current.map((candidate) => candidate.id === siteId ? result.site : candidate);
    const arp = relayoutArpNodes(resizedSites, result.groups, arpDeviceNodesRef.current);

    persist.saveSitePositions(arp.sites.filter((s) => s.id === siteId));
    persist.saveNodePositions(result.nodes.filter((n) => n.siteId === siteId));
    setSites(arp.sites);
    setDeviceGroups(result.groups);
    setNodes(result.nodes);
    setArpDeviceNodes(arp.arpNodes);
    relinkNodes(result.nodes);
  }, [relinkNodes]);

  return {
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
  };
}
