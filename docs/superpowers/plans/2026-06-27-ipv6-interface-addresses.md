# IPv6 Interface Addresses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface IPv6 addresses from the existing LibreNMS per-device IP endpoint into the topology device summaries, device detail interface list, and asset change-detection events.

**Architecture:** Three surgical edits across two backend files and one frontend component. No new API calls, no new cache keys, no type changes. The `findDeviceIps()` function and `DeviceSummary.ips[]` pipeline already handle IPv6 correctly; these tasks close the two remaining gaps and fix the frontend display width.

**Tech Stack:** TypeScript (Bun runtime), Hono, React + Tailwind, Docker Compose.

## Global Constraints

- Verify all changes with `docker-compose up -d --build` — not bare `tsc`.
- Do not add imports not already used elsewhere in the file.
- Do not modify `shared/types.ts`, `overlays.ts`, or any frontend file other than `DevicePopover.tsx`.
- Match existing code style exactly (no trailing commas where absent, same indent).

---

### Task 1: Add IPv6 to per-interface IP list in device overview

**Files:**
- Modify: `backend/src/routes/devices.ts:52-59`

**Context:** The `/overview` handler builds an `ipsByPort` map (`Map<number, string[]>`) that drives `DeviceInterface.ips[]` — the per-interface IP list shown in the device detail popover. It currently only reads `ip.ipv4_address`. `LnmsDeviceIp` already has optional `ipv6_compressed` and `ipv6_address` fields populated when LibreNMS has IPv6 data for that port.

**Interfaces:**
- Consumes: `LnmsDeviceIp` (fields: `port_id: number`, `ipv4_address: string`, `ipv6_compressed?: string`, `ipv6_address?: string`)
- Produces: `ipsByPort: Map<number, string[]>` — now contains both IPv4 and IPv6 addresses per port

- [ ] **Step 1: Locate the ipsByPort loop**

Open `backend/src/routes/devices.ts`. Find lines 52–59:

```typescript
  const ipsByPort = new Map<number, string[]>();
  for (const ip of ips) {
    if (!ip.ipv4_address) continue;
    const arr = ipsByPort.get(ip.port_id);
    if (arr) arr.push(ip.ipv4_address);
    else ipsByPort.set(ip.port_id, [ip.ipv4_address]);
  }
```

- [ ] **Step 2: Replace the loop to include IPv6**

Replace those 7 lines with:

```typescript
  const ipsByPort = new Map<number, string[]>();
  for (const ip of ips) {
    const addrs: string[] = [];
    if (ip.ipv4_address) addrs.push(ip.ipv4_address);
    const v6 = ip.ipv6_compressed ?? ip.ipv6_address;
    if (v6) addrs.push(v6);
    if (addrs.length === 0) continue;
    const arr = ipsByPort.get(ip.port_id);
    if (arr) for (const a of addrs) arr.push(a);
    else ipsByPort.set(ip.port_id, addrs);
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/devices.ts
git commit -m "feat: include IPv6 addresses in per-interface IP list"
```

---

### Task 2: Add IPv6 to asset change-detection set

**Files:**
- Modify: `backend/src/jobs/poller.ts:189-191`

**Context:** `pollPortsAndIps` builds `currIps` — a `Set<string>` of `"hostname addr"` strings — and diffs it against `prevAssets.ips` to emit add/remove asset events. Currently it only tracks `ipv4_address`. IPv6 addresses silently appear and disappear.

**Interfaces:**
- Consumes: `allIps: Map<string, LnmsDeviceIp[]>` (populated earlier in same function)
- Produces: `currIps: Set<string>` — now includes IPv6 entries in the form `"hostname addr"`

- [ ] **Step 1: Locate the currIps loop**

Open `backend/src/jobs/poller.ts`. Find lines ~189-191:

```typescript
  for (const [hostname, ips] of allIps) {
    for (const ip of ips) if (ip.ipv4_address) currIps.add(`${hostname} ${ip.ipv4_address}`);
  }
```

- [ ] **Step 2: Replace to include IPv6**

Replace those 3 lines with:

