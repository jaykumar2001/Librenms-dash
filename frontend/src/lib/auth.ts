const BASE = "/api/auth";

async function authFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  return res;
}

export interface AuthUser {
  username: string;
}

export async function fetchAuthStatus(): Promise<AuthUser | null> {
  const res = await authFetch("/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Auth check failed: ${res.status}`);
  const data = await res.json();
  return { username: data.username };
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await authFetch("/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Login failed");
  }
  const data = await res.json();
  return { username: data.username };
}

export async function logout(): Promise<void> {
  await authFetch("/logout", { method: "POST" });
}
