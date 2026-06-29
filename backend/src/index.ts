import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import { PORT } from "./config.js";
import { warmCache, startPoller } from "./jobs/poller.js";
import topologyRoutes from "./routes/topology.js";
import deviceRoutes from "./routes/devices.js";
import graphRoutes from "./routes/graphs.js";
import portRoutes from "./routes/ports.js";
import authRoutes from "./routes/auth.js";
import eventRoutes from "./routes/events.js";
import { requireAuth } from "./middleware/auth.js";

const app = new Hono();

app.use("*", compress());
app.use("*", logger());
app.use("*", cors({
  origin: process.env.NODE_ENV === "production"
    ? (origin) => (!origin || origin === `http://localhost:${PORT}`) ? origin : null
    : "*",
}));

let cacheReady = false;
const cacheReadyListeners = new Set<() => void>();

function onCacheReady(fn: () => void) { cacheReadyListeners.add(fn); }
function offCacheReady(fn: () => void) { cacheReadyListeners.delete(fn); }

app.get("/api/health", (c) => c.json({ status: cacheReady ? "ok" : "warming", uptime: process.uptime() }));

app.get("/api/health/stream", (c) => {
  return streamSSE(c, async (stream) => {
    if (cacheReady) {
      await stream.writeSSE({ data: "ok", event: "ready" });
      return;
    }
    const notify = () => {
      stream.writeSSE({ data: "ok", event: "ready" }).catch(() => {});
    };
    onCacheReady(notify);
    stream.onAbort(() => offCacheReady(notify));
    while (!stream.aborted && !cacheReady) {
      await stream.sleep(5_000);
    }
  });
});

app.route("/api/auth", authRoutes);

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth") || c.req.path.startsWith("/api/health")) {
    await next();
    return;
  }
  if (!cacheReady) {
    return c.json({ error: "Cache warming, try again shortly" }, 503);
  }
  await next();
});

app.use("/api/*", requireAuth());

app.route("/api/topology", topologyRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/graph", graphRoutes);
app.route("/api/ports", portRoutes);
app.route("/api/events", eventRoutes);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./frontend/dist" }));
  app.get("*", serveStatic({ root: "./frontend/dist", path: "index.html" }));
}

async function main() {
  console.log(`[librenms-dash] Starting backend on port ${PORT}...`);
  // Start listening immediately so /api/health responds (with "warming") while
  // the cache fills — on a large fleet warmCache can take a while.
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[librenms-dash] Backend listening at http://localhost:${info.port} (warming cache...)`);
  });
  await warmCache();
  cacheReady = true;
  for (const fn of cacheReadyListeners) fn();
  cacheReadyListeners.clear();
  startPoller();
  console.log(`[librenms-dash] Cache ready — serving requests`);
}

main().catch((e) => {
  console.error("[librenms-dash] Fatal:", e);
  process.exit(1);
});
