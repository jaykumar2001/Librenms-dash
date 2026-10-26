import { describe, expect, it } from "vitest";
import { hash, argon2id } from "argon2";
import { verifyPassword } from "./password.js";

describe("verifyPassword", () => {
  it("accepts a correct Argon2id password", async () => {
    const stored = await hash("correct-password", { type: argon2id });
    expect(await verifyPassword("correct-password", stored, ""))
      .toBe(true);
  });

  it("rejects an incorrect Argon2id password", async () => {
    const stored = await hash("correct-password", { type: argon2id });
    expect(await verifyPassword("wrong-password", stored, ""))
      .toBe(false);
  });

  it("supports legacy plaintext configuration", async () => {
    expect(await verifyPassword("legacy", "", "legacy"))
      .toBe(true);
  });

  it("rejects incorrect legacy credentials", async () => {
    expect(await verifyPassword("wrong", "", "legacy"))
      .toBe(false);
  });

  it("prefers the hash over legacy credentials", async () => {
    const stored = await hash("new-password", { type: argon2id });
    expect(await verifyPassword("old-password", stored, "old-password"))
      .toBe(false);
  });

  it("rejects unsupported hash formats", async () => {
    await expect(
      verifyPassword("password", "$2b$invalid", "")
    ).rejects.toThrow("Unsupported password hash format");
  });
});
