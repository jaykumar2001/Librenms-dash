import { Hono } from "hono";
import { cache } from "../cache/store.js";
import type { AssetEvent } from "@librenms-dash/shared";

const app = new Hono();

app.get("/", (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const events = cache.get<AssetEvent[]>("assetEvents") ?? [];
  const filtered = since > 0 ? events.filter(e => e.id > since) : events;
  return c.json({ events: filtered });
});

export default app;
