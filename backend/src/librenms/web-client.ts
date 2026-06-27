import { LIBRENMS_URL, LIBRENMS_USER, LIBRENMS_PASS } from "../config.js";
import type { LnmsRoute, LnmsNdEntry } from "./types.js";

let sessionCookie = "";
let csrfToken = "";
let disabled = false;

const REQUEST_TIMEOUT_MS = 30_000;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractIfaceName(html: string): string {
  const match = html.match(/>\s*([A-Za-z0-9._\-/]+)\s/);
  if (match) return match[1];
  return stripHtml(html).split(" ").pop() ?? "";
}

function extractNextHop(html: string): string {
  return stripHtml(html).split("(")[0].trim();
}

async function webFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = new URL(path, LIBRENMS_URL);
  const headers: Record<string, string> = {
    Cookie: sessionCookie,
    ...(options.headers as Record<string, string> ?? {}),
  };
  return fetch(url.toString(), {
    ...options,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function extractCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const jar = new Map<string, string>();
  // Preserve existing cookies
  for (const part of sessionCookie.split(";")) {
    const [k, v] = part.split("=").map(s => s.trim());
    if (k && v) jar.set(k, v);
  }
  // Apply new set-cookie headers
  for (const sc of setCookies) {
    const cookiePart = sc.split(";")[0];
    const [k, v] = cookiePart.split("=").map(s => s.trim());
    if (k && v) jar.set(k, v);
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function login(): Promise<boolean> {
  try {
    // Get login page for CSRF token
    const loginPage = await webFetch("/login");
    sessionCookie = extractCookies(loginPage);
    const html = await loginPage.text();
    const csrfMatch = html.match(/name="_token"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      console.warn("[web-client] Route polling disabled — could not extract CSRF token from login page");
      return false;
    }

    // POST login
    const body = new URLSearchParams({
      _token: csrfMatch[1],
      username: LIBRENMS_USER,
      password: LIBRENMS_PASS,
    });
    const loginRes = await webFetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    sessionCookie = extractCookies(loginRes);

    // 302 redirect to "/" means success; 200 staying on /login means bad credentials
    if (loginRes.status !== 302) {
      return false;
    }

    // Get CSRF token from authenticated page
    const dashRes = await webFetch("/");
    sessionCookie = extractCookies(dashRes);
    const dashHtml = await dashRes.text();
    const dashCsrf = dashHtml.match(/name="_token"\s+value="([^"]+)"/);
    if (dashCsrf) {
      csrfToken = dashCsrf[1];
    }

    return true;
  } catch {
    return false;
  }
}

export async function initWebSession(): Promise<boolean> {
  if (!LIBRENMS_USER || !LIBRENMS_PASS) {
    console.log("[web-client] Route polling disabled — LIBRENMS_USER/LIBRENMS_PASS not configured");
    disabled = true;
    return false;
  }

  const ok = await login();
  if (!ok) {
    console.log("[web-client] Route polling disabled — invalid LIBRENMS_USER/LIBRENMS_PASS or login failed");
    disabled = true;
    return false;
  }

  console.log("[web-client] Web session established for route polling");
  return true;
}

export function isWebClientEnabled(): boolean {
  return !disabled;
}

export async function fetchRoutes(deviceId: number): Promise<LnmsRoute[]> {
  if (disabled) return [];

  try {
    const body = new URLSearchParams({
      current: "1",
      rowCount: "500",
      searchPhrase: "",
      device_id: String(deviceId),
      showAllRoutes: "false",
      showProtocols: "all",
    });

    let res = await webFetch("/ajax/table/routes", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrfToken,
      },
      body: body.toString(),
    });

    // Session expired — try one re-login
    if (res.status === 401 || res.status === 302 || res.status === 419) {
      const ok = await login();
      if (!ok) {
        console.log("[web-client] Route polling disabled — re-authentication failed");
        disabled = true;
        return [];
      }
      res = await webFetch("/ajax/table/routes", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-TOKEN": csrfToken,
        },
        body: body.toString(),
      });
    }

    if (!res.ok) return [];

    const data = await res.json() as { rows?: LnmsRoute[]; total?: number };
    return data.rows ?? [];
  } catch {
    return [];
  }
}

function parseNdTable(html: string): LnmsNdEntry[] {
  const macHeaderIdx = html.indexOf('MAC address');
  if (macHeaderIdx === -1) return [];

  const tableStart = html.lastIndexOf('<table', macHeaderIdx);
  const tableEnd = html.indexOf('</table>', macHeaderIdx) + '</table>'.length;
  if (tableStart === -1 || tableEnd < '</table>'.length) return [];

  const tableHtml = html.slice(tableStart, tableEnd);
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const results: LnmsNdEntry[] = [];
  let rowMatch: RegExpExecArray | null;
  let isFirst = true;

  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    if (isFirst) { isFirst = false; continue; } // skip header

    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(cellMatch[1]);
    if (cells.length < 4) continue;

    const portHref = cells[0].match(/href="[^"]+\/port=(\d+)\/[^"]*"[^>]*>\s*([A-Za-z0-9._\-/]+)/);
    const portName = portHref ? portHref[2].trim() : stripTags(cells[0]).split(' ')[0];
    const portId = portHref ? parseInt(portHref[1], 10) : null;

    const mac = stripTags(cells[1]);
    const vendor = stripTags(cells[2]);
    const ipv6 = stripTags(cells[3]);
    if (!mac || !ipv6) continue;

    const remoteDevMatch = cells[4]?.match(/href="[^"]*device=\d+[^"]*"[^>]*>\s*([^\n<]{1,60})/);
    const remoteDevice = remoteDevMatch ? remoteDevMatch[1].trim() : '';

    const remoteIfaceMatch = cells[5]?.match(/href="[^"]+\/port=\d+\/[^"]*"[^>]*>\s*([A-Za-z0-9._\-/]+)/);
    const remoteInterface = remoteIfaceMatch ? remoteIfaceMatch[1].trim() : '';

    results.push({ portName, portId, mac, vendor, ipv6, remoteDevice, remoteInterface });
  }

  return results;
}

export async function fetchNdNeighbours(deviceId: number): Promise<LnmsNdEntry[]> {
  if (disabled) return [];

  const path = `/device/${deviceId}/ports/nd`;

  try {
    let res = await webFetch(path);

    if (res.status === 401 || res.status === 302 || res.status === 419) {
      const ok = await login();
      if (!ok) {
        console.log("[web-client] ND polling disabled — re-authentication failed");
        disabled = true;
        return [];
      }
      res = await webFetch(path);
    }

    if (!res.ok) return [];
    return parseNdTable(await res.text());
  } catch {
    return [];
  }
}

export { extractIfaceName, extractNextHop, stripHtml };
