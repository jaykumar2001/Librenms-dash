import { beforeAll, describe, expect, it, vi } from "vitest";
import { argon2id, hash } from "argon2";

describe("HTTP login with Argon2id", () => {
  let app: typeof import("./auth.js").default;

  beforeAll(async () => {
    const passwordHash = await hash("correct-test-password", {
      type: argon2id,
    });

    vi.resetModules();
    vi.stubEnv("AUTH_USERNAME", "security-test-user");
    vi.stubEnv("AUTH_PASSWORD", "");
    vi.stubEnv("AUTH_PASSWORD_HASH", passwordHash);
    vi.stubEnv("AUTH_PASSWORD_HASH_FILE", "");

    // An empty *_FILE is invalid; remove it entirely.
    delete process.env.AUTH_PASSWORD_HASH_FILE;

    app = (await import("./auth.js")).default;
  });

  async function login(username: unknown, password: unknown) {
    return app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  it("accepts valid credentials and creates a session", async () => {
    const response = await login(
      "security-test-user",
      "correct-test-password",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("rejects an incorrect password", async () => {
    const response = await login(
      "security-test-user",
      "incorrect-password",
    );

    expect(response.status).toBe(401);
  });

  it("rejects an unknown username", async () => {
    const response = await login(
      "unknown-user",
      "correct-test-password",
    );

    expect(response.status).toBe(401);
  });

  it("rejects non-string passwords", async () => {
    const response = await login("security-test-user", {});
    expect(response.status).toBe(401);
  });
});
