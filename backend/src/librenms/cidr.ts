// Minimal IPv4 CIDR matching, used to recognise overlay/infrastructure address
// ranges that are supplied via configuration rather than hard-coded.

export function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

interface ParsedCidr {
  base: number;
  mask: number;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const [ip, bitsStr] = cidr.trim().split("/");
  const base = ipToInt(ip);
  if (base === null) return null;
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

// Build a predicate that returns true when an IP falls inside any of the given
// CIDR ranges. Invalid CIDR strings are ignored so a typo can't crash the poller.
export function makeCidrMatcher(cidrs: string[]): (ip: string | undefined | null) => boolean {
  const ranges = cidrs.map(parseCidr).filter((c): c is ParsedCidr => c !== null);
  if (ranges.length === 0) return () => false;
  return (ip) => {
    if (!ip) return false;
    const n = ipToInt(ip);
    if (n === null) return false;
    return ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
  };
}

export function computeSubnet(ip: string, prefixLen: number): string | null {
  const n = ipToInt(ip);
  if (n === null) return null;
  if (prefixLen < 0 || prefixLen > 32) return null;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  const base = (n & mask) >>> 0;
  const a = (base >>> 24) & 0xff;
  const b = (base >>> 16) & 0xff;
  const c = (base >>> 8) & 0xff;
  const d = base & 0xff;
  return `${a}.${b}.${c}.${d}/${prefixLen}`;
}
