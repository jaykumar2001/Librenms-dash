import { readFile } from "fs/promises";
import { resolve } from "path";
import { existsSync } from "fs";

const oui24Map = new Map<string, string>();
const oui36Map = new Map<string, string>();
let loaded = false;

function findDataDir(): string {
  // Works for both dev (src/librenms/oui.ts → ../../data) and prod (dist/index.js → ../data)
  const candidates = [
    resolve(import.meta.dirname, "../../../data"),
    resolve(import.meta.dirname, "../data"),
    resolve(import.meta.dirname, "../../data"),
    resolve(process.cwd(), "data"),
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "oui24.csv"))) return dir;
  }
  return candidates[0];
}

function parseOuiCsv(csv: string, prefixLen: 6 | 9): Map<string, string> {
  const map = new Map<string, string>();
  const lines = csv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstComma = line.indexOf(",");
    if (firstComma < 0) continue;
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(",");
    if (secondComma < 0) continue;
    const assignment = rest.slice(0, secondComma).trim().toUpperCase();
    let orgName = rest.slice(secondComma + 1);
    const nextComma = orgName.indexOf(",");
    if (nextComma >= 0) orgName = orgName.slice(0, nextComma);
    orgName = orgName.replace(/^"|"$/g, "").trim();
    if (assignment.length >= prefixLen && orgName) {
      map.set(assignment.slice(0, prefixLen), orgName);
    }
  }
  return map;
}

export async function loadOuiDatabases(): Promise<void> {
  if (loaded) return;
  const dataDir = findDataDir();
  try {
    const [csv24, csv36] = await Promise.all([
      readFile(resolve(dataDir, "oui24.csv"), "utf-8"),
      readFile(resolve(dataDir, "oui36.csv"), "utf-8"),
    ]);
    const parsed24 = parseOuiCsv(csv24, 6);
    const parsed36 = parseOuiCsv(csv36, 9);
    for (const [k, v] of parsed24) oui24Map.set(k, v);
    for (const [k, v] of parsed36) oui36Map.set(k, v);
    loaded = true;
    console.log(`[oui] Loaded ${oui24Map.size} OUI-24 + ${oui36Map.size} OUI-36 entries`);
  } catch (e) {
    console.warn("[oui] Failed to load OUI databases — vendor lookup disabled:", e);
  }
}

export function normalizeMac(mac: string): string {
  return mac.replace(/[:\-\.]/g, "").toUpperCase();
}

export function lookupVendor(mac: string): string {
  const hex = normalizeMac(mac);
  if (hex.length < 6) return "";
  const vendor36 = oui36Map.get(hex.slice(0, 9));
  if (vendor36) return vendor36;
  return oui24Map.get(hex.slice(0, 6)) ?? "";
}
