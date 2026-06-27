# IPv6 ND Web Scrape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrape `/device/{id}/ports/nd` from the LibreNMS web UI per device, extract global IPv6 addresses, enrich managed device IP lists, and surface IPv6-only unmanaged devices alongside ARP-discovered ones.

**Architecture:** A new `fetchNdNeighbours(deviceId)` function added to the existing `web-client.ts` (same session + re-login pattern as `fetchRoutes`). A new `pollNdNeighbours()` in `poller.ts` builds two caches: `ndGlobalIpv6` (hostname → global IPv6[]) for managed device enrichment, and appends ND-only unmanaged MACs into the existing `arpDevices` cache. The topology and device-overview routes read `ndGlobalIpv6` to inject IPv6 into `DeviceSummary.ips[]`, `allIps[]`, and `Device.ips[]`.

**Tech Stack:** TypeScript, Hono, regex HTML parsing (no DOM library — same approach as existing route scraper), Docker Compose for verification.

## Global Constraints

- Verify all changes with `docker-compose up -d --build` — not bare `tsc`.
- No new npm dependencies — parse HTML with regex, same as existing `web-client.ts`.
- Follow existing stagger pattern: `await delay(STAGGER_MS)` between per-device requests.
- Guard every `fetchNdNeighbours` call with `if (!isWebClientEnabled()) return` — ND polling is silently disabled when web credentials are absent, identical to route polling.
- Do not modify `shared/types.ts` — reuse `ArpDiscoveredDevice` for ND-only unmanaged devices.
- Match existing code style exactly.

---

### Task 1: Add `LnmsNdEntry` type and `fetchNdNeighbours` to web-client

**Files:**
- Modify: `backend/src/librenms/types.ts` — append `LnmsNdEntry` interface
- Modify: `backend/src/librenms/web-client.ts` — append `parseNdTable` + `fetchNdNeighbours`

**Interfaces:**
- Produces:
  - `LnmsNdEntry` (in `types.ts`): `{ portName: string; portId: number | null; mac: string; vendor: string; ipv6: string; remoteDevice: string; remoteInterface: string }`
  - `fetchNdNeighbours(deviceId: number): Promise<LnmsNdEntry[]>` (exported from `web-client.ts`)

- [ ] **Step 1: Add `LnmsNdEntry` to `backend/src/librenms/types.ts`**

Append after the closing brace of `LnmsRoute` (around line 111):

```typescript
export interface LnmsNdEntry {
  portName: string;
  portId: number | null;
  mac: string;
  vendor: string;
  ipv6: string;
  remoteDevice: string;
  remoteInterface: string;
}
```

- [ ] **Step 2: Add `parseNdTable` and `fetchNdNeighbours` to `backend/src/librenms/web-client.ts`**

Add the import of `LnmsNdEntry` at the top of `web-client.ts` — change line 2 from:
```typescript
import type { LnmsRoute } from "./types.js";
```
to:
```typescript
import type { LnmsRoute, LnmsNdEntry } from "./types.js";
```

Then append the following two functions before the final `export { extractIfaceName, extractNextHop, stripHtml };` line:

