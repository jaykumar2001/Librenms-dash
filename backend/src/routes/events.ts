import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cache } from "../cache/store.js";
import { subscribeEvents, unsubscribeEvents, subscribeTopologyChanged, unsubscribeTopologyChanged } from "../jobs/poller.js";
import type { AssetEvent, TopologyResponse } from "@librenms-dash/shared";

const app = new Hono();

app.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const backlog = cache.get<AssetEvent[]>("assetEvents") ?? [];
    if (backlog.length > 0) {
      await stream.writeSSE({ data: JSON.stringify(backlog), event: "init" });
    }

    const onEvents = (events: AssetEvent[]) => {
      stream.writeSSE({ data: JSON.stringify(events), event: "events" }).catch(() => {});
    };

    subscribeEvents(onEvents);

    const onTopologyChanged = (payload: TopologyResponse) => {
      stream.writeSSE({ data: JSON.stringify(payload), event: "topology-changed" }).catch(() => {});
    };

    subscribeTopologyChanged(onTopologyChanged);
    stream.onAbort(() => {
      unsubscribeEvents(onEvents);
      unsubscribeTopologyChanged(onTopologyChanged);
    });

    // Keep alive — Hono closes the stream when this function returns,
    // so we block until the client disconnects.
    while (!stream.aborted) {
      await stream.sleep(30_000);
    }
  });
});

export default app;
