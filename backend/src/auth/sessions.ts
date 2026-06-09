import { randomBytes } from "crypto";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Session {
  createdAt: number;
}

const sessions = new Map<string, Session>();

export const SESSION_COOKIE = "session";

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}
