# LibreNMS-Dash

LibreNMS-Dash is a LibreNMS-backed network dashboard. It aggregates devices, sites, overlays, alerts, and graphs into a single topology view with live hover details and SVG-based layout controls.

## What It Shows

- Devices grouped by LibreNMS `location`
- Overlay links for ZeroTier, WireGuard, and Tailscale
- LLDP/CDP neighbor links
- ARP-derived links, filtered to same-location devices
- Device hover popovers with traffic and health graphs
- Drag, snap, resize, and orientation controls for site boxes

## Repository Layout

- `backend/` - Hono API server, LibreNMS polling, in-memory cache
- `frontend/` - React + Vite topology UI
- `shared/` - TypeScript contracts shared by both packages
- `docs/` - Project notes and design/spec documentation

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
PORT=3001
NODE_ENV=development
```

For local development, put these in `.env`. For Docker Compose, the values are read from the environment and passed into the container. See [`.env.example`](.env.example) for the full list.

### Network ranges

No subnets are hard-coded. Overlay address ranges and ARP exclusions are configured via environment variables (all optional):

- `ZEROTIER_SUBNETS`, `WIREGUARD_SUBNETS`, `TAILSCALE_SUBNETS` — comma-separated CIDRs used to recognise overlay addresses by IP. Interface-name detection (`zt*`/`wg*`/`tailscale*`) always works regardless. Tailscale defaults to its standard CGNAT block (`100.64.0.0/10`).
- `ARP_EXCLUDED_SUBNETS` — comma-separated CIDRs to ignore when scanning ARP tables (in addition to the overlay subnets). Defaults to loopback and link-local.

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

`GET /api/topology` is the main payload for the map. It includes:

- sites
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
- The production build bundles the frontend into `frontend/dist` and serves it from the backend process.

## Security

This dashboard is designed for a trusted LAN / management network. Be aware of its trust model before exposing it:

- **No authentication.** Every API endpoint (and the bundled frontend) is served without a login. Anyone who can reach the backend port can read the full device inventory, IP addresses, serials, and topology. Do not expose port `3001` to untrusted networks — put it behind a VPN, an authenticating reverse proxy, or a firewall.
- **TLS verification is disabled for LibreNMS** when `LIBRENMS_URL` is HTTPS, to accommodate self-signed certificates. This affects outbound TLS for the backend process, which only ever talks to the configured LibreNMS instance.
- **The graph/icon endpoints proxy to LibreNMS** using the API token. User-supplied path segments are URL-encoded to prevent traversal, but the backend is still a privileged client of LibreNMS — keep it on the same trust boundary as LibreNMS itself.

## Further Reading

- [Project design notes](docs/specs/2026-06-03-librenms-dash-design.md)

## License

Licensed under the GNU General Public License v3.0 (or later). See [LICENSE](LICENSE) for the full text.
