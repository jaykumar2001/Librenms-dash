import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, "../../.env") });

export const LIBRENMS_URL = process.env.LIBRENMS_URL ?? "https://librenms.local.lan";
export const LIBRENMS_TOKEN = process.env.LIBRENMS_TOKEN ?? "";
export const PORT = Number(process.env.PORT ?? 3001);

// Disables TLS verification process-wide — required for self-signed LibreNMS certs.
// This is only safe because this process exclusively talks to the configured LibreNMS
// instance over HTTPS. Skipped entirely when LibreNMS is plain HTTP so we don't weaken
// TLS for no reason. (Scoping this to a per-host dispatcher would require adding undici.)
if (LIBRENMS_URL.startsWith("https://")) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

if (!LIBRENMS_TOKEN) {
  throw new Error("LIBRENMS_TOKEN is required in .env");
}
