import { createHash, timingSafeEqual } from "node:crypto";
import { verify } from "argon2";

export async function verifyPassword(
  supplied: string,
  storedHash: string,
  legacyPassword: string,
): Promise<boolean> {
  if (storedHash) {
    if (!storedHash.startsWith("$argon2id$")) {
      throw new Error("Unsupported password hash format");
    }

    try {
      return await verify(storedHash, supplied);
    } catch {
      return false;
    }
  }

  if (!legacyPassword) return false;

  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(legacyPassword).digest();

  return timingSafeEqual(a, b);
}
