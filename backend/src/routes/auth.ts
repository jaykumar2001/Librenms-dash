import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AUTH_PASSWORD, AUTH_USERNAME } from "../config.js";
import { createSession, destroySession, isValidSession, SESSION_COOKIE } from "../auth/sessions.js";

const app = new Hono();

const cookieOptions = {
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60,
};

app.get("/me", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!isValidSession(token)) {
    return c.json({ authenticated: false }, 401);
  }
  return c.json({ authenticated: true, username: AUTH_USERNAME });
});

app.post("/login", async (c) => {
  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { username, password } = body;
  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  const token = createSession();
  setCookie(c, SESSION_COOKIE, token, cookieOptions);
  return c.json({ authenticated: true, username: AUTH_USERNAME });
});

app.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ authenticated: false });
});

export default app;
