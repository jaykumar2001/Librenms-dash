#!/usr/bin/env bash
# Probe LibreNMS web UI AJAX endpoints for IPv6 ND / neighbour data.
# Reads LIBRENMS_URL, LIBRENMS_USER, LIBRENMS_PASS from .env in the repo root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

LIBRENMS_URL="" LIBRENMS_USER="" LIBRENMS_PASS=""
while IFS='=' read -r key val; do
  [[ "$key" =~ ^# ]] && continue; [[ -z "$key" ]] && continue
  val="${val%%#*}"; val="${val%"${val##*[![:space:]]}"}"
  case "$key" in
    LIBRENMS_URL)   LIBRENMS_URL="$val" ;;
    LIBRENMS_USER)  LIBRENMS_USER="$val" ;;
    LIBRENMS_PASS)  LIBRENMS_PASS="$val" ;;
  esac
done < "$ENV_FILE"

if [[ -z "$LIBRENMS_USER" || -z "$LIBRENMS_PASS" ]]; then
  echo "ERROR: LIBRENMS_USER or LIBRENMS_PASS missing from .env (needed for web scraping)" >&2
  exit 1
fi

BASE="${LIBRENMS_URL%/}"
COOKIEJAR=$(mktemp /tmp/probe_cookies.XXXXXX)
trap 'rm -f "$COOKIEJAR" /tmp/probe_nd_body.json /tmp/probe_nd_devices.json' EXIT

# ---- Step 1: get CSRF token from login page ----
echo "Fetching login page..."
LOGIN_HTML=$(curl -sk -c "$COOKIEJAR" -b "$COOKIEJAR" "${BASE}/login")
CSRF=$(echo "$LOGIN_HTML" | grep -oP 'name="_token"\s+value="\K[^"]+' | head -1)
if [[ -z "$CSRF" ]]; then
  echo "ERROR: could not extract CSRF token from login page" >&2; exit 1
fi
echo "  Got CSRF: ${CSRF:0:12}..."

# ---- Step 2: POST login ----
echo "Logging in..."
LOGIN_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" \
  -c "$COOKIEJAR" -b "$COOKIEJAR" \
  -X POST "${BASE}/login" \
  -d "_token=${CSRF}&username=${LIBRENMS_USER}&password=${LIBRENMS_PASS}" \
  --location-trusted --max-redirs 0 || true)
# Expect 302 on success
echo "  Login HTTP: $LOGIN_STATUS"

# ---- Step 3: refresh CSRF from dashboard ----
DASH_HTML=$(curl -sk -c "$COOKIEJAR" -b "$COOKIEJAR" "${BASE}/")
CSRF=$(echo "$DASH_HTML" | grep -oP 'name="_token"\s+value="\K[^"]+' | head -1)
echo "  Refreshed CSRF: ${CSRF:0:12}..."

# ---- Step 4: pick a device_id ----
echo "Fetching device list via API..."
DEVICE_JSON=$(curl -sk -H "X-Auth-Token: $(grep LIBRENMS_TOKEN "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d ' ')" \
  "${BASE}/api/v0/devices?limit=50" -o /tmp/probe_nd_devices.json && cat /tmp/probe_nd_devices.json)

