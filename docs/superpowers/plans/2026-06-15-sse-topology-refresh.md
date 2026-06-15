# SSE-Triggered Topology Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the backend detects topology changes, push a signal over the existing SSE stream so the frontend re-fetches and updates the map immediately — no browser refresh required.

**Architecture:** Add a `topology-changed` SSE event emitted by the backend poller when `diffAndLog` detects changes. Lift the frontend's EventSource out of `AssetEventToast` into a shared `useSSE` hook that both invalidates React Query's topology cache and feeds asset events to the toast component. Add a drag-deferral guard in `useForceLayout` so mid-drag updates don't snap positions.

**Tech Stack:** Hono SSE streaming, React, @tanstack/react-query, TypeScript

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/src/jobs/poller.ts` | Modify | Add topology-changed listener set, flag in `diffAndLog`, flush at end of each poll function |
| `backend/src/routes/events.ts` | Modify | Subscribe to topology-changed in SSE stream handler |
| `frontend/src/hooks/useSSE.ts` | Create | Shared EventSource hook — asset events + topology invalidation |
| `frontend/src/components/AssetEventToast.tsx` | Modify | Remove internal EventSource, accept asset events + connected via props |
| `frontend/src/App.tsx` | Modify | Wire `useSSE` in Dashboard, pass props to `AssetEventToast` |
| `frontend/src/components/TopologyMap.tsx` | Modify | Pass `isDragging` to `useForceLayout`, accept and forward `AssetEventToast` props |
| `frontend/src/hooks/useForceLayout.ts` | Modify | Accept `isDragging` ref, defer layout recomputation during drag |

---

### Task 1: Backend — Topology-changed broadcast in poller

**Files:**
- Modify: `backend/src/jobs/poller.ts:44-77` (listener set and diffAndLog), `:112-125` (pollDevicesAndLocations), `:127-175` (pollPortsAndIps), `:505-554` (pollRoutes)

- [ ] **Step 1: Add topology-changed listener infrastructure**

After the existing `subscribeEvents`/`unsubscribeEvents` block (line 48), add the topology-changed equivalent. In `backend/src/jobs/poller.ts`, after line 48:

```typescript
type TopologyListener = () => void;
const topologyListeners = new Set<TopologyListener>();

export function subscribeTopologyChanged(fn: TopologyListener) { topologyListeners.add(fn); }
export function unsubscribeTopologyChanged(fn: TopologyListener) { topologyListeners.delete(fn); }

let topologyChangedInCycle = false;

function flushTopologyChanged() {
  if (!topologyChangedInCycle) return;
  topologyChangedInCycle = false;
  for (const fn of topologyListeners) fn();
}
```

- [ ] **Step 2: Set flag in diffAndLog when changes are detected**

In the `diffAndLog` function, after the `pushEvents(events)` call (line 73), add:

```typescript
    if (events.length > 0) topologyChangedInCycle = true;
```

The full block at lines 72-74 becomes:

```typescript
    pushEvents(events);
    if (events.length > 0) topologyChangedInCycle = true;
  }
```

- [ ] **Step 3: Flush at end of pollDevicesAndLocations**

At the end of `pollDevicesAndLocations` (after line 124), add:

```typescript
  flushTopologyChanged();
```

- [ ] **Step 4: Flush at end of pollPortsAndIps**

At the end of `pollPortsAndIps`, right before the `pollArpLinks` call (line 173), add:

```typescript
  flushTopologyChanged();
```

Note: `pollArpLinks` runs asynchronously in the background and calls `diffAndLog` for discovered-devices. After line 345 in `pollArpLinks` (after the `prevAssets.arpDevices = diffAndLog(...)` call), add:

```typescript
  flushTopologyChanged();
```

- [ ] **Step 5: Flush at end of pollRoutes**

At the end of `pollRoutes`, after line 553 (`prevAssets.routes = diffAndLog(...)`), add:

```typescript
  flushTopologyChanged();
```

- [ ] **Step 6: Verify backend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/jobs/poller.ts
git commit -m "feat: add topology-changed broadcast to poller"
```

---

### Task 2: Backend — Wire topology-changed into SSE stream