```typescript
  for (const [hostname, ips] of allIps) {
    for (const ip of ips) {
      if (ip.ipv4_address) currIps.add(`${hostname} ${ip.ipv4_address}`);
      const v6 = ip.ipv6_compressed ?? ip.ipv6_address;
      if (v6 && !v6.startsWith("fe80:") && v6 !== "::1") currIps.add(`${hostname} ${v6}`);
    }
  }
```

The `fe80:` and `::1` guards prevent link-local and loopback churn from generating spurious add/remove events on every poll cycle.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/jobs/poller.ts
git commit -m "feat: track IPv6 addresses in asset change-detection"
```

---

### Task 3: Truncate IPv6 in the interface table with copy-on-click

**Files:**
- Modify: `frontend/src/components/DevicePopover.tsx:287-295`

**Context:** The interfaces table shows one row per interface with columns: Name, MAC, IPs. Each IP is rendered as `<Copyable text={ip}>{ip}</Copyable>` inside a `<div>`. Without `block` on `<Copyable>`, the span is `inline` and does not truncate. IPv6 addresses (up to 39 chars) widen the entire table.

`Copyable` already has `title={text}` (hover shows full address) and applies `block truncate` when the `block` prop is passed. Adding `overflow-hidden` to the `<td>` ensures `truncate` activates correctly in table layout.

**Interfaces:**
- Consumes: `iface.ips: string[]` — array of IPv4 and/or IPv6 address strings
- Produces: visual truncation in the IPs column; hover tooltip shows full address; click copies full address

- [ ] **Step 1: Locate the IPs td in the interfaces table**

Open `frontend/src/components/DevicePopover.tsx`. Find lines ~287-295:

```tsx
                      <td className="py-0.5 px-2 font-mono text-gray-300">
                        {iface.ips.length > 0
                          ? iface.ips.map((ip) => (
                              <div key={ip} className="leading-tight">
                                <Copyable text={ip}>{ip}</Copyable>
                              </div>
                            ))
                          : "—"}
                      </td>
```

- [ ] **Step 2: Add overflow-hidden to the td and block prop to Copyable**

Replace those 9 lines with:

```tsx
                      <td className="py-0.5 px-2 font-mono text-gray-300 overflow-hidden">
                        {iface.ips.length > 0
                          ? iface.ips.map((ip) => (
                              <div key={ip} className="leading-tight">
                                <Copyable text={ip} block>{ip}</Copyable>
                              </div>
                            ))
                          : "—"}
                      </td>
```

The only changes are: `overflow-hidden` added to `<td>` className, and `block` prop added to `<Copyable>`. `Copyable` with `block` renders as `display:block; overflow:hidden; text-overflow:ellipsis`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DevicePopover.tsx
git commit -m "feat: truncate IPv6 in interface table, copy-on-click preserved"
```

---

### Task 4: Build and verify

**Files:** none (verification only)

- [ ] **Step 1: Build and start containers**

```bash
docker-compose up -d --build
```

Expected: build succeeds, both `backend` and `frontend` containers start without errors. Check with:

```bash
docker-compose logs --tail=30
```

Expected: `[librenms-dash] Cache warm complete` in backend logs, no TypeScript or React build errors.

- [ ] **Step 2: Visual check — device IP rows**

Open the dashboard. Click any device with known IPv6 on its interfaces. In the device popover:
- The main IP rows should show IPv6 addresses (e.g. `2001:db8::1`) alongside IPv4.
- Long IPv6 strings should be truncated with `…` — hovering shows the full address.
- Clicking an IPv6 address copies it (text turns green briefly).

- [ ] **Step 3: Visual check — interface table**

Scroll to the Interfaces section of the same popover:
- The IPs column should show both IPv4 and IPv6 for dual-stack interfaces.
- IPv6 is truncated to fit the column width — no table widening.
- Hovering an IPv6 cell shows the full address in the browser tooltip.
- Clicking copies the full address.

- [ ] **Step 4: Check asset change log (optional)**

In the dashboard asset event log, restart the backend and wait for the first full poll. If any device has IPv6 addresses, you should see `ip added: hostname 2001:...` events on first run (baseline), then silence on subsequent polls.
