# SSE-Triggered Topology Refresh

## Problem

When the backend detects topology changes (devices added/removed, overlay links changed, ARP neighbors discovered), the frontend does not update until the user manually refreshes the browser. The React Query 5-minute `refetchInterval` in `useTopology` is meant to catch changes, but the delay is too long and users expect near-real-time updates.

The backend already has the infrastructure to detect changes (`diffAndLog` in `poller.ts`) and push events over SSE (`/api/events/stream`). The SSE stream is currently used only for asset-change toast notifications. The topology data itself is never pushed — the frontend must poll for it.

## Design Decisions

- **SSE-triggered invalidation, not SSE-streamed data.** The backend sends a lightweight `topology-changed` signal over the existing SSE stream. The frontend reacts by calling `queryClient.invalidateQueries(["topology"])`, which triggers a standard HTTP re-fetch of the full topology. This avoids duplicating serialization logic, keeps payloads on the efficient HTTP path (with compression), and requires minimal code change.
- **Single SSE connection, two consumers.** The EventSource currently lives inside `AssetEventToast`. It needs to be lifted into a shared hook so both asset toasts and topology invalidation share one connection.
- **Preserve user positions on live updates.** The existing `layoutSignature` + `usePersistedLayout` mechanisms already handle this — no new persistence logic needed.
- **Defer updates during drag.** If the user is mid-drag when a topology-changed event arrives, defer the layout recomputation until the drag ends to avoid jarring position snaps.
- **Keep 5-minute polling as fallback.** The `refetchInterval` in `useTopology` stays. If SSE disconnects or misses an event, the polling catches up.

## Architecture

### Data Flow

```
LibreNMS API
    │
    ▼ (every 5 min)
Backend Poller (pollDevicesAndLocations, pollPortsAndIps, pollRoutes)
    │
    ├── diffAndLog() detects changes
    │       │
    │       ├── pushEvents() → SSE "events" → AssetEventToast (existing)
    │       └── pushTopologyChanged() → SSE "topology-changed" (new)
    │
    ▼
Frontend useSSE hook
    │
    ├── "events" → asset event state → AssetEventToast component
    └── "topology-changed" → queryClient.invalidateQueries(["topology"])
                                    │
                                    ▼
                              useTopology re-fetches GET /api/topology
                                    │
                                    ▼
                              useForceLayout checks layoutSignature
                                    │
                                    ├── unchanged → no re-render
                                    └── changed → recompute layout
                                              │
                                              ▼
                                        usePersistedLayout applies saved positions
                                              │
                                              ▼
                                        Map updates with positions preserved
```

### Backend Changes

#### `backend/src/jobs/poller.ts`

Add a topology-changed broadcast mechanism parallel to the existing asset event system:

```typescript
type TopologyListener = () => void;
const topologyListeners = new Set<TopologyListener>();

export function subscribeTopologyChanged(fn: TopologyListener) { topologyListeners.add(fn); }
export function unsubscribeTopologyChanged(fn: TopologyListener) { topologyListeners.delete(fn); }

let topologyChangedInCycle = false;

function diffAndLog(category: string, prev: Set<string>, curr: Set<string>): Set<string> {
  // ... existing logic ...
  // After detecting adds or removes, set the flag:
  if (events.length > 0) topologyChangedInCycle = true;
  // ... rest unchanged ...
}
```

Add flush calls at the end of each poll function (`pollDevicesAndLocations`, `pollPortsAndIps`, `pollRoutes`):

```typescript
function flushTopologyChanged() {
  if (!topologyChangedInCycle) return;
  topologyChangedInCycle = false;
  for (const fn of topologyListeners) fn();
}
```

#### `backend/src/routes/events.ts`

Subscribe to topology-changed alongside the existing asset events:

```typescript
const onTopologyChanged = () => {
  stream.writeSSE({ data: JSON.stringify({ ts: new Date().toISOString() }), event: "topology-changed" }).catch(() => {});
};

subscribeTopologyChanged(onTopologyChanged);
stream.onAbort(() => {
  unsubscribeEvents(onEvents);
  unsubscribeTopologyChanged(onTopologyChanged);
});
```

### Frontend Changes

#### New: `frontend/src/hooks/useSSE.ts`

Manages the single EventSource connection. Returns asset events for the toast component. Handles topology-changed by invalidating React Query.

```typescript
export function useSSE() {
  const queryClient = useQueryClient();
  const [assetEvents, setAssetEvents] = useState<AssetEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/events/stream");

    es.addEventListener("init", (e) => { /* parse and set initial asset events */ });
    es.addEventListener("events", (e) => { /* parse and append new asset events */ });
    es.addEventListener("topology-changed", () => {
      queryClient.invalidateQueries({ queryKey: ["topology"] });
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => { es.close(); setConnected(false); };
  }, [queryClient]);

  return { assetEvents, connected, setAssetEvents };
}
```

#### Modified: `frontend/src/components/AssetEventToast.tsx`

Remove the internal `useEffect` that creates an EventSource. Instead, receive `assetEvents` and `connected` as props from the parent. All toast queue/display logic stays unchanged.

#### Modified: `frontend/src/App.tsx`

Call `useSSE()` in `Dashboard` and pass results down to `AssetEventToast`.

#### Modified: `frontend/src/hooks/useForceLayout.ts`

Add mid-drag deferral. Accept a `isDragging` flag (or ref). When true, store pending data but skip the layout effect. When dragging ends, apply the pending update.

```typescript
// In the layout effect:
useEffect(() => {
  if (!data || !containerWidth) return;
  if (isDragging) {
    pendingDataRef.current = data;
    return;
  }
  // ... existing layout logic ...
}, [data, containerWidth, containerHeight, siteOrientations, showArpDevices, topReserve, isDragging]);
```

### Files Changed

| File | Change |
|------|--------|
| `backend/src/jobs/poller.ts` | Add `topologyListeners`, `subscribeTopologyChanged`, `unsubscribeTopologyChanged`, `flushTopologyChanged`. Set flag in `diffAndLog`. Call `flushTopologyChanged()` at end of each poll function. |
| `backend/src/routes/events.ts` | Subscribe to topology-changed in the SSE stream handler. |
| `frontend/src/hooks/useSSE.ts` **(new)** | Shared EventSource hook. Handles `init`, `events`, `topology-changed`. Returns asset events and connection state. |
| `frontend/src/components/AssetEventToast.tsx` | Remove internal EventSource. Accept asset events and connection state as props. |
| `frontend/src/App.tsx` | Call `useSSE()` in Dashboard. Pass asset event props to `AssetEventToast`. |
| `frontend/src/hooks/useForceLayout.ts` | Add `isDragging` parameter. Defer layout recomputation during drag. |
| `frontend/src/components/TopologyMap.tsx` | Pass `isDragging` (derived from `dragTarget.current`) to `useForceLayout`. |

### What This Does NOT Change

- Backend polling intervals (stays at 5 min for devices/ports, 2 min for alerts)
- The `GET /api/topology` endpoint or its response shape
- The `layoutSignature` mechanism or `usePersistedLayout` logic
- Toast notification behavior (toasts still work, just sourced from shared hook)
- The 5-minute React Query `refetchInterval` fallback
