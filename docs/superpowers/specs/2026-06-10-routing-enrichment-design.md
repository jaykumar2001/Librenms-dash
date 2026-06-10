# Routing Data Enrichment

Enrich the topology with per-device IPv4 routing table data (next-hop, destination, interface, protocol) fetched from LibreNMS's internal web UI endpoint.

## Context

LibreNMS stores routing tables in a `route` MySQL table, populated via SNMP `inetCidrRouteTable` during device discovery. The REST API endpoint (`/devices/{id}/routes`) is broken (returns 500), but the web UI's internal AJAX endpoint (`POST ajax/table/routes`) works and returns the data. This requires web session authentication (username/password + CSRF token), separate from the existing API token auth.

## Graceful degradation

If `LIBRENMS_USER` or `LIBRENMS_PASS` are missing from `.env`, or if login fails (wrong credentials, LibreNMS unreachable), print one log line: `[web-client] Route polling disabled — missing or invalid LIBRENMS_USER/LIBRENMS_PASS` and disable route polling for the current run. No exceptions thrown, no retries, no effect on other features.

## New file: `backend/src/librenms/web-client.ts`

Manages a LibreNMS web session independently from the API client.

- **`initWebSession(): Promise<boolean>`** — Attempts login. Returns `true` if session established, `false` otherwise. On failure, logs one line and sets an internal `disabled` flag. All subsequent calls to `fetchRoutes` return `[]` immediately when disabled.
- **`fetchRoutes(deviceId: number): Promise<LnmsRoute[]>`** — POSTs to `ajax/table/routes` with the active session. Handles CSRF token refresh. On 401/redirect, attempts one re-login; if that fails, disables and returns `[]`.
- Session state: cookie jar (string), CSRF token (string), disabled flag (boolean). All in-memory, no persistence.
- Uses native `fetch` with manual cookie/CSRF management (no external dependencies).
- Respects the existing `LIBRENMS_URL` for the base URL and TLS settings from `config.ts`.

## Modified: `backend/src/config.ts`

Export two new optional env vars:

```ts
export const LIBRENMS_USER = process.env.LIBRENMS_USER ?? "";
export const LIBRENMS_PASS = process.env.LIBRENMS_PASS ?? "";
```

No validation or throw — empty strings are handled by `web-client.ts`.

## Modified: `backend/src/librenms/types.ts`

Add internal type for raw route data from the AJAX response:

```ts
export interface LnmsRoute {
  inetCidrRouteDest: string;
  inetCidrRoutePfxLen: string;
  inetCidrRouteNextHop: string;
  inetCidrRouteIfIndex: string;   // contains HTML markup, needs stripping
  inetCidrRouteProto: string;
  inetCidrRouteType: string;
  inetCidrRouteDestType: string;
  context_name: string;
}
```

## Modified: `shared/types.ts`

Add the clean route type exposed to the frontend:

```ts
export interface DeviceRoute {
  dest: string;       // e.g. "192.168.0.0"
  prefix: number;     // e.g. 24
  nextHop: string;    // e.g. "172.29.0.38"
  iface: string;      // e.g. "zt1ocu1pr81cbq5"
  protocol: string;   // "local" | "netmgmt" | "other"
  type: string;       // "remote"
}
```

Add `routes?: DeviceRoute[]` to `DeviceSummary`.

## Modified: `backend/src/cache/store.ts`

Add `ROUTES: 15 * 60 * 1000` to TTL (15 min — routes change only during discovery, which is infrequent).

## Modified: `backend/src/jobs/poller.ts`

Add `pollRoutes()`:

- Skip immediately if web client is disabled.
- Iterate over cached devices. For each device with `status === 1`:
  - Call `fetchRoutes(device.device_id)`.
  - Filter to `inetCidrRouteDestType === "ipv4"` and `inetCidrRouteType === "remote"`.
  - Strip HTML from `inetCidrRouteIfIndex` to extract interface name.
  - Strip HTML from `inetCidrRouteNextHop` (may contain device link markup).
  - Transform to `DeviceRoute[]` and cache as `routes:{hostname}`.
  - Stagger requests with existing `STAGGER_MS`.
- Called during `warmCache()` (after ports/IPs) and on interval (same as ports, 5 min).

## Modified: `backend/src/routes/topology.ts`

In the topology GET handler, for each device read `routes:{hostname}` from cache and attach to `DeviceSummary.routes`. Defaults to `undefined` if no routes cached.

## Data shape from LibreNMS AJAX endpoint

Request: `POST /ajax/table/routes`
```
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
X-CSRF-TOKEN: {csrf}
Cookie: {session}

current=1&rowCount=500&searchPhrase=&device_id={id}&showAllRoutes=false&showProtocols=all
```

Response:
```json
{
  "current": 1,
  "rowCount": 500,
  "rows": [
    {
      "inetCidrRouteDest": "192.168.0.0",
      "inetCidrRoutePfxLen": "24",
      "inetCidrRouteNextHop": "172.29.0.38",
      "inetCidrRouteIfIndex": "<div ...>zt1ocu1pr81cbq5</div>",
      "inetCidrRouteType": "remote",
      "inetCidrRouteProto": "local",
      "inetCidrRouteDestType": "ipv4",
      "context_name": "[global]",
      ...
    }
  ],
  "total": 279
}
```

## What this does NOT do

- No frontend changes — display/usage of route data is deferred.
- No VRF-specific logic — `context_name` is included in raw data but not filtered on.
- No IPv6 routes — filtered out during transform.
- No route-based link inference — that's a future feature.
