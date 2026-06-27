# IPv6 Interface Addresses in Topology

**Date:** 2026-06-27
**Scope:** Surface IPv6 addresses already present in LibreNMS per-device IP data into the topology and device detail views.

## Background

Probing confirmed that this LibreNMS instance has no working IPv6 ND (Neighbor Discovery) REST API — global ND endpoints return 404, per-device endpoints return 500. The only available source of IPv6 data is the existing `/devices/{hostname}/ip` endpoint already polled in `pollPortsAndIps`.

`LnmsDeviceIp` already has optional `ipv6_address` / `ipv6_compressed` / `ipv6_prefixlen` / `ipv6_origin` fields. `findDeviceIps()` in `overlays.ts` already reads them and applies correct filters (drops link-local `fe80::`, loopback `::1`, ULA `fc/fd`). So `DeviceSummary.ips[]` flows IPv6 to the frontend whenever LibreNMS returns it.

Two backend gaps remain unfixed, plus the frontend interface table needs truncation for IPv6 widths.

## Changes

### 1. `backend/src/routes/devices.ts` — `ipsByPort` map

**Where:** lines 52–59, inside the `/overview` handler.

**Problem:** The map that builds per-interface IP lists (`port_id → string[]`) only reads `ip.ipv4_address`. IPv6 addresses on a port never appear in `DeviceInterface.ips[]`.

**Fix:** Also read `ip.ipv6_compressed ?? ip.ipv6_address` and add it to the same map entry. No filter needed here — the interface detail view benefits from showing all addresses including link-local.

### 2. `backend/src/jobs/poller.ts` — `currIps` change-detection set

**Where:** lines 189–191, inside `pollPortsAndIps`.

**Problem:** The set that drives asset change events only tracks `hostname ipv4_address`. IPv6 addresses appearing or disappearing go undetected.

**Fix:** For each `LnmsDeviceIp`, also add `hostname ipv6_compressed` (or `ipv6_address`) to `currIps`. Skip link-local (`fe80:`) and loopback (`::1`) to avoid noisy events.

### 3. `frontend/src/components/DevicePopover.tsx` — interface IPs column

**Where:** lines 287–295, the IPs `<td>` in the interfaces table.

**Problem:** Each IP is rendered in a plain `<div>` with `<Copyable>` but no `block` prop, so IPv6 addresses (up to 39 chars) widen the column.

**Fix:**
- Add `overflow-hidden` to the `<td>`.
- Pass `block` prop to `<Copyable>` — this adds `block truncate` CSS, clamping the text to the cell width. The existing `title={text}` on `Copyable` already shows the full address on hover. Copy-on-click already works via `Copyable`.

The main device IP rows (lines 133–140) already pass `block` and sit inside a `table-fixed` table, so they are already correct.

## What is NOT changing

- `LnmsDeviceIp` type — already has IPv6 fields.
- `findDeviceIps()` — already handles IPv6 correctly.
- `DeviceSummary.ips[]` / `Device.ips[]` — already include IPv6 when present.
- `DeviceSummary.macs[]` — already sourced from port `ifPhysAddress` (no change).
- Frontend search, device node labels, topology links — already consume `ips[]`.
- No new API calls, no new cache keys, no shared type changes.

## Verification

1. `docker-compose up -d --build` succeeds.
2. Open device popover for a device with known IPv6 addresses — IPv6 appears in the IP rows and in the per-interface IPs column.
3. IPv6 in the interface column is truncated with `…`; hovering shows the full address; clicking copies it.
4. Asset event log shows IPv6 add/remove events when an interface's IPv6 changes.
