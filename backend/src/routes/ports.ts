import { Hono } from "hono";
import { cache } from "../cache/store.js";
import type { LnmsPort } from "../librenms/types.js";

const app = new Hono();

app.get("/:hostname", (c) => {
  const hostname = c.req.param("hostname");
  const ports = cache.get<LnmsPort[]>(`ports:${hostname}`);
  if (!ports) {
    return c.json({ error: "Ports not cached for device" }, 404);
  }
  return c.json({ ports });
});

export default app;
