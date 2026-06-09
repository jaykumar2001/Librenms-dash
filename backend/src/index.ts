import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { PORT } from "./config.js";
import { warmCache, startPoller } from "./jobs/poller.js";
import topologyRoutes from "./routes/topology.js";
import deviceRoutes from "./routes/devices.js";
import graphRoutes from "./routes/graphs.js";
import portRoutes from "./routes/ports.js";
import authRoutes from "./routes/auth.js";
import { requireAuth } from "./middleware/auth.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: process.env.NODE_ENV === "production"
    ? (origin) => (!origin || origin === `http://localhost:${PORT}`) ? origin : null
    : "*",
}));

let cacheReady = false;

app.get("/api/health", (c) => c.json({ status: cacheReady ? "ok" : "warming", uptime: process.uptime() }));

app.route("/api/auth", authRoutes);

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth")) {
    await next();
    return;
  }
  if (!cacheReady && c.req.path !== "/api/health") {
    return c.json({ error: "Cache warming, try again shortly" }, 503);
  }
  await next();
});

app.use("/api/*", requireAuth());

app.route("/api/topology", topologyRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/graph", graphRoutes);
app.route("/api/ports", portRoutes);

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
  startPoller();
  console.log(`[librenms-dash] Cache ready — serving requests`);
}

main().catch((e) => {
  console.error("[librenms-dash] Fatal:", e);
  process.exit(1);
});
