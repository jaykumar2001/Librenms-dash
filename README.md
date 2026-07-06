<p align="center">
  <img src="frontend/public/favicon.svg" width="80" alt="LibreNMS-Dash logo" />
</p>

<h1 align="center">
  <img src="https://img.shields.io/badge/LibreNMS-74b743?style=flat-square&logoColor=white" alt="LibreNMS" height="24" />
  <img src="https://img.shields.io/badge/-Dash-334155?style=flat-square" alt="Dash" height="24" />
</h1>

<p align="center">
  <a href="https://github.com/jaykumar2001/Librenms-dash"><img src="https://img.shields.io/badge/license-GPLv3-blue.svg" alt="License" /></a>
</p>

**LibreNMS-Dash** is a LibreNMS-backed network dashboard. It aggregates devices, sites, overlays, alerts, and graphs into a single topology view with live hover details and SVG-based layout controls.

Demo Site: https://librenms-dash.github.io/

## Getting Started

> **Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) — no other local dependencies required.

```bash
# 1. Clone the repo
git clone https://github.com/jaykumar2001/Librenms-dash.git
cd Librenms-dash

# 2. Configure your environment
cp .env.example .env
#    Edit .env and set:
#      LIBRENMS_URL   — your LibreNMS instance URL
#      LIBRENMS_TOKEN — your LibreNMS API token
#      LIBRENMS_USER / LIBRENMS_PASS — optional, enables route table polling
#      AUTH_USERNAME / AUTH_PASSWORD — dashboard login credentials

# 3. Build and start
docker compose up -d --build
```

The dashboard is now available at **`http://<your-host-ip>:3001`**.

---

## What It Shows

- Devices grouped by LibreNMS `location`
- Overlay links for ZeroTier, WireGuard, Tailscale, GRE, IPSec, Tinc, PPTP, Tunnel, and TAP (auto-detected by interface name)
- LLDP/CDP neighbor links
- ARP-derived links, filtered to same-location devices
- Discovered (unmanaged) devices seen via ARP/ND, with staleness tracking — a device that stops responding dims for 15 minutes before being removed after 24 hours, instead of vanishing after a single missed poll
- Per-device IPv4 routing tables (next-hop, destination, interface)
- Device hover popovers with traffic and health graphs
- Real-time asset change notifications via SSE (device/port/IP added or removed)
- MAC vendor lookups via IEEE OUI databases
- Drag, snap, resize, and orientation controls for site boxes
- Pinch and scroll zoom with persisted viewport

<img width="1510" height="745" alt="image" src="https://github.com/user-attachments/assets/3d73dc35-7e06-448d-9979-1eb95d8d036b" />

## Repository Layout

- `backend/` - Hono API server, LibreNMS polling, in-memory cache
- `frontend/` - React + Vite topology UI
- `shared/` - TypeScript contracts shared by both packages

## Requirements

- Node.js 22+
- pnpm 10+
- A reachable LibreNMS instance and API token
- Docker and Docker Compose if you want the containerized runtime

## Environment

The backend reads:

```bash
LIBRENMS_URL=https://librenms.local.lan
LIBRENMS_TOKEN=<token>
LIBRENMS_USER=<username>   # optional — enables route table polling
LIBRENMS_PASS=<password>   # optional — enables route table polling
AUTH_USERNAME=admin         # required — dashboard login username
AUTH_PASSWORD=changeme      # required — dashboard login password
PORT=3001
NODE_ENV=development
```

For local development, put these in `.env`. For Docker Compose, the values are read from the environment and passed into the container. See [`.env.example`](.env.example) for the full list.

### Network ranges

No subnets are hard-coded. Overlay address ranges and ARP exclusions are configured via environment variables (all optional):

- `ZEROTIER_SUBNETS`, `WIREGUARD_SUBNETS`, `TAILSCALE_SUBNETS` — comma-separated CIDRs used to recognise overlay addresses by IP. Interface-name detection (`zt*`/`wg*`/`tailscale*`) always works regardless. Tailscale defaults to its standard CGNAT block (`100.64.0.0/10`).
- `ARP_EXCLUDED_SUBNETS` — comma-separated CIDRs to ignore when scanning ARP tables (in addition to the overlay subnets). Defaults to loopback and link-local.