DEVICE_ID=$(python3 -c "
import json, ipaddress
OVERLAY_NETS = [ipaddress.ip_network('100.64.0.0/10'), ipaddress.ip_network('10.147.0.0/16'), ipaddress.ip_network('172.16.0.0/12')]
def is_overlay(ip):
    try: return any(ipaddress.ip_address(ip) in n for n in OVERLAY_NETS)
    except: return False
with open('/tmp/probe_nd_devices.json') as f:
    devs = json.load(f).get('devices', [])
active = [d for d in devs if d.get('status') == 1]
physical = [d for d in active if not is_overlay(d.get('ip', ''))]
pick = physical[0] if physical else (active[0] if active else None)
if pick: print(pick['device_id'], pick['hostname'])
" 2>/dev/null)

DEVICE_ID_NUM=$(echo "$DEVICE_ID" | awk '{print $1}')
DEVICE_HOSTNAME=$(echo "$DEVICE_ID" | awk '{print $2}')
echo "  Target: $DEVICE_HOSTNAME (id=$DEVICE_ID_NUM)"
echo ""
echo "============================================================"

# ---- Helper: probe one AJAX table endpoint ----
ajax_probe() {
  local label="$1"
  local table="$2"
  local extra_params="${3:-}"

  echo ""
  echo "=== $label ==="
  echo "    POST /ajax/table/${table}"

  local BODY="current=1&rowCount=50&searchPhrase=&device_id=${DEVICE_ID_NUM}${extra_params}"
  local HTTP
  HTTP=$(curl -sk -o /tmp/probe_nd_body.json -w "%{http_code}" \
    -c "$COOKIEJAR" -b "$COOKIEJAR" \
    -X POST "${BASE}/ajax/table/${table}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "X-Requested-With: XMLHttpRequest" \
    -H "X-CSRF-TOKEN: ${CSRF}" \
    --data-urlencode "" \
    --data-raw "$BODY" 2>/dev/null || echo "000")

  echo "    HTTP $HTTP"
  if [[ "$HTTP" == "200" ]]; then
    python3 - /tmp/probe_nd_body.json <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    try: data = json.load(f)
    except Exception as e: print(f"    [invalid JSON: {e}]"); sys.exit(0)
if isinstance(data, dict):
    total = data.get('total', '?')
    rows = data.get('rows', [])
    print(f"    total={total}, rows={len(rows)}")
    if rows and isinstance(rows[0], dict):
        print(f"    sample keys: {list(rows[0].keys())}")
        print(f"    sample row:  {json.dumps(rows[0])[:300]}")
    elif rows:
        print(f"    sample: {repr(rows[0])[:200]}")
    for k, v in data.items():
        if k not in ('rows', 'total'):
            print(f"    .{k} = {repr(v)[:80]}")
else:
    print(f"    raw: {repr(data)[:200]}")
PYEOF
  else
    python3 -c "
import sys
with open('/tmp/probe_nd_body.json') as f:
    print('   ', f.read()[:300])
"
  fi
}

# ---- Also probe raw device tab pages ----
page_probe() {
  local label="$1"
  local path="$2"

  echo ""
  echo "=== $label ==="
  echo "    GET $path"
  local HTTP
  HTTP=$(curl -sk -o /tmp/probe_nd_body.json -w "%{http_code}" \
    -c "$COOKIEJAR" -b "$COOKIEJAR" "${BASE}${path}" 2>/dev/null || echo "000")
  echo "    HTTP $HTTP"
  python3 - /tmp/probe_nd_body.json "$HTTP" <<'PYEOF'
import sys, re, json
http = sys.argv[2]
with open(sys.argv[1]) as f:
    body = f.read(4000)
if http != "200":
    print("   ", body[:200]); sys.exit(0)
# Look for IPv6 or ND-related content
ipv6_re = re.compile(r'([0-9a-fA-F]{1,4}:){3,}[0-9a-fA-F:]+')
ipv6_hits = list(set(ipv6_re.findall(body)))[:10]
if ipv6_hits:
    print(f"    Found IPv6 patterns: {ipv6_hits}")
else:
    print("    No IPv6 patterns found in first 4KB")
# Check for table headers
headers = re.findall(r'<th[^>]*>(.*?)</th>', body, re.IGNORECASE)
if headers:
    print(f"    Table headers: {[h[:40] for h in headers[:10]]}")
# Look for ajax_table or data-table references
ajax = re.findall(r"ajax/table/([a-z0-9_\-]+)", body)
if ajax:
    print(f"    AJAX table refs found: {list(set(ajax))}")
PYEOF
}

# ---- AJAX table probes ----
ajax_probe "IPv6 neighbours (hyphen)"        "ipv6-neighbours"
ajax_probe "IPv6 neighbours (underscore)"    "ipv6_neighbours"
ajax_probe "Neighbours6"                     "neighbours6"
ajax_probe "IPv6 ND"                         "ipv6-nd"
ajax_probe "IPv6 NDP"                        "ipv6-ndp"
ajax_probe "IPv6 ARP"                        "ipv6-arp"
ajax_probe "Neighbours (LLDP/CDP)"           "neighbours"
ajax_probe "MAC addresses table"             "macs"
ajax_probe "FDB (forwarding DB)"             "fdb"
ajax_probe "IPv6 addresses"                  "ipv6"

# ---- Device web page probes ----
page_probe "Device neighbours tab"   "/device/device=${DEVICE_ID_NUM}/tab=neighbours/"
page_probe "Device IPv6 tab"         "/device/device=${DEVICE_ID_NUM}/tab=ipv6/"
page_probe "Device ND tab"           "/device/device=${DEVICE_ID_NUM}/tab=neighbours#ipv6"

echo ""
echo "============================================================"
echo "Done."
