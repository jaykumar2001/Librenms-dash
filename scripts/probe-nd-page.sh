#!/usr/bin/env bash
# Fetch LibreNMS /device/{id}/ports/nd and extract ND data shape.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

LIBRENMS_URL="" LIBRENMS_USER="" LIBRENMS_PASS="" LIBRENMS_TOKEN=""
while IFS='=' read -r key val; do
  [[ "$key" =~ ^# ]] && continue; [[ -z "$key" ]] && continue
  val="${val%%#*}"; val="${val%"${val##*[![:space:]]}"}"
  case "$key" in
    LIBRENMS_URL)   LIBRENMS_URL="$val" ;;
    LIBRENMS_USER)  LIBRENMS_USER="$val" ;;
    LIBRENMS_PASS)  LIBRENMS_PASS="$val" ;;
    LIBRENMS_TOKEN) LIBRENMS_TOKEN="$val" ;;
  esac
done < "$ENV_FILE"

BASE="${LIBRENMS_URL%/}"
COOKIEJAR=$(mktemp /tmp/probe_cookies.XXXXXX)
PYANALYZE=$(mktemp /tmp/probe_nd_analyze.XXXXXX.py)
trap 'rm -f "$COOKIEJAR" /tmp/probe_nd_page.html /tmp/probe_nd_ajax.json "$PYANALYZE"' EXIT

# ---- Login ----
echo "Logging in to $BASE ..."
LOGIN_HTML=$(curl -sk -c "$COOKIEJAR" -b "$COOKIEJAR" "${BASE}/login")
CSRF=$(echo "$LOGIN_HTML" | grep -oP 'name="_token"\s+value="\K[^"]+' | head -1)
[[ -z "$CSRF" ]] && { echo "ERROR: no CSRF token"; exit 1; }

curl -sk -o /dev/null -c "$COOKIEJAR" -b "$COOKIEJAR" \
  -X POST "${BASE}/login" \
  --data-urlencode "_token=${CSRF}" \
  --data-urlencode "username=${LIBRENMS_USER}" \
  --data-urlencode "password=${LIBRENMS_PASS}" \
  --max-redirs 0 || true

DASH_HTML=$(curl -sk -c "$COOKIEJAR" -b "$COOKIEJAR" "${BASE}/")
CSRF=$(echo "$DASH_HTML" | grep -oP 'name="_token"\s+value="\K[^"]+' | head -1)
echo "  Logged in, CSRF: ${CSRF:0:12}..."

# ---- Fetch the ND page ----
DEVICE_ID="${1:-36}"
ND_URL="${BASE}/device/${DEVICE_ID}/ports/nd"
echo ""
echo "Fetching: $ND_URL"
HTTP=$(curl -sk -o /tmp/probe_nd_page.html -w "%{http_code}" \
  -c "$COOKIEJAR" -b "$COOKIEJAR" "$ND_URL")
echo "HTTP: $HTTP"
echo ""

# Write analysis script to a temp file to avoid heredoc escaping issues
cat > "$PYANALYZE" << 'ENDPY'
import sys, re, json

with open(sys.argv[1]) as f:
    body = f.read()

print(f"Page size: {len(body)} bytes")
print()

# 1. AJAX table refs: look for the string pattern without backslash confusion
ajax_pattern = re.compile(r'ajax/table/([a-zA-Z0-9_\-]+)')
ajax_tables = list(set(ajax_pattern.findall(body)))
if ajax_tables:
    print(f"AJAX table refs in page: {ajax_tables}")
else:
    print("No /ajax/table/ refs found")

# 2. data-url attributes
data_urls = re.findall(r'data-url=["\']([^"\']+)["\']', body)
if data_urls:
    print(f"data-url attributes: {data_urls}")

# 3. Table <th> headers
headers = re.findall(r'<th[^>]*>(.*?)</th>', body, re.IGNORECASE | re.DOTALL)
clean = [re.sub(r'<[^>]+>', '', h).strip() for h in headers if h.strip()]
clean = [h for h in clean if h and len(h) < 80]
if clean:
    print(f"Table headers: {clean}")

# 4. IPv6 addresses visible in the page
ipv6_re = re.compile(r'\b(?:[0-9a-fA-F]{1,4}:){3,}[0-9a-fA-F:]+\b')
ipv6_hits = list(set(ipv6_re.findall(body)))[:20]
if ipv6_hits:
    print(f"\nIPv6 addresses found ({len(ipv6_hits)}): {ipv6_hits[:10]}")
else:
    print("\nNo IPv6 addresses found in page body")

# 5. MAC addresses visible in the page
mac_re = re.compile(r'\b(?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}\b')
macs = list(set(mac_re.findall(body)))[:10]
if macs:
    print(f"MAC addresses found: {macs}")

# 6. Snippet near ND/neighbour keywords
for kw in ['neighbour', 'ndp', 'ipv6_nd', '"nd"', 'Neighbour Discovery', 'reachable', 'stale']:
    idx = body.lower().find(kw.lower())
    if idx >= 0:
        snippet = body[max(0, idx-80):idx+300].replace('\n', ' ').strip()
        snippet = re.sub(r'\s+', ' ', snippet)
        print(f"\nSnippet near '{kw}':\n  {snippet[:400]}")
        break

# 7. Show any bootgrid / datatable init JS
for kw in ['bootgrid', 'DataTable', 'rowCount', 'ajax']:
    idx = body.find(kw)
    if idx >= 0:
        snippet = body[max(0, idx-20):idx+400].replace('\n', ' ')
        snippet = re.sub(r'\s+', ' ', snippet)
        print(f"\nJS init near '{kw}':\n  {snippet[:400]}")
        break
ENDPY

python3 "$PYANALYZE" /tmp/probe_nd_page.html

# ---- Probe candidate AJAX POST endpoints ----
echo ""
echo "=== Probing candidate AJAX POST endpoints (device_id=$DEVICE_ID) ==="
for TABLE in "ipv6-nd-neighbours" "ipv6-neighbours" "nd" "ports-nd" "port-nd" "neighbours-ipv6" "ipv6_nd" "ipv6nd"; do
  HTTP=$(curl -sk -o /tmp/probe_nd_ajax.json -w "%{http_code}" \
    -c "$COOKIEJAR" -b "$COOKIEJAR" \
    -X POST "${BASE}/ajax/table/${TABLE}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "X-Requested-With: XMLHttpRequest" \
    -H "X-CSRF-TOKEN: ${CSRF}" \
    --data-raw "current=1&rowCount=50&searchPhrase=&device_id=${DEVICE_ID}" 2>/dev/null || echo "000")
  if [[ "$HTTP" == "200" ]]; then
    echo "  /ajax/table/$TABLE → HTTP 200 ✓"
    python3 -c "
import json
with open('/tmp/probe_nd_ajax.json') as f:
    try:
        d = json.load(f)
        rows = d.get('rows', [])
        print(f'    total={d.get(\"total\",\"?\")}, rows={len(rows)}')
        if rows and isinstance(rows[0], dict):
            print(f'    keys: {list(rows[0].keys())}')
            print(f'    sample: {json.dumps(rows[0])[:400]}')
        elif not rows:
            print(f'    (empty result set)')
    except Exception as e:
        with open('/tmp/probe_nd_ajax.json') as ff: print('   ', ff.read()[:200])
"
  else
    echo "  /ajax/table/$TABLE → HTTP $HTTP"
  fi
done
