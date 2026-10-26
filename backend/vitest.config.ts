import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      LIBRENMS_TOKEN: "test-token-not-real",
      AUTH_USERNAME: "test-admin",
      AUTH_PASSWORD: "test-password-not-real",
    },
  },
});