```typescript
function parseNdTable(html: string): LnmsNdEntry[] {
  const macHeaderIdx = html.indexOf('MAC address');
  if (macHeaderIdx === -1) return [];

  const tableStart = html.lastIndexOf('<table', macHeaderIdx);
  const tableEnd = html.indexOf('</table>', macHeaderIdx) + '</table>'.length;
  if (tableStart === -1 || tableEnd < '</table>'.length) return [];

  const tableHtml = html.slice(tableStart, tableEnd);
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const results: LnmsNdEntry[] = [];
  let rowMatch: RegExpExecArray | null;
  let isFirst = true;

  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    if (isFirst) { isFirst = false; continue; } // skip header

    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(cellMatch[1]);
    if (cells.length < 4) continue;

    const portHref = cells[0].match(/href="[^"]+\/port=(\d+)\/[^"]*"[^>]*>\s*([A-Za-z0-9._\-/]+)/);
    const portName = portHref ? portHref[2].trim() : stripTags(cells[0]).split(' ')[0];
    const portId = portHref ? parseInt(portHref[1], 10) : null;

    const mac = stripTags(cells[1]);
    const vendor = stripTags(cells[2]);
    const ipv6 = stripTags(cells[3]);
    if (!mac || !ipv6) continue;

    const remoteDevMatch = cells[4]?.match(/href="[^"]*device=\d+[^"]*"[^>]*>\s*([^\n<]{1,60})/);
    const remoteDevice = remoteDevMatch ? remoteDevMatch[1].trim() : '';

    const remoteIfaceMatch = cells[5]?.match(/href="[^"]+\/port=\d+\/[^"]*"[^>]*>\s*([A-Za-z0-9._\-/]+)/);
    const remoteInterface = remoteIfaceMatch ? remoteIfaceMatch[1].trim() : '';

    results.push({ portName, portId, mac, vendor, ipv6, remoteDevice, remoteInterface });
  }

  return results;
}

export async function fetchNdNeighbours(deviceId: number): Promise<LnmsNdEntry[]> {
  if (disabled) return [];

  const path = `/device/${deviceId}/ports/nd`;

  try {
    let res = await webFetch(path);

    if (res.status === 401 || res.status === 302 || res.status === 419) {
      const ok = await login();
      if (!ok) {
        console.log("[web-client] ND polling disabled — re-authentication failed");
        disabled = true;
        return [];
      }
      res = await webFetch(path);
    }

    if (!res.ok) return [];
    return parseNdTable(await res.text());
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: TypeScript check**

```bash
cd /home/jkumar/Librenms-dash/backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/librenms/types.ts backend/src/librenms/web-client.ts
git commit -m "feat: add LnmsNdEntry type and fetchNdNeighbours HTML scraper"
```

---

### Task 2: Add `pollNdNeighbours` to poller and wire it up

**Files:**
- Modify: `backend/src/jobs/poller.ts`

**Interfaces:**
- Consumes:
  - `fetchNdNeighbours(deviceId: number): Promise<LnmsNdEntry[]>` from `web-client.ts`
  - `LnmsNdEntry` from `types.ts`
  - `normalizeMac(mac: string): string` from `oui.ts` (already imported)
  - `lookupVendor(mac: string): string` from `oui.ts` (already imported)
  - `isWebClientEnabled(): boolean` from `web-client.ts` (already imported)
  - `delay(ms: number)` from `client.ts` (already imported)
  - `STAGGER_MS` constant (already defined at top of file, value `200`)
  - `TTL` from `cache/store.ts` (already imported) — use `TTL.PORTS`
  - `ArpDiscoveredDevice` from `@librenms-dash/shared` (already imported)
- Produces:
  - Cache key `"ndGlobalIpv6"` → `Map<string, string[]>` (hostname → global IPv6 addresses)
  - Enriched `"arpDevices"` cache entry — ND-only unmanaged MACs appended

- [ ] **Step 1: Add `LnmsNdEntry` to the type import at the top of `poller.ts`**

Find line 8 (the `import type { LnmsDevice, ... }` line):
```typescript
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsLocation, LnmsAlert, LnmsLink, LnmsArpEntry } from "../librenms/types.js";
```
Replace with:
```typescript
import type { LnmsDevice, LnmsPort, LnmsDeviceIp, LnmsLocation, LnmsAlert, LnmsLink, LnmsArpEntry, LnmsNdEntry } from "../librenms/types.js";
```

- [ ] **Step 2: Add `fetchNdNeighbours` to the web-client import**

Find line 7 (the `import { initWebSession, ... }` line):
```typescript
import { initWebSession, isWebClientEnabled, fetchRoutes, extractIfaceName, extractNextHop, stripHtml } from "../librenms/web-client.js";
```
Replace with:
```typescript
import { initWebSession, isWebClientEnabled, fetchRoutes, fetchNdNeighbours, extractIfaceName, extractNextHop, stripHtml } from "../librenms/web-client.js";
```

- [ ] **Step 3: Add `pollNdNeighbours` function**

Add this function after `pollRoutes` (around line 699, before the `let prevAlertIds` line):

```typescript
export async function pollNdNeighbours() {
  if (!isWebClientEnabled()) return;

  const devices = cache.get<LnmsDevice[]>("devices");
  if (!devices) return;

  // Build mac → hostname map from cached port data
  const macToHostname = new Map<string, string>();
  const hostnameToLocation = new Map<string, string>();
  for (const d of devices) {
    hostnameToLocation.set(d.hostname, d.location || "Unknown");
    const ports = cache.get<LnmsPort[]>(`ports:${d.hostname}`);
    if (!ports) continue;
    for (const p of ports) {
      const mac = normalizeMac(p.ifPhysAddress ?? "");
      if (mac && mac.length === 12 && mac !== "000000000000") macToHostname.set(mac, d.hostname);
    }
  }

  const ndGlobalIpv6 = new Map<string, string[]>();
  // Unmanaged: mac → { ips, vendor, seenByHostname, seenByPort, location }
  const ndUnmanaged = new Map<string, { ips: Set<string>; vendor: string; seenByHostname: string; seenByPort: string; location: string }>();
  const managedMacs = new Set(macToHostname.keys());

  let totalEntries = 0;

  for (const device of devices) {
    if (device.status !== 1) continue;
    const location = hostnameToLocation.get(device.hostname) ?? "Unknown";

    try {
      const entries = await fetchNdNeighbours(device.device_id);
      if (!isWebClientEnabled()) return;
      totalEntries += entries.length;

      for (const entry of entries) {
        const mac = normalizeMac(entry.mac);
        if (!mac || mac.length !== 12 || mac === "000000000000") continue;
        const ipv6 = entry.ipv6.trim();
        if (!ipv6) continue;

        // Only non-link-local, non-loopback addresses provide topology value
        const isGlobal = !ipv6.startsWith("fe80:") && ipv6 !== "::1";
        if (!isGlobal) continue;

        if (macToHostname.has(mac)) {
          // Known managed device — collect its global/ULA IPv6
          const hostname = macToHostname.get(mac)!;
          const list = ndGlobalIpv6.get(hostname) ?? [];
          if (!list.includes(ipv6)) list.push(ipv6);
          ndGlobalIpv6.set(hostname, list);
        } else if (!managedMacs.has(mac)) {
          // Unmanaged device visible only via ND
          const existing = ndUnmanaged.get(mac);
          if (existing) {
            existing.ips.add(ipv6);
          } else {
            ndUnmanaged.set(mac, { ips: new Set([ipv6]), vendor: entry.vendor, seenByHostname: device.hostname, seenByPort: entry.portName, location });
          }
        }
      }
    } catch { /* skip */ }
    await delay(STAGGER_MS);
  }

  cache.set("ndGlobalIpv6", ndGlobalIpv6, TTL.PORTS);

  // Merge ND-only unmanaged devices into existing arpDevices
  const existingArpDevices = cache.get<ArpDiscoveredDevice[]>("arpDevices") ?? [];
  const existingMacSet = new Set(existingArpDevices.map((d) => normalizeMac(d.mac)));

  const ndOnlyDevices: ArpDiscoveredDevice[] = [];
  for (const [mac, info] of ndUnmanaged) {
    if (existingMacSet.has(mac)) {
      // Enrich existing ARP entry with IPv6 addresses
      const existing = existingArpDevices.find((d) => normalizeMac(d.mac) === mac);
      if (existing) {
        for (const ip of info.ips) {
          if (!existing.ips.includes(ip)) existing.ips.push(ip);
        }
      }
      continue;
    }
    const siteId = info.location.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    ndOnlyDevices.push({
      mac,
      macs: [mac],
      ips: [...info.ips],
      vendor: info.vendor || lookupVendor(mac),
      location: info.location,
      siteId,
      seenByHostname: info.seenByHostname,
      seenByInterface: info.seenByPort,
      seenByIp: undefined,
      seenByMac: undefined,
    });
  }

  if (ndOnlyDevices.length > 0) {
    cache.set("arpDevices", [...existingArpDevices, ...ndOnlyDevices], TTL.PORTS);
  }

  console.log(`[poller] ND: ${totalEntries} entries scanned, ${ndGlobalIpv6.size} managed devices enriched, ${ndOnlyDevices.length} ND-only unmanaged devices`);
}
```

- [ ] **Step 4: Wire `pollNdNeighbours` into `warmCache`**

Find the `warmCache` function (around line 723):
```typescript
export async function warmCache() {
  console.log("[poller] Warming cache...");
  await loadOuiDatabases();
  await initWebSession();
  await pollDevicesAndLocations();
  await pollAlerts();
  await pollPortsAndIps();
  await pollRoutes();
  console.log("[poller] Cache warm complete");
}
```
Replace with:
```typescript
export async function warmCache() {
  console.log("[poller] Warming cache...");
  await loadOuiDatabases();
  await initWebSession();
  await pollDevicesAndLocations();
  await pollAlerts();
  await pollPortsAndIps();
  await pollRoutes();
  await pollNdNeighbours();
  console.log("[poller] Cache warm complete");
}
```

- [ ] **Step 5: Wire `pollNdNeighbours` into `startPoller`**

Find the `startPoller` function (around line 742):
```typescript
export function startPoller() {
  safeInterval(pollDevicesAndLocations, DEVICE_POLL_MS);
  safeInterval(pollPortsAndIps, TTL.PORTS);
  safeInterval(pollAlerts, TTL.ALERTS);
  safeInterval(pollRoutes, TTL.PORTS);
}
```
Replace with:
```typescript
export function startPoller() {
  safeInterval(pollDevicesAndLocations, DEVICE_POLL_MS);
  safeInterval(pollPortsAndIps, TTL.PORTS);
  safeInterval(pollAlerts, TTL.ALERTS);
  safeInterval(pollRoutes, TTL.PORTS);
  safeInterval(pollNdNeighbours, TTL.PORTS);
}
```

- [ ] **Step 6: TypeScript check**

```bash
cd /home/jkumar/Librenms-dash/backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/jobs/poller.ts
git commit -m "feat: add pollNdNeighbours — scrape IPv6 ND cache, enrich managed devices and discover ND-only unmanaged"
```

---

### Task 3: Inject ND global IPv6 into topology and device-overview routes

**Files:**
- Modify: `backend/src/routes/topology.ts` — inject `ndGlobalIpv6` into `DeviceSummary.ips[]` and `allIps[]`
- Modify: `backend/src/routes/devices.ts` — inject `ndGlobalIpv6` into device overview `deviceIps`

**Interfaces:**
- Consumes: cache key `"ndGlobalIpv6"` → `Map<string, string[]>` set by `pollNdNeighbours` in Task 2

- [ ] **Step 1: Inject into `backend/src/routes/topology.ts`**

Find the block starting with `// All addresses for search` (added in the previous IPv6 session, around line 63):
```typescript
    // All addresses for search — includes link-local, ULA, and loopback IPv6
    const allIpsSet = new Set<string>(deviceIps);
    for (const entry of ips) {
      if (entry.ipv4_address) allIpsSet.add(entry.ipv4_address);
      const v6 = entry.ipv6_compressed ?? entry.ipv6_address;
      if (v6) allIpsSet.add(v6);
    }
    if (device.ip) allIpsSet.add(device.ip);
```

