#!/usr/bin/env bash
# Probe LibreNMS API for IPv6 ND / neighbour-discovery endpoints.
# Reads LIBRENMS_URL and LIBRENMS_TOKEN from .env in the repo root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

# Source only the two vars we need (ignore errors for unset vars)
LIBRENMS_URL=""
LIBRENMS_TOKEN=""
while IFS='=' read -r key val; do
  [[ "$key" =~ ^# ]] && continue
  [[ -z "$key" ]] && continue
  val="${val%%#*}"        # strip inline comments
  val="${val%"${val##*[![:space:]]}"}"  # strip trailing whitespace
  case "$key" in
    LIBRENMS_URL)   LIBRENMS_URL="$val" ;;
    LIBRENMS_TOKEN) LIBRENMS_TOKEN="$val" ;;
  esac
done < "$ENV_FILE"

if [[ -z "$LIBRENMS_URL" || -z "$LIBRENMS_TOKEN" ]]; then
  echo "ERROR: LIBRENMS_URL or LIBRENMS_TOKEN missing from .env" >&2
  exit 1
fi

BASE="${LIBRENMS_URL%/}/api/v0"
HDR="X-Auth-Token: $LIBRENMS_TOKEN"

probe() {
  local label="$1"
  local path="$2"
  echo ""
  echo "=== $label ==="
  echo "    GET $path"
  local http_code body
  body=$(curl -sk -o /tmp/probe_body.json -w "%{http_code}" \
    -H "$HDR" "${BASE}${path}") || { echo "    [curl error]"; return; }
  http_code="$body"
  echo "    HTTP $http_code"
  if [[ "$http_code" == "200" ]]; then
    # Print top-level keys and first element of any array (truncated)
    python3 - /tmp/probe_body.json <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    try:
        data = json.load(f)
    except Exception as e:
        print(f"    [invalid JSON: {e}]")
        sys.exit(0)

if isinstance(data, dict):
    for k, v in data.items():
        if isinstance(v, list):
            print(f"    .{k}: list[{len(v)}]", end="")
            if v:
                sample = v[0]
                keys = list(sample.keys()) if isinstance(sample, dict) else repr(sample)[:80]
                print(f"  sample keys: {keys}")
            else:
                print("  (empty)")
        else:
            print(f"    .{k}: {repr(v)[:80]}")
elif isinstance(data, list):
    print(f"    list[{len(data)}]")
    if data and isinstance(data[0], dict):
        print(f"    sample keys: {list(data[0].keys())}")
PYEOF
  else
    head -c 200 /tmp/probe_body.json && echo ""
  fi
}

# ---- Pick one device hostname for per-device probes ----
echo "Fetching device list to pick a probe target..."
curl -sk -H "$HDR" "${BASE}/devices?limit=1" -o /tmp/probe_devices.json
HOSTNAME=$(python3 -c "
import json, ipaddress
with open('/tmp/probe_devices.json') as f:
    d = json.load(f)
devs = d.get('devices', [])
# Prefer active devices on physical (non-overlay) IPs
# Skip Tailscale (100.64/10), ZeroTier (10.147.*), and other common overlay ranges
OVERLAY_NETS = [
    ipaddress.ip_network('100.64.0.0/10'),   # Tailscale CGNAT
    ipaddress.ip_network('10.147.0.0/16'),    # ZeroTier default
    ipaddress.ip_network('172.16.0.0/12'),    # Docker bridge
]
def is_overlay(ip):
    try:
        a = ipaddress.ip_address(ip)
        return any(a in net for net in OVERLAY_NETS)
    except Exception:
        return False
active = [x for x in devs if x.get('status') == 1]
physical = [x for x in active if not is_overlay(x.get('ip',''))]
pick = physical[0] if physical else (active[0] if active else (devs[0] if devs else None))
if pick:
    print(pick['hostname'])
" 2>/dev/null || true)

if [[ -z "$HOSTNAME" ]]; then
  echo "WARNING: could not pick a device; skipping per-device probes"
fi

echo ""
echo "Target device: ${HOSTNAME:-none}"
echo "============================================================"

# ---- Global endpoints ----
probe "ARP all (baseline — known working)"     "/resources/ip/arp/all"
probe "IPv6 v6 all"                            "/resources/ip/v6/all"
probe "IPv6 v6-neighbours all"                 "/resources/ip/v6-neighbours"
probe "IPv6 addresses (all)"                   "/resources/ip/addresses"

# ---- Per-device endpoints ----
if [[ -n "$HOSTNAME" ]]; then
  probe "Per-device: ip (baseline)"             "/devices/${HOSTNAME}/ip"
  probe "Per-device: ipv6"                      "/devices/${HOSTNAME}/ipv6"
  probe "Per-device: ipv6neighbours"            "/devices/${HOSTNAME}/ipv6neighbours"
  probe "Per-device: ipv6-neighbours"           "/devices/${HOSTNAME}/ipv6-neighbours"
  probe "Per-device: neighbours (LLDP/CDP)"     "/devices/${HOSTNAME}/neighbours"

  echo ""
  echo "=== Raw body: ipv6neighbours for $HOSTNAME ==="
  curl -sk -H "$HDR" "${BASE}/devices/${HOSTNAME}/ipv6neighbours" | head -c 500
  echo ""
fi

echo ""
echo "============================================================"
echo "Done. Check HTTP 200 entries above for usable ND endpoints."
rm -f /tmp/probe_body.json /tmp/probe_devices.json
