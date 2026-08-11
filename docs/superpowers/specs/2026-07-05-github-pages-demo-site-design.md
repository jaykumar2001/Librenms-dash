# GitHub Pages Demo Site — Design

## Goal

Build a public, static demo of the Librenms-dash topology UI at
`/home/jkumar/librenms-dash.github.io`, reusing the real frontend components
and a real (but fully anonymized) topology snapshot from the currently
running app, with no backend, no auth wall, and no live network calls.

## Current app snapshot (for scale reference)

Pulled from the running instance at design time: 6 sites (BLR-R, Singapore,
BLR, GGN, DXB, BLR-L), 27 managed devices, 4 overlay networks
(WireGuard/ZeroTier/Tailscale mesh + hub-spoke), 49 neighbor links, 59 ARP
links, 139 discovered ARP-only devices, 0 active alerts.

Identifying data present in the raw snapshot that must not reach the demo
repo: device `hostname`/`ip` (in this deployment `hostname` is itself a
Tailscale CGNAT IP), `displayName`, `lanIp`, `ips[]`, `allIps[]`, `macs[]`,
site `location`/`id`/`lat`/`lng` (real GPS coordinates), overlay
`subnet`/`from`/`to`/`fromIp`/`toIp`, ARP-device `mac`/`ips`/`seenBy*`,
neighbor link hostnames, alert hostnames, route `dest`/`nextHop`/
`nextHopDevice`, device `serial`, `sysContact`, and any of the above echoed
into free-text fields (`sysDescr`, `ifAlias`, alert `rule`).

## Repo & build

- Standalone Vite + React + TypeScript + Tailwind app at the repo root of
  `librenms-dash.github.io`. Independent of the private `Librenms-dash`
  repo — components are copied in, not shared via a workspace package.
- `vite.config.ts`: `build.outDir = "docs"`. No dev-server API proxy needed
  (no backend). Base path `/` (this is a `<user>.github.io` apex site).
- GitHub Pages configured to serve from the `main` branch `/docs` folder.
  Deploy = `npm run build` locally, commit the regenerated `docs/` output,
  push. No GitHub Actions workflow.

## Data pipeline (one-time, not part of the runtime app)

A Node script run once against the currently running app, output committed
to the demo repo as static JSON. Not re-run automatically; re-run manually
if the demo data ever needs refreshing from a newer snapshot.

1. **Fetch** — authenticate against the running backend
   (`POST /api/auth/login` with the dev credentials) and pull
   `GET /api/topology`, `GET /api/devices/:hostname/overview` for every
   device, and the distinct icon filenames referenced. Raw output goes to a
   gitignored scratch path, never committed.
2. **Build remap tables** (real value → fake value, stable across the
   whole dataset — the same real value always produces the same fake
   value everywhere it appears):
   - **IPv4/IPv6** — bucketed by real subnet/prefix, remapped into
     documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`,
     `203.0.113.0/24`, `2001:db8::/32`). Same real `/24` (or v6 prefix)
     always maps to the same fake `/24`, preserving overlay-mesh and
     subnet-grouping structure in the visualization.
   - **MACs** — random locally-administered MACs (`02:...`, U/L bit set),
     same string format (colon-less uppercase hex) as the source data.
   - **Hostnames / displayNames** — role-based fake names
     (`core-sw-01.demo.lan`, `edge-fw-02.demo.lan`, ...), role inferred
     from naming hints in the real `displayName` (sw/rtr/fw/ap/srv) or,
     failing that, fan-out position in the topology (high-degree = core,
     leaf = access).
   - **Sites** — real location/id → fixed pool (`HQ`, `Branch-East`,
     `Branch-West`, `Datacenter-1`, ...). `lat`/`lng` set to `null`
     (confirmed unused anywhere in the frontend — safe to drop rather than
     fake).
   - **Serials** → `DEMO-XXXXXXXX`. **sysContact** → generic/empty.
3. **Global free-text scrub** — after structural remapping, recursively
   walk the entire JSON tree (including `sysDescr`, `ifAlias`, alert
   `rule`, `nextHopDevice`) and string-replace any remaining occurrence of
   a real hostname/IP/MAC/site name, to catch values embedded in
   descriptive text that field-level remapping alone would miss.
4. **Manual review** — grep the anonymized output for the original real
   identifiers (site codes, real IP octets, real MAC prefixes) as a final
   check before anything is committed.
5. `commitSha` dropped from the payload; `lastUpdated` fixed to a static
   demo timestamp.

Output committed to the demo repo: `src/data/topology.json`,
`src/data/deviceOverviews.json` (keyed by fake hostname), and
`public/icons/*` (the ~8-10 distinct generic OS/vendor icon files actually
referenced — not device-specific, safe to bundle as-is).

## Component reuse

**Copied unchanged** (pure presentation, no backend coupling):
`TopologyMap`, `SiteGroup`, `DeviceNode`, `ArpDeviceNode`, `OverlayLink`,
`HoverableLinkPath`, `LinkTooltip`, `Copyable`, `Logo`, `AssetEventToast`,
`useForceLayout`, `usePersistedLayout`, `useLocalStorage`,
`lib/linkGeometry.ts`, `lib/format.ts`, `styles.css`, and the relevant
`shared/types.ts` interfaces (copied in locally — no workspace package).

**Rewritten** (backend calls replaced with static data):
- `useTopology` — reads the bundled `topology.json` directly. No fetch, no
  polling interval, no `/api/health/stream` warm-up check.
- `useDeviceDetail` / `lib/api.ts` — reads `deviceOverviews.json` by
  hostname instead of calling `/api/devices/:hostname/overview`.
- `iconUrl` — points at bundled `public/icons/*`.
- `useSSE` → new `useDemoEvents` hook: a client-side interval timer that
  periodically fires a synthetic `AssetEvent` toast drawn from the
  anonymized ARP-device pool. Cosmetic only (feeds `AssetEventToast`) — it
  does not mutate the topology graph, so the force layout stays stable.
- `DevicePopover` — the CPU/memory `<img src={graphUrl(...)}>` elements are
  replaced with a new `Sparkline` component that renders deterministic fake
  trend data seeded from `device_id` (stable across reloads, not
  re-randomized per render).

**Dropped**: `AuthContext`, `AuthScreen`, `LoginPage`, `lib/auth.ts`.
`App.tsx` renders the topology view directly — no login gate.

## Testing / verification

- `npm run build` in the demo repo must succeed (tsc + vite build) with the
  static data bundled.
- Manual browser check: topology renders, site grouping/overlay links
  render correctly (subnet-preserving remap didn't break grouping), device
  popovers open and show sparkline + anonymized fields, no console errors
  from missing backend endpoints.
- Grep-based anonymization audit: confirm none of the original real site
  codes, IP octets, or MAC prefixes appear anywhere under `src/data/` or
  `public/` in the demo repo before first commit.
