# SSE Inline Topology Payload + HTTP Compression

**Date:** 2026-06-29  
**Status:** Approved

## Problem

Every SSE-triggered topology refresh costs two round trips: the SSE event (tiny) plus an HTTP GET `/api/topology` (200–600 KB). HTTP responses are also uncompressed — the topology JSON, device detail endpoints, and port data all go over the wire verbatim.

## Goals

1. Eliminate the HTTP refetch on topology change — send the full payload inline in the SSE event.
2. Compress all HTTP API responses via gzip.

## Non-Goals

- SSE stream-level compression (complex, marginal benefit given SSE events are already flushed per-event).
- Delta/partial topology payloads (deferred — see assessment item 5/7).

---

## Design

### 1. Inline SSE Topology Payload

**Backend — `jobs/poller.ts`:**

`TopologyListener` type changes from `() => void` to `(payload: TopologyResponse) => void`.

`flushTopologyChanged()` reads the pre-built topology from cache and passes it to each listener:

```ts
function flushTopologyChanged() {
  if (!topologyChangedInCycle) return;
  topologyChangedInCycle = false;
  buildAndCacheTopology();
  const payload = cache.get<TopologyResponse>("topology")!;
  for (const fn of topologyListeners) fn(payload);
}
```

**Backend — `routes/events.ts`:**

`onTopologyChanged` receives the full payload and sends it as the `topology-changed` event body:

```ts
const onTopologyChanged = (payload: TopologyResponse) => {
  stream.writeSSE({ data: JSON.stringify(payload), event: "topology-changed" }).catch(() => {});
};
```

**Frontend — `hooks/useSSE.ts`:**

Replace `queryClient.invalidateQueries(...)` with `queryClient.setQueryData(...)`:

```ts
es.addEventListener("topology-changed", (e) => {
  try {
    const payload = JSON.parse(e.data) as TopologyResponse;
    queryClient.setQueryData(["topology"], payload);
  } catch { /* ignore */ }
});
```

On reconnect, trigger a full HTTP refetch to sync any topology changes missed while the SSE was disconnected:

```ts
const isFirstOpen = useRef(true);
es.onopen = () => {
  setConnected(true);
  if (!isFirstOpen.current) {
    queryClient.invalidateQueries({ queryKey: ["topology"] });
  }
  isFirstOpen.current = false;
};
```

The `/api/topology` HTTP endpoint remains unchanged — used for initial page load and reconnect sync.

### 2. HTTP Response Compression

Hono ships a `compress` middleware (`hono/compress`) that negotiates gzip/deflate/brotli via `Accept-Encoding`. It is added globally in `backend/src/index.ts`, before routes:

```ts
import { compress } from "hono/compress";
app.use("*", compress());
```

The middleware only compresses buffered (non-streaming) responses. SSE routes respond with `Content-Type: text/event-stream` via Hono's `streamSSE`, which produces a streaming response — the compress middleware passes these through untouched.

No per-route exclusions are needed.

---

## Data Flow (After)

```
Poll cycle ends
  → buildAndCacheTopology() puts TopologyResponse in cache
  → flushTopologyChanged() reads cache, calls topologyListeners(payload)
  → routes/events.ts writes: event: topology-changed\ndata: <full JSON>\n\n
  → Browser EventSource fires "topology-changed"
  → useSSE: queryClient.setQueryData(["topology"], payload)
  → React re-renders with new data
  → Zero HTTP requests
```

---

## Files Changed

| File | Change |
|------|--------|
| `backend/src/index.ts` | Add `compress()` middleware |
| `backend/src/jobs/poller.ts` | `TopologyListener` type, `flushTopologyChanged` passes payload |
| `backend/src/routes/events.ts` | `onTopologyChanged(payload)` sends full JSON |
| `frontend/src/hooks/useSSE.ts` | `setQueryData` instead of `invalidateQueries`; reconnect refetch |

---

## Trade-offs

- **SSE event size increases**: topology JSON (~200–600 KB uncompressed) is sent in the SSE frame instead of a separate HTTP response. The HTTP response was also ~200–600 KB, so wire cost is unchanged — but we save one HTTP round trip per topology change.
- **SSE stream is not compressed**: individual SSE frames can't be gzip-compressed without custom stream flushing. This is an acceptable trade-off since the primary benefit (eliminating the round trip) doesn't depend on compression.
- **HTTP responses are compressed**: the initial `/api/topology` load, device detail, port data, and graph proxy responses all benefit from gzip — typically 5–10× reduction on JSON payloads.
