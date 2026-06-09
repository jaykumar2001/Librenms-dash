import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { isValidSession, SESSION_COOKIE } from "../auth/sessions.js";

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/auth") || path === "/api/health") {
      await next();
      return;
    }

    const token = getCookie(c, SESSION_COOKIE);
    if (!isValidSession(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