Replace with:
```typescript
    // All addresses for search — includes link-local, ULA, and loopback IPv6
    const allIpsSet = new Set<string>(deviceIps);
    for (const entry of ips) {
      if (entry.ipv4_address) allIpsSet.add(entry.ipv4_address);
      const v6 = entry.ipv6_compressed ?? entry.ipv6_address;
      if (v6) allIpsSet.add(v6);
    }
    if (device.ip) allIpsSet.add(device.ip);

    // ND-scraped global IPv6 for this device (not available via REST API)
    const ndGlobalIpv6 = cache.get<Map<string, string[]>>("ndGlobalIpv6");
    const deviceNdV6 = ndGlobalIpv6?.get(device.hostname) ?? [];
    for (const v6 of deviceNdV6) {
      if (!deviceIps.includes(v6)) deviceIps.push(v6);
      allIpsSet.add(v6);
    }
```

- [ ] **Step 2: Inject into `backend/src/routes/devices.ts`**

Find the device overview's IP block (around line 73):
```typescript
  const deviceIps = findDeviceIps(ips, ports);
  if (device.ip && !deviceIps.includes(device.ip)) deviceIps.push(device.ip);
  const arpLanIps = cache.get<Map<string, string>>("arpLanIps");
  const arpLanIp = arpLanIps?.get(hostname);
  if (arpLanIp && !deviceIps.includes(arpLanIp)) deviceIps.unshift(arpLanIp);
```