**Files:**
- Modify: `backend/src/routes/events.ts`

- [ ] **Step 1: Import the new subscribe/unsubscribe functions**

In `backend/src/routes/events.ts`, change line 4 from:

```typescript
import { subscribeEvents, unsubscribeEvents } from "../jobs/poller.js";
```

to:

```typescript
import { subscribeEvents, unsubscribeEvents, subscribeTopologyChanged, unsubscribeTopologyChanged } from "../jobs/poller.js";
```

- [ ] **Step 2: Add topology-changed listener in stream handler**

Inside the `streamSSE` callback, after the `subscribeEvents(onEvents)` call (line 20) and before the `stream.onAbort` call (line 21), add:

```typescript
    const onTopologyChanged = () => {
      stream.writeSSE({ data: JSON.stringify({ ts: new Date().toISOString() }), event: "topology-changed" }).catch(() => {});
    };

    subscribeTopologyChanged(onTopologyChanged);
```

- [ ] **Step 3: Unsubscribe on abort**

Change the `stream.onAbort` line (line 21) from:

```typescript
    stream.onAbort(() => unsubscribeEvents(onEvents));
```

to:

```typescript
    stream.onAbort(() => {
      unsubscribeEvents(onEvents);
      unsubscribeTopologyChanged(onTopologyChanged);
    });
```

- [ ] **Step 4: Verify backend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p backend/tsconfig.json`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/events.ts
git commit -m "feat: emit topology-changed SSE event on stream"
```

---

### Task 3: Frontend — Create useSSE hook

**Files:**
- Create: `frontend/src/hooks/useSSE.ts`

- [ ] **Step 1: Create the shared SSE hook**

Create `frontend/src/hooks/useSSE.ts` with:

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AssetEvent } from "@librenms-dash/shared";

