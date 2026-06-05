import { Hono } from "hono";
import { cache, TTL } from "../cache/store.js";
import { librenmsGetBuffer, librenmsGetRaw, type BufferWithType } from "../librenms/client.js";

const app = new Hono();

app.get("/device/:hostname/:type", async (c) => {
  const { hostname, type } = c.req.param();
  const from = c.req.query("from") ?? "-1d";
  const to = c.req.query("to") ?? "now";
  const width = c.req.query("width") ?? "400";
  const height = c.req.query("height") ?? "150";

  const cacheKey = `graph:${hostname}:${type}:${from}:${to}:${width}:${height}`;

  let cached = cache.get<BufferWithType>(cacheKey);
  if (!cached) {
    try {
      cached = await librenmsGetBuffer(`/devices/${encodeURIComponent(hostname)}/${encodeURIComponent(type)}`, { from, to, width, height });
      cache.set(cacheKey, cached, TTL.GRAPH_PNG);
    } catch (e) {
      return c.text("Graph unavailable", 502);
    }
  }

  c.header("Content-Type", cached.contentType);
  c.header("Cache-Control", "public, max-age=300");
  return c.body(new Uint8Array(cached.buffer));
});

app.get("/icon/:filename", async (c) => {
  const filename = c.req.param("filename");
  const cacheKey = `icon:${filename}`;

  let buf = cache.get<Buffer>(cacheKey);
  if (!buf) {
    try {
      buf = await librenmsGetRaw(`/images/os/${encodeURIComponent(filename)}`);
      cache.set(cacheKey, buf, 24 * 60 * 60 * 1000); // 24h
    } catch {
      return c.text("Icon not found", 404);
    }
  }

  const ext = filename.split(".").pop();
  c.header("Content-Type", ext === "svg" ? "image/svg+xml" : "image/png");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(new Uint8Array(buf));
});

export default app;
