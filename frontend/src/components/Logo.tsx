interface Props {
  size?: number;
  className?: string;
}

export function Logo({ size = 40, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer ring — dark border with subtle green glow */}
      <circle cx="60" cy="60" r="56" stroke="#74b743" strokeWidth="2.5" strokeOpacity="0.35" />
      <circle cx="60" cy="60" r="56" stroke="#74b743" strokeWidth="0.8" strokeOpacity="0.7" />

      {/* Network links — connecting the nodes */}
      <line x1="60" y1="36" x2="36" y2="68" stroke="#74b743" strokeWidth="2" strokeOpacity="0.5" />
      <line x1="60" y1="36" x2="84" y2="68" stroke="#74b743" strokeWidth="2" strokeOpacity="0.5" />
      <line x1="36" y1="68" x2="84" y2="68" stroke="#74b743" strokeWidth="2" strokeOpacity="0.5" />
      <line x1="36" y1="68" x2="44" y2="90" stroke="#38bdf8" strokeWidth="1.5" strokeOpacity="0.4" />
      <line x1="84" y1="68" x2="76" y2="90" stroke="#fbbf24" strokeWidth="1.5" strokeOpacity="0.4" />
      <line x1="60" y1="36" x2="60" y2="20" stroke="#74b743" strokeWidth="1.5" strokeOpacity="0.3" />

      {/* Central hub node — bright green */}
      <circle cx="60" cy="36" r="10" fill="#74b743" fillOpacity="0.15" stroke="#74b743" strokeWidth="2" />
      <circle cx="60" cy="36" r="4" fill="#74b743" />

      {/* Left node */}
      <circle cx="36" cy="68" r="8" fill="#38bdf8" fillOpacity="0.1" stroke="#38bdf8" strokeWidth="1.5" />
      <circle cx="36" cy="68" r="3.5" fill="#38bdf8" />

      {/* Right node */}
      <circle cx="84" cy="68" r="8" fill="#fbbf24" fillOpacity="0.1" stroke="#fbbf24" strokeWidth="1.5" />
      <circle cx="84" cy="68" r="3.5" fill="#fbbf24" />

      {/* Leaf nodes — discovered/edge devices */}
      <circle cx="44" cy="90" r="4" fill="#38bdf8" fillOpacity="0.12" stroke="#38bdf8" strokeWidth="1" />
      <circle cx="44" cy="90" r="2" fill="#38bdf8" fillOpacity="0.7" />

      <circle cx="76" cy="90" r="4" fill="#fbbf24" fillOpacity="0.12" stroke="#fbbf24" strokeWidth="1" />
      <circle cx="76" cy="90" r="2" fill="#fbbf24" fillOpacity="0.7" />

      {/* Top pulse — signal indicator */}
      <circle cx="60" cy="20" r="3" fill="none" stroke="#74b743" strokeWidth="1" strokeOpacity="0.5" />
      <circle cx="60" cy="20" r="1.5" fill="#74b743" fillOpacity="0.6" />

      {/* Dashboard bars at bottom center — the "Dash" element */}
      <rect x="52" y="100" width="4" height="10" rx="1" fill="#74b743" fillOpacity="0.6" />
      <rect x="58" y="96" width="4" height="14" rx="1" fill="#74b743" fillOpacity="0.8" />
      <rect x="64" y="98" width="4" height="12" rx="1" fill="#74b743" fillOpacity="0.7" />
    </svg>
  );
}
