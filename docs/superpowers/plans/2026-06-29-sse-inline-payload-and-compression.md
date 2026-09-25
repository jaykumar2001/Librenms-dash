# SSE Inline Topology Payload + HTTP Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the HTTP round-trip on every SSE topology update by embedding the full `TopologyResponse` in the SSE event, and enable gzip compression on all HTTP API responses.

**Architecture:** The poller's `flushTopologyChanged()` already calls `buildAndCacheTopology()` — we extend it to pass the cached payload to SSE listeners, who embed it directly in the event frame. The frontend replaces `invalidateQueries` (which triggered a network fetch) with `setQueryData` (synchronous cache update). A one-line Hono middleware handles HTTP compression globally; SSE streams are streaming responses and are automatically skipped by the middleware.

**Tech Stack:** Hono 4.12.x (`hono/compress`), TanStack Query v5 (`setQueryData`), TypeScript, `@librenms-dash/shared` types.

## Global Constraints

- Build verification: `docker-compose up -d --build` must succeed and container must start.
- No new npm packages — `hono/compress` is already bundled with Hono 4.x.
- SSE routes (`/api/events/stream`, `/api/health/stream`) must not be compressed — Hono's compress middleware handles this automatically for streaming responses.
- `TopologyResponse` type is imported from `@librenms-dash/shared`.

---

## File Map

| File | Change |
|------|--------|
| `backend/src/index.ts` | Add `compress()` middleware before routes |
| `backend/src/jobs/poller.ts` | `TopologyListener` type + `flushTopologyChanged` passes payload |
| `backend/src/routes/events.ts` | `onTopologyChanged(payload)` sends full JSON |
| `frontend/src/hooks/useSSE.ts` | `setQueryData` instead of `invalidateQueries`; reconnect refetch |

---

### Task 1: HTTP Response Compression

**Files:**
- Modify: `backend/src/index.ts`

**Interfaces:**
- Produces: all non-streaming HTTP responses include `Content-Encoding: gzip` when client sends `Accept-Encoding: gzip`

- [ ] **Step 1: Add compress import and middleware**

Open `backend/src/index.ts`. Add the import after the existing imports and register the middleware as the first `app.use`:

```ts
// Add after existing imports (e.g., after "import { cors } from 'hono/cors'")
import { compress } from "hono/compress";
```

Then add as the very first middleware (line after `const app = new Hono()`):

```ts
app.use("*", compress());
```

The file's middleware block should look like:

```ts
const app = new Hono();

app.use("*", compress());
app.use("*", logger());
app.use("*", cors({ ... }));
```

- [ ] **Step 2: Build and verify compression headers**

```bash
docker-compose up -d --build
```

Expected: build succeeds, container starts. Then:

```bash
curl -s -I -H "Accept-Encoding: gzip" http://localhost:3001/api/health | grep -i content-encoding
```

Expected output: `content-encoding: gzip`

Verify SSE is NOT compressed (streaming responses should pass through):

```bash
curl -s -I -H "Accept-Encoding: gzip" http://localhost:3001/api/events/stream | grep -i content-encoding
```

Expected: no `content-encoding` header (SSE is a streaming response, skipped by compress middleware).

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat: add gzip compression middleware for HTTP API responses"
```

---

### Task 2: Pass TopologyResponse Through SSE Listener Chain (Backend)

**Files:**
- Modify: `backend/src/jobs/poller.ts`
- Modify: `backend/src/routes/events.ts`

**Interfaces:**
- Produces: `subscribeTopologyChanged` / `unsubscribeTopologyChanged` accept `(payload: TopologyResponse) => void` listeners
- Produces: SSE `topology-changed` event carries full `TopologyResponse` JSON as its `data` field (instead of `{ ts: "..." }`)

- [ ] **Step 1: Update `TopologyListener` type in `poller.ts`**

In `backend/src/jobs/poller.ts`, `TopologyResponse` is already imported from `@librenms-dash/shared` (added in the previous quick-wins session). Find and replace:

```ts
type TopologyListener = () => void;
```

with:

```ts
type TopologyListener = (payload: TopologyResponse) => void;
```

- [ ] **Step 2: Update `flushTopologyChanged` to pass payload**

Find the `flushTopologyChanged` function in `backend/src/jobs/poller.ts`. Currently it reads:

```ts
function flushTopologyChanged() {
  if (!topologyChangedInCycle) return;
  topologyChangedInCycle = false;
  buildAndCacheTopology();
  for (const fn of topologyListeners) fn();
}
```

Replace with:

```ts
function flushTopologyChanged() {
  if (!topologyChangedInCycle) return;
  topologyChangedInCycle = false;
  buildAndCacheTopology();
  const payload = cache.get<TopologyResponse>("topology")!;
  for (const fn of topologyListeners) fn(payload);
}
```

- [ ] **Step 3: Update `onTopologyChanged` in `routes/events.ts`**

Open `backend/src/routes/events.ts`. Add the type import at the top:

```ts
import type { AssetEvent, TopologyResponse } from "@librenms-dash/shared";
```

Find the `onTopologyChanged` callback inside the `app.get("/stream", ...)` handler. Currently:

```ts
const onTopologyChanged = () => {
  stream.writeSSE({ data: JSON.stringify({ ts: new Date().toISOString() }), event: "topology-changed" }).catch(() => {});
};
```

Replace with:

```ts
const onTopologyChanged = (payload: TopologyResponse) => {
  stream.writeSSE({ data: JSON.stringify(payload), event: "topology-changed" }).catch(() => {});
};
```

- [ ] **Step 4: Build to verify TypeScript compiles**

```bash
docker-compose up -d --build
```

Expected: build succeeds. Container log should show `[poller] Cache warm complete` within ~60 seconds. Any TypeScript type error would prevent the build from completing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/jobs/poller.ts backend/src/routes/events.ts
git commit -m "feat: embed full TopologyResponse in topology-changed SSE event"
```

