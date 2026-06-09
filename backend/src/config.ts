import { config } from "dotenv";
import { resolve } from "path";
import type { OverlayType } from "@librenms-dash/shared";

config({ path: resolve(import.meta.dirname, "../../.env") });

export const LIBRENMS_URL = process.env.LIBRENMS_URL ?? "https://librenms.local.lan";
export const LIBRENMS_TOKEN = process.env.LIBRENMS_TOKEN ?? "";
export const PORT = Number(process.env.PORT ?? 3001);
export const AUTH_USERNAME = process.env.AUTH_USERNAME ?? "";
export const AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? "";

// Parse a comma-separated CIDR list from the environment; falls back when unset/empty.
function parseSubnetList(env: string | undefined, fallback: string[] = []): string[] {
  if (!env) return fallback;
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

// Overlay networks, configured per deployment so no specific subnets are baked in.
// Interface-name detection (zt*/wg*/tailscale*) always applies; these CIDRs add
// IP-based recognition of overlay addresses. Tailscale defaults to its standard
// CGNAT block (100.64.0.0/10); ZeroTier/WireGuard have no universal default.
export const OVERLAY_SUBNETS: Record<OverlayType, string[]> = {
  zerotier: parseSubnetList(process.env.ZEROTIER_SUBNETS),
  wireguard: parseSubnetList(process.env.WIREGUARD_SUBNETS),
  tailscale: parseSubnetList(process.env.TAILSCALE_SUBNETS, ["100.64.0.0/10"]),
};

// Docker bridge subnets — containers on these ranges are excluded from ARP
// discovery. Defaults to the standard Docker bridge pool (172.16.0.0/12).
export const DOCKER_SUBNETS = parseSubnetList(process.env.DOCKER_SUBNETS, ["172.16.0.0/12"]);

// Extra prefixes treated as infrastructure / non-discoverable when scanning ARP
// tables (in addition to the overlay subnets above). Defaults to loopback and
// link-local; Docker subnets are merged in automatically.
export const ARP_EXCLUDED_SUBNETS = [
  ...parseSubnetList(process.env.ARP_EXCLUDED_SUBNETS, [
    "127.0.0.0/8",
    "169.254.0.0/16",
  ]),
  ...DOCKER_SUBNETS,
];

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

if (!AUTH_USERNAME || !AUTH_PASSWORD) {
  throw new Error("AUTH_USERNAME and AUTH_PASSWORD are required in .env");
}
