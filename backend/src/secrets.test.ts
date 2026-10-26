import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret } from "./secrets.js";

describe("readSecret", () => {
  it("supports legacy environment variables", () => {
    expect(readSecret("TOKEN", { TOKEN: "legacy" }))
      .toBe("legacy");
  });

  it("returns empty for optional missing secrets", () => {
    expect(readSecret("TOKEN", {})).toBe("");
  });

  it("loads a secret from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-secret-"));
    try {
      const path = join(dir, "token");
      writeFileSync(path, "test-token\n", { mode: 0o600 });

      expect(readSecret("TOKEN", {
        TOKEN_FILE: path,
      })).toBe("test-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects conflicting configuration", () => {
    expect(() => readSecret("TOKEN", {
      TOKEN: "legacy",
      TOKEN_FILE: "/unused",
    })).toThrow(/either TOKEN or TOKEN_FILE/);
  });

  it("rejects unreadable secret files", () => {
    expect(() => readSecret("TOKEN", {
      TOKEN_FILE: "/nonexistent/dash-secret",
    })).toThrow(/Unable to load TOKEN/);
  });
});
