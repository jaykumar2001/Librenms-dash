import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import argon2 from "../backend/node_modules/argon2/argon2.cjs";

const secretDir = mkdtempSync(join(tmpdir(), "librenms-dash-smoke-"));
const token = "synthetic-api-token";
writeFileSync(join(secretDir, "api"), token + "\n", { mode: 0o600 });
writeFileSync(join(secretDir, "hash"), (await argon2.hash("synthetic-password", { type: argon2.argon2id })) + "\n", { mode: 0o600 });

let hits = 0;
const mock = createServer((req, res) => {
  if (req.headers["x-auth-token"] !== token) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  hits++;
  const pathname = new URL(req.url, "http://localhost").pathname;
  const payload = pathname.endsWith("/devices") ? { devices: [] }
    : pathname.endsWith("/resources/locations") ? { locations: [] }
    : pathname.endsWith("/resources/links") ? { links: [] }
    : pathname.endsWith("/alerts") ? { alerts: [] } : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
});
let child;
try {
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;

  // Ask the OS for an unused port, then release it before starting the application.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const env = { ...process.env,
    LIBRENMS_URL: `http://127.0.0.1:${mockPort}`,
    LIBRENMS_TOKEN_FILE: join(secretDir, "api"),
    AUTH_PASSWORD_HASH_FILE: join(secretDir, "hash"),
    AUTH_USERNAME: "smoke-user",
    PORT: String(port),
    NODE_ENV: "test",
  };
  for (const key of ["LIBRENMS_TOKEN", "AUTH_PASSWORD", "AUTH_PASSWORD_HASH", "LIBRENMS_PASS", "LIBRENMS_PASS_FILE"]) delete env[key];
  child = spawn(process.execPath, ["backend/dist/index.js"], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", b => output += b.toString());
  child.stderr.on("data", b => output += b.toString());

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Backend exited during startup: " + output.slice(-1500));
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok && (await res.json()).status === "ok") { ready = true; break; }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Backend did not become ready: " + output.slice(-1500));

  const login = (username, password) => fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const good = await login("smoke-user", "synthetic-password");
  if (good.status !== 200 || !good.headers.get("set-cookie")) throw new Error("Valid login failed");
  const bad = await login("smoke-user", "incorrect-password");
  if (bad.status !== 401) throw new Error("Invalid password was accepted");
  const unknown = await login("unknown-user", "synthetic-password");
  if (unknown.status !== 401) throw new Error("Unknown user was accepted");
  if (hits < 3) throw new Error("Mock LibreNMS API was not contacted");
  console.log("PASS: real backend startup, mounted-style file credentials, mock API token, login and rejection");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await new Promise(resolve => mock.close(resolve));
  rmSync(secretDir, { recursive: true, force: true });
}