export function useSSE() {
  const queryClient = useQueryClient();
  const [allEvents, setAllEvents] = useState<AssetEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const addEventsRef = useRef<(events: AssetEvent[]) => void>();

  const addEvents = useCallback((events: AssetEvent[]) => {
    setAllEvents(prev => {
      const merged = [...prev, ...events];
      return merged.length > 200 ? merged.slice(-200) : merged;
    });
  }, []);

  addEventsRef.current = addEvents;

  useEffect(() => {
    const es = new EventSource("/api/events/stream");

    es.addEventListener("init", (e) => {
      try {
        const events: AssetEvent[] = JSON.parse(e.data);
        if (events.length > 0) setAllEvents(events);
      } catch { /* ignore */ }
    });

    es.addEventListener("events", (e) => {
      try {
        const events: AssetEvent[] = JSON.parse(e.data);
        if (events.length > 0) addEventsRef.current?.(events);
      } catch { /* ignore */ }
    });

    es.addEventListener("topology-changed", () => {
      queryClient.invalidateQueries({ queryKey: ["topology"] });
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => { es.close(); setConnected(false); };
  }, [queryClient]);

  return { allEvents, connected };
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useSSE.ts
git commit -m "feat: add shared useSSE hook with topology invalidation"
```

---

### Task 4: Frontend — Refactor AssetEventToast to accept props

**Files:**
- Modify: `frontend/src/components/AssetEventToast.tsx`

- [ ] **Step 1: Add props interface and update component signature**

Change the component signature (line 25) from:

```typescript
export function AssetEventToast() {
```

to:

```typescript
interface AssetEventToastProps {
  allEvents: AssetEvent[];
  connected: boolean;
}

export function AssetEventToast({ allEvents, connected }: AssetEventToastProps) {
```

- [ ] **Step 2: Remove internal state that is now from props**

Remove these lines from the component body (lines 26, 33):

```typescript
  const [allEvents, setAllEvents] = useState<AssetEvent[]>([]);
```

```typescript
  const [connected, setConnected] = useState(false);
```

- [ ] **Step 3: Replace the addEvents callback with a prop-watching effect**

Remove the `addEvents` callback (lines 52-59):

```typescript
  const addEvents = useCallback((events: AssetEvent[]) => {
    setAllEvents(prev => [...prev, ...events].slice(-200));
    setNewCount(prev => prev + events.length);
    setQueue(prev => {
      const merged = [...prev, ...events];
      return merged.length > MAX_QUEUE ? merged.slice(-MAX_QUEUE) : merged;
    });
  }, []);
```

Replace it with a `useEffect` that watches the `allEvents` prop to update the toast queue and new count when new events arrive:

```typescript
  const prevLengthRef = useRef(allEvents.length);
  useEffect(() => {
    const prevLen = prevLengthRef.current;
    prevLengthRef.current = allEvents.length;
    if (allEvents.length <= prevLen) return;
    const newEvents = allEvents.slice(prevLen);
    if (newEvents.length === 0) return;
    setNewCount(prev => prev + newEvents.length);
    setQueue(prev => {
      const merged = [...prev, ...newEvents];
      return merged.length > MAX_QUEUE ? merged.slice(-MAX_QUEUE) : merged;
    });
  }, [allEvents]);
```

- [ ] **Step 4: Remove the SSE connection useEffect**

Remove the entire SSE connection `useEffect` block (lines 61-79):

```typescript
  // SSE connection
  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.addEventListener("init", (e) => {
      try {
        const events: AssetEvent[] = JSON.parse(e.data);
        if (events.length > 0) setAllEvents(events);
      } catch { /* ignore */ }
    });
    es.addEventListener("events", (e) => {
      try {
        const events: AssetEvent[] = JSON.parse(e.data);
        if (events.length > 0) addEvents(events);
      } catch { /* ignore */ }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => { es.close(); setConnected(false); };
  }, [addEvents]);
```

- [ ] **Step 5: Remove unused useState import usage**

The component still uses `useState` for `queue`, `toast`, `toastVisible`, `panelOpen`, `page`, `newCount`. Verify the `useState` import is still present (it is — other state variables use it). Remove the now-unused `setAllEvents` references — there are none left after removing the SSE effect and addEvents callback.

- [ ] **Step 6: Verify frontend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: Errors about `AssetEventToast` usage in `TopologyMap.tsx` missing required props — this is expected and will be fixed in Task 6.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AssetEventToast.tsx
git commit -m "refactor: AssetEventToast accepts events via props"
```

---

### Task 5: Frontend — Wire useSSE in App.tsx and pass props through

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Import useSSE**

Add to the imports in `App.tsx`:

```typescript
import { useSSE } from "@/hooks/useSSE";
```

- [ ] **Step 2: Call useSSE in Dashboard and pass props to TopologyMap**

Change the `Dashboard` function from:

```typescript
function Dashboard() {
  const { data, isLoading, error } = useTopology();

  if (isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 text-sm">Loading topology from LibreNMS...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center max-w-md px-4">
          <p className="text-red-400 text-lg font-semibold mb-2">Failed to load topology</p>
          <p className="text-gray-400 text-sm">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return <TopologyMap data={data} />;
}
```

to:

```typescript
function Dashboard() {
  const { data, isLoading, error } = useTopology();
  const sse = useSSE();

  if (isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 text-sm">Loading topology from LibreNMS...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center max-w-md px-4">
          <p className="text-red-400 text-lg font-semibold mb-2">Failed to load topology</p>
          <p className="text-gray-400 text-sm">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return <TopologyMap data={data} sse={sse} />;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: wire useSSE in Dashboard, pass to TopologyMap"
```

---

### Task 6: Frontend — Update TopologyMap to accept SSE props and forward to AssetEventToast

**Files:**
- Modify: `frontend/src/components/TopologyMap.tsx`

- [ ] **Step 1: Update the Props interface**

Change the Props interface (around line 18-20) from:

```typescript
interface Props {
  data: TopologyResponse;
}
```

to:

```typescript
import type { AssetEvent } from "@librenms-dash/shared";

interface SSEState {
  allEvents: AssetEvent[];
  connected: boolean;
}

interface Props {
  data: TopologyResponse;
  sse: SSEState;
}
```

- [ ] **Step 2: Destructure sse from props**

Change the component signature (around line 52) from:

```typescript
export function TopologyMap({ data }: Props) {
```

to:

```typescript
export function TopologyMap({ data, sse }: Props) {
```

- [ ] **Step 3: Pass SSE props to AssetEventToast**

Change the `<AssetEventToast />` usage (line 1216) from:

```tsx
      <AssetEventToast />
```

to:

```tsx
      <AssetEventToast allEvents={sse.allEvents} connected={sse.connected} />
```

- [ ] **Step 4: Verify frontend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/TopologyMap.tsx
git commit -m "feat: forward SSE state to AssetEventToast via props"
```

---

### Task 7: Frontend — Defer layout recomputation during drag

**Files:**
- Modify: `frontend/src/hooks/useForceLayout.ts:643-729`
- Modify: `frontend/src/components/TopologyMap.tsx`

- [ ] **Step 1: Add isDragging parameter to useForceLayout**

Change the `useForceLayout` function signature (line 643-649) from:

```typescript
export function useForceLayout(
  data: TopologyResponse | undefined,
  containerWidth: number,
  containerHeight: number,
  showArpDevices = false,
  topReserve = 56,
) {
```

to:

```typescript
export function useForceLayout(
  data: TopologyResponse | undefined,
  containerWidth: number,
  containerHeight: number,
  showArpDevices = false,
  topReserve = 56,
  isDragging = false,
) {
```

- [ ] **Step 2: Add pending data ref and defer logic in the layout effect**

After the `layoutSigRef` declaration (line 673), add:

```typescript
  const pendingDataRef = useRef<TopologyResponse | undefined>();
```

Then modify the main layout `useEffect` (lines 694-729). Change it from:

```typescript
  useEffect(() => {
    if (!data || !containerWidth) return;
    // Skip regenerating the layout (which discards manual drags/resizes) when the
    // topology and layout inputs are unchanged — e.g. on the 5-minute background poll.
    const sig = layoutSignature(data, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve);
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
```

to:

```typescript
  useEffect(() => {
    if (!data || !containerWidth) return;
    if (isDragging) {
      pendingDataRef.current = data;
      return;
    }
    const effectiveData = pendingDataRef.current ?? data;
    pendingDataRef.current = undefined;
    const sig = layoutSignature(effectiveData, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve);
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
```

Also update the rest of the effect to use `effectiveData` instead of `data`. The `layoutAll` call on what was line 701 changes from:

```typescript
    const result = layoutAll(data, containerWidth, siteOrientations, showArpDevices, containerHeight, topReserve);
```

to:

```typescript
    const result = layoutAll(effectiveData, containerWidth, siteOrientations, showArpDevices, containerHeight, topReserve);
```

- [ ] **Step 3: Add isDragging to the effect dependency array**

Change the dependency array of the layout effect (line 729) from:

```typescript
  }, [data, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve]);
```

to:

```typescript
  }, [data, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve, isDragging]);
```

- [ ] **Step 4: Pass isDragging from TopologyMap**

In `frontend/src/components/TopologyMap.tsx`, the `dragTarget` ref is defined around line 141. The `useForceLayout` call needs to know whether a drag is active.

Add a state variable near the other state declarations:

```typescript
  const [isDragging, setIsDragging] = useState(false);
```

Update the `useForceLayout` call to pass it. Find the existing call (should be around the area after the dimension/topInset setup):

```typescript
  } = useForceLayout(data, dimensions.width, dimensions.height, showArpDevices, topInset);
```

Change to:

```typescript
  } = useForceLayout(data, dimensions.width, dimensions.height, showArpDevices, topInset, isDragging);
```

Set `isDragging` to `true` when a drag starts and `false` when it ends. In the three `beginXxxDrag` functions (around lines 511, 532, 553), after setting `dragTarget.current`, add:

```typescript
    setIsDragging(true);
```

In the `handleMouseUp` function (around line 623 where `dragTarget.current = null`), add before that line:

```typescript
    setIsDragging(false);
```

- [ ] **Step 5: Verify frontend compiles**

Run: `cd /home/jkumar/Librenms-dash && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: No errors.

- [ ] **Step 6: Verify full build**

Run: `cd /home/jkumar/Librenms-dash && pnpm build`
Expected: Clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useForceLayout.ts frontend/src/components/TopologyMap.tsx
git commit -m "feat: defer layout recomputation during drag"
```