---

### Task 3: Frontend — Merge SSE Payload Directly Into Query Cache

**Files:**
- Modify: `frontend/src/hooks/useSSE.ts`

**Interfaces:**
- Consumes: `topology-changed` SSE event whose `e.data` is a JSON-serialised `TopologyResponse`
- Produces: TanStack Query cache entry `["topology"]` is updated synchronously on each SSE event — no HTTP refetch

- [ ] **Step 1: Add imports and reconnect ref in `useSSE.ts`**

Open `frontend/src/hooks/useSSE.ts`. The file currently imports:

```ts
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AssetEvent } from "@librenms-dash/shared";
```

Add `TopologyResponse` to the shared import:

```ts
import type { AssetEvent, TopologyResponse } from "@librenms-dash/shared";
```

- [ ] **Step 2: Add `isFirstOpen` ref inside the hook**

Inside `useSSE()`, after the existing `addEventsRef` ref, add:

```ts
const isFirstOpen = useRef(true);
```

- [ ] **Step 3: Replace `topology-changed` handler and add reconnect logic**

Inside the `useEffect`, find the existing `topology-changed` listener and `es.onopen`:

```ts
es.addEventListener("topology-changed", () => {
  queryClient.invalidateQueries({ queryKey: ["topology"] });
});

es.onopen = () => setConnected(true);
```

Replace both with:

```ts
es.addEventListener("topology-changed", (e) => {
  try {
    const payload = JSON.parse(e.data) as TopologyResponse;
    queryClient.setQueryData(["topology"], payload);
  } catch { /* ignore malformed events */ }
});

es.onopen = () => {
  setConnected(true);
  if (!isFirstOpen.current) {
    // SSE reconnected — resync in case events were missed while disconnected
    queryClient.invalidateQueries({ queryKey: ["topology"] });
  }
  isFirstOpen.current = false;
};
```

- [ ] **Step 4: Build and verify end-to-end**

```bash
docker-compose up -d --build
```

Expected: build succeeds, container starts.

Open the dashboard in a browser, open DevTools → Network tab, filter by `Fetch/XHR`. Confirm that after the initial page load's `/api/topology` request, **no further `/api/topology` requests appear** when the topology updates (watch for ~5 minutes or trigger a poll by waiting). Topology updates should arrive via the `events/stream` SSE connection only.

Also verify gzip on the initial load:

In DevTools → Network → click the `/api/topology` request → Headers → confirm `Content-Encoding: gzip` is present in the response headers.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useSSE.ts
git commit -m "feat: update topology via SSE setQueryData, eliminating HTTP refetch on change"
```

---

## Self-Review Checklist (completed inline)

- **Spec coverage:** Compression ✓ (Task 1), inline SSE payload ✓ (Task 2), frontend setQueryData ✓ (Task 3), reconnect sync ✓ (Task 3 Step 3). All spec requirements covered.
- **Placeholder scan:** No TBDs. All code blocks are complete.
- **Type consistency:** `TopologyResponse` used consistently throughout. `TopologyListener` type updated in Task 2 Step 1 before it is consumed in Steps 2 and 3.