### Route table polling

Setting `LIBRENMS_USER` and `LIBRENMS_PASS` enables per-device IPv4 routing table collection. The backend authenticates to the LibreNMS web UI and fetches route data (destination, prefix, next-hop, interface, protocol) for each monitored device. Only remote routes with real next-hops are included.

If the credentials are missing or invalid, route polling is silently disabled with a single log line — no other features are affected.

## Local Development

Install dependencies:

```bash
pnpm install
```

Download the IEEE OUI databases used for MAC vendor lookups (the Docker build does this automatically; vendor lookup is simply disabled if they are absent):

```bash
./scripts/download-oui.sh
```

Run backend and frontend together:

```bash
pnpm dev
```

This starts:

- Backend on `http://localhost:3001`
- Frontend on `http://localhost:5173`

The frontend proxies `/api/*` to the backend in development.

Build both packages:

```bash
pnpm build
```

Start the backend in production mode after building:

```bash
pnpm start
```

## Docker Compose

Build and start the production container:

```bash
docker compose up -d --build
```

The service listens on `http://localhost:3001` and serves both the API and the built frontend.

`docker-compose.yaml` also sets:

- `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed LibreNMS certificates
- `extra_hosts` / `dns`, driven by the optional `LIBRENMS_HOSTNAME`, `LIBRENMS_HOST_IP`, and `LOCAL_DNS` variables (ignored under `network_mode: host`, where the container uses the host's resolver)

## API

The backend exposes:

- `GET /api/health`
- `GET /api/topology`
- `GET /api/devices/:hostname/overview`
- `GET /api/ports/:hostname`
- `GET /api/graph/device/:hostname/:type`
- `GET /api/graph/icon/:icon`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/events/stream` (SSE)

All `/api/*` routes except `/api/auth` and `/api/health` require a valid session cookie.

`GET /api/topology` is the main payload for the map. It includes:

- sites (each device includes an optional `routes` array when route polling is enabled)
- overlay links
- LLDP/CDP neighbor links
- ARP links
- alerts
- last update time

## Topology Interactions

In the map view:

- Drag a site box to reposition the whole site
- Drag a device box to move a single device
- Use the grid toggle to enable snapping
- Resize a site box from the bottom-right handle
- Toggle site orientation between landscape and portrait
- Use the overlay buttons to show or hide link groups
- Use `Reset Layout` to return to the generated layout

When a device moves, its category underlay and connected links update. When a site is resized, devices inside the site are repacked to use the new space.

## Notes

- ARP links are filtered so devices in different LibreNMS locations do not form a link.
- The backend caches LibreNMS data in memory with TTL-based refreshes. The device list (status, uptime, `last_polled`) is refreshed every 5 minutes; ports and alerts on their own intervals.
- Discovered (ARP/ND) devices are tracked separately in an in-memory registry keyed by MAC, not a simple TTL cache — see [`docs/arp-deduplication-and-correlation.md`](docs/arp-deduplication-and-correlation.md#stage-5--staleness--retention) for how staleness and 24-hour retention work.
- The production build bundles the frontend into `frontend/dist` and serves it from the backend process.

## Security

This dashboard is designed for a trusted LAN / management network. Be aware of its trust model before exposing it:

- **Simple authentication.** The dashboard requires a username and password (`AUTH_USERNAME` / `AUTH_PASSWORD` environment variables). Sessions are stored in-memory and are lost on restart. This is suitable for a trusted network but is not a substitute for a proper identity provider — do not expose port `3001` to untrusted networks without an additional layer such as a VPN, an authenticating reverse proxy, or a firewall.
- **TLS verification is disabled for LibreNMS** when `LIBRENMS_URL` is HTTPS, to accommodate self-signed certificates. This affects outbound TLS for the backend process, which only ever talks to the configured LibreNMS instance.
- **The graph/icon endpoints proxy to LibreNMS** using the API token. User-supplied path segments are URL-encoded to prevent traversal, but the backend is still a privileged client of LibreNMS — keep it on the same trust boundary as LibreNMS itself.

## License

Licensed under the GNU General Public License v3.0 (or later). See [LICENSE](LICENSE) for the full text.