Replace with:
```typescript
  const deviceIps = findDeviceIps(ips, ports);
  if (device.ip && !deviceIps.includes(device.ip)) deviceIps.push(device.ip);
  const arpLanIps = cache.get<Map<string, string>>("arpLanIps");
  const arpLanIp = arpLanIps?.get(hostname);
  if (arpLanIp && !deviceIps.includes(arpLanIp)) deviceIps.unshift(arpLanIp);
  const ndGlobalIpv6 = cache.get<Map<string, string[]>>("ndGlobalIpv6");
  for (const v6 of ndGlobalIpv6?.get(hostname) ?? []) {
    if (!deviceIps.includes(v6)) deviceIps.push(v6);
  }
```

- [ ] **Step 3: TypeScript check**

```bash
cd /home/jkumar/Librenms-dash/backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/topology.ts backend/src/routes/devices.ts
git commit -m "feat: inject ND-discovered global IPv6 into device IP lists and search"
```

---

### Task 4: Build and verify

- [ ] **Step 1: Docker build**

```bash
cd /home/jkumar/Librenms-dash && docker-compose up -d --build
```

Expected: build completes, container starts.

- [ ] **Step 2: Watch logs for ND poll output**

```bash
docker-compose logs -f 2>&1 | grep -E "\[poller\].*ND|Cache warm"
```

Expected (after cache warm completes):
```
[poller] ND: N entries scanned, M managed devices enriched, K ND-only unmanaged devices
[poller] Cache warm complete
```

If `LIBRENMS_USER`/`LIBRENMS_PASS` are not set, instead expect:
```
[web-client] Route polling disabled — LIBRENMS_USER/LIBRENMS_PASS not configured
[poller] Cache warm complete
```
(ND polling silently skips — correct behaviour.)

- [ ] **Step 3: Verify global IPv6 appears on managed devices**

Open the dashboard. Click a device known to have IPv6 on its LAN (e.g. the Ubiquiti or Raspberry Pi visible in the ND probe output). In the device popover IP rows, a `2406:…` global unicast address should now appear alongside the IPv4 address.

- [ ] **Step 4: Verify ND-only unmanaged devices appear**

If any MACs were found in ND but not in ARP, they appear as new unmanaged device boxes in the site they were seen in, showing their global or ULA IPv6 as the IP label.

- [ ] **Step 5: Verify search**

Type a partial `2406:` or the full global IPv6 of a managed device into the topology search bar. The device should highlight.
