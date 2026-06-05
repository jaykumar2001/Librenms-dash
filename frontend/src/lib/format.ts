export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec == null || isNaN(bytesPerSec)) return "—";
  const bits = bytesPerSec * 8;
  if (bits > 1e9) return `${(bits / 1e9).toFixed(1)} Gbps`;
  if (bits > 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits > 1e3) return `${(bits / 1e3).toFixed(1)} Kbps`;
  return `${bits.toFixed(0)} bps`;
}

export function formatRateCompact(bytesPerSec: number): string {
  const bits = bytesPerSec * 8;
  if (bits > 1e9) return `${(bits / 1e9).toFixed(1)}G`;
  if (bits > 1e6) return `${(bits / 1e6).toFixed(1)}M`;
  if (bits > 1e3) return `${(bits / 1e3).toFixed(0)}K`;
  return `${bits.toFixed(0)}b`;
}
