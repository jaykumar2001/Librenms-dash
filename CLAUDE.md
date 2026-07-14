# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A LibreNMS-backed network topology dashboard: it polls a LibreNMS instance's API, derives sites,
devices, overlay/LLDP/ARP links, routes, and alerts from it, and renders everything as one
interactive SVG map with live SSE updates. See README.md for features and API reference; AGENTS.md
holds the behavioral guidelines (surgical changes, simplicity first, Docker as source of truth) —
this file focuses on what you need to work in the code.

This repo is part of a multirepo dashboard family with its sibling `../MTR-dash` — see
`~/Github/CLAUDE.md` for the cross-repo component/layout reuse goal.

## Commands

pnpm workspace (`backend`, `frontend`, `shared`) — run everything from the repo root.

```bash
pnpm install
pnpm dev                     # backend :3001 (tsx watch) + frontend :5173 (vite, proxies /api)
pnpm build                   # frontend (tsc -b && vite), then backend (esbuild bundle → dist/)
pnpm start                   # NODE_ENV=production node backend/dist/index.js
pnpm --filter backend test   # vitest
pnpm --filter backend exec vitest run src/jobs/arpDeviceRegistry.test.ts  # single file
./scripts/download-oui.sh    # IEEE OUI DBs for MAC vendor lookup (optional; Docker build does it)
docker compose up -d --build # the real pipeline — verify with this before calling work done
```

- A `.env` at the repo root is **required to even start**: `backend/src/config.ts` throws at import
  time without `LIBRENMS_TOKEN`, `AUTH_USERNAME`, and `AUTH_PASSWORD`. See `.env.example`.
- No ESLint/Prettier — `tsc` (strict in all three packages) and vitest are the only checks.
- The frontend has no test script; the only tests in the repo are backend
  (`jobs/arpDeviceRegistry.test.ts`).

## Architecture

### Shared types are the API contract

`shared/types.ts` (`@librenms-dash/shared`, a workspace package) defines `TopologyResponse`,
`DeviceSummary`, `AssetEvent`, etc. Both backend and frontend import it — change the contract
there first, and both packages' `tsc` will surface the fallout.

### No database — everything lives in one in-memory TTLCache

`cache/store.ts` exports a single `TTLCache` singleton plus the `TTL` constants table. All
LibreNMS-derived state is cached under string keys (`devices`, `locations`, `alerts`, `links`,
`ports:<hostname>`, `ips:<hostname>`, `routes:<hostname>`, …). Nothing persists across restarts
(sessions included). Consequence: startup must warm the cache before the app is usable.

### Warm → poll → rebuild → diff → SSE pipeline (`jobs/poller.ts`)

This ~1,000-line file is the heart of the backend:

1. **Warming**: `index.ts` starts listening immediately, but a middleware returns 503 for
   `/api/*` (except auth/health) until `warmCache()` finishes loading OUI DBs, the web session,
   devices/locations, alerts, ports/IPs, routes, and ND neighbours. `/api/health` reports
   `"warming"`, and `/api/health/stream` (SSE) fires a `ready` event the moment the cache is warm
   — the frontend's `useTopology` listens to it instead of hammering retries.
2. **Polling**: `startPoller()` registers one `safeInterval` per domain (devices/locations every
   5 min, ports+overlays 5 min, alerts 2 min, routes and ND neighbours 5 min). `safeInterval`
   exists so a rejected poll logs instead of crashing the process.
3. **Rebuild**: after each poll writes its raw entities into the cache, `buildAndCacheTopology()`
   recomputes the entire `TopologyResponse` from cache (sites from LibreNMS `location`, per-device
   traffic totals, LLDP/CDP neighbor links deduped and interface-filtered, overlay links via the
   `OverlayEngine`, ARP links/devices).
4. **Diff + push**: changes against the previous snapshot become `AssetEvent`s (device/port/IP
   added/removed) pushed to SSE subscribers, and a `topology-changed` SSE event carrying the
   **full new `TopologyResponse` payload** goes out via `routes/events.ts`.

