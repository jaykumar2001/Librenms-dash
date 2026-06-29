import { Hono } from "hono";
import { cache } from "../cache/store.js";
import type { TopologyResponse } from "@librenms-dash/shared";

const app = new Hono();

app.get("/", (c) => {
  return c.json(cache.get<TopologyResponse>("topology") ?? {
    sites: [],
    overlays: [],
    neighbors: [],
    arpLinks: [],
    arpDevices: [],
    alerts: [],
    lastUpdated: new Date().toISOString(),
  });
});

export default app;
