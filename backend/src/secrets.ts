import { readFileSync } from "node:fs";

export function readSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = env[`${name}_FILE`];

  if (filePath !== undefined) {
    if (!filePath.trim()) {
      throw new Error(`${name}_FILE must not be empty`);
    }

    if (env[name] !== undefined) {
      throw new Error(
        `Configure either ${name} or ${name}_FILE, not both`,
      );
    }

    try {
      const value = readFileSync(filePath, "utf8")
        .replace(/[\r\n]+$/, "");

      if (!value) {
        throw new Error("Secret file is empty");
      }

      return value;
    } catch {
      throw new Error(`Unable to load ${name} from its secret file`);
    }
  }

  return env[name] ?? "";
}