### LibreNMS access is two clients, not one

`librenms/client.ts` is the token-authenticated REST client (all normal polling).
`librenms/web-client.ts` logs into the LibreNMS **web UI** with `LIBRENMS_USER`/`LIBRENMS_PASS`
to scrape per-device route tables — data the API doesn't expose. If those creds are missing or
wrong, route polling silently disables itself with one log line; nothing else is affected.
`config.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide when `LIBRENMS_URL` is HTTPS
(self-signed certs) — acceptable only because this process talks solely to LibreNMS.

### Overlay classification (`librenms/overlayEngine.ts`)

`OverlayEngine` recognizes overlay membership two ways: interface name (`zt*`, `wg*`,
`tailscale*`, GRE/IPSec/…, always on) and configured subnets. Subnet config flows through env
vars parsed in `config.ts`: `OVERLAY_EXTRA` (`type:cidr,…`) is the canonical form; legacy
`ZEROTIER_SUBNETS`/`WIREGUARD_SUBNETS`/`TAILSCALE_SUBNETS` are folded into it.
`OVERLAY_RECLASSIFY`, `OVERLAY_TOPOLOGY` (mesh vs hub-spoke), and `OVERLAY_HUB` tune link
generation per overlay network.

### ARP-discovered devices (`jobs/arpDeviceRegistry.ts`)

Unmanaged devices seen via ARP/ND live in a separate in-memory registry keyed by MAC — not the
TTL cache — with staleness semantics (dim after 15 min unseen, drop after 24 h) so a device
doesn't vanish on a single missed poll. This is the repo's most subtle logic and its only tested
module; the full design (dedup, correlation, retention stages) is in
`docs/arp-deduplication-and-correlation.md`. Read that doc before touching ARP consolidation in
`poller.ts` (`pollArpLinks`, `consolidateArpDevices`).

### Auth

Cookie sessions stored in-memory (`auth/sessions.ts`) — restart logs everyone out, by design.
`middleware/auth.ts`'s `requireAuth()` guards all `/api/*` except `/api/auth` and `/api/health`.
Single fixed credential pair from env; there is deliberately no user management.

### Frontend

- **Server state is TanStack Query**, nothing else: `hooks/useTopology.ts` owns the `["topology"]`
  query (refetch every 5 min steady, every 10 s while ARP data is still incomplete, and a
  `ServerWarmingError` from `lib/api.ts` switches it to waiting on `/api/health/stream`).
- **SSE carries data, not just a signal**: `hooks/useSSE.ts` subscribes to `/api/events/stream`;
  `topology-changed` events contain the full `TopologyResponse` and are written straight into the
  query cache with `setQueryData`. (`init`/`events` feed the asset-event toast list, capped at
  200.) On SSE reconnect it invalidates the query to resync anything missed. Note this differs
  from MTR-dash, where SSE is a signal that triggers a REST re-fetch.
- **`components/TopologyMap.tsx` (~1,450 lines) is the whole map view**: a pan/zoom SVG with site
  boxes, device nodes, link groups (overlay/LLDP/ARP toggles), hover/pinned tooltips, and search.
  Viewport transform and layout are persisted to `localStorage` (`usePersistedLayout`, debounced
  transform writes). Generated layout comes from `hooks/useForceLayout.ts` (d3-force) plus
  `hooks/layout/separation.ts` — the same collision-separation approach as MTR-dash's
  `lib/separation.ts`; keep the two implementations aligned when fixing either.
- **Styling is Tailwind CSS 4** (`@tailwindcss/vite`, utility classes inline; `styles.css` holds
  only globals/keyframes). This is a known divergence from MTR-dash's CSS-custom-property theming.
- There is **no routing**: `App.tsx` renders login → dashboard directly.

## Scope constraint

Built for a trusted LAN / management network. The simple env-var login is intentional — don't add
identity-provider integration, user management, or per-user access control unless explicitly
asked. The backend is a privileged LibreNMS client; keep it on the same trust boundary as
LibreNMS itself.
