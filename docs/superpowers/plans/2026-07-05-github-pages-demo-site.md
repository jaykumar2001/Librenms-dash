# GitHub Pages Demo Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public static demo of the Librenms-dash topology UI at `/home/jkumar/Librenms-dash/librenms-dash.github.io`, reusing the real frontend components against a real-but-fully-anonymized topology snapshot, with no backend, no auth wall, and no live network calls.

**Architecture:** Standalone Vite + React + TypeScript + Tailwind app. Presentation components/hooks are copied from `/home/jkumar/Librenms-dash/frontend/src` (most verbatim, a handful with a one-line import-path edit). Backend-dependent hooks (`useTopology`, `useDeviceDetail`, `useSSE`) are replaced with static-data equivalents. A one-time Node/vitest-tested anonymization pipeline (`scripts/anonymize/`) pulls a real snapshot from the currently-running app, remaps every identifying value (IPs, MACs, hostnames, site names/coords, serials) through consistent fake-value tables, scrubs free text, and writes the result to `src/data/*.json`, which the app imports directly (no fetch).

**Tech Stack:** Vite 8, React 18.3, TypeScript 5.7, Tailwind CSS 4 (`@tailwindcss/vite`), d3-force 3, vitest 4 (anonymization pipeline tests only — no runtime test framework needed for the static UI).

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-07-05-github-pages-demo-site-design.md` (in this repo). Every requirement there must be traceable to a task below.
- Target repo root: `/home/jkumar/Librenms-dash/librenms-dash.github.io` (already a git repo, currently empty). All file paths below are relative to that root unless explicitly marked `(source repo)`.
- `(source repo)` paths are relative to `/home/jkumar/Librenms-dash` — read-only reference, never modified by this plan.
- Build output directory: `docs/` (vite `build.outDir`). GitHub Pages will be configured (by the user, outside this plan) to serve `main` branch `/docs`.
- No backend, no `/api/*` calls, no auth screens anywhere in the shipped app.
- The anonymization scripts under `scripts/anonymize/` are dev-time only — never imported by `src/`, never bundled into the production build.
- Running app for the one-time data pull: backend at `http://localhost:3001`, login via `POST /api/auth/login` with `{"username":"admin","password":"spiderman"}` (from `(source repo)/.env`). These credentials go in a gitignored `.env.local` in the demo repo, never committed.

---

## Task 1: Scaffold the Vite project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `.gitignore`
- Create: `src/styles.css` (copy of `(source repo)/frontend/src/styles.css`)
- Create: `src/main.tsx` (placeholder)
- Create: `src/App.tsx` (placeholder)
- Create: `public/favicon.svg`, `public/logo.svg`, `public/logo-maskable.svg`, `public/manifest.webmanifest` (copies)

**Interfaces:**
- Produces: a working `npm run build` pipeline with the `@/*` → `./src/*` alias, so every later task can `import ... from "@/..."`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "librenms-dash-demo",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "d3-force": "^3.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.2.2",
    "@types/d3-force": "^3.0.10",
    "@types/node": "^22.15.0",
    "@types/react": "^18.3.28",
    "@types/react-dom": "^18.3.7",
    "@vitejs/plugin-react-swc": "^4.3.0",
    "dotenv": "^16.5.0",
    "tailwindcss": "^4.2.2",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vite": "^8.0.8",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "docs",
  },
});
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#030712" />
    <title>LibreNMS-Dash — Live Demo</title>
  </head>
  <body class="bg-gray-950 text-gray-100 m-0 overflow-hidden">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
docs/
*.tsbuildinfo
.DS_Store
.env.local
.scratch/
```

Note: `docs/` (the build output) is gitignored during scaffolding so early tasks don't accidentally commit a stale/partial build. Task 9 removes this line before the final build+commit, since GitHub Pages needs `docs/` committed.

- [ ] **Step 6: Copy static assets and styles**

```bash
cp /home/jkumar/Librenms-dash/frontend/public/favicon.svg /home/jkumar/Librenms-dash/librenms-dash.github.io/public/favicon.svg
cp /home/jkumar/Librenms-dash/frontend/public/logo.svg /home/jkumar/Librenms-dash/librenms-dash.github.io/public/logo.svg
cp /home/jkumar/Librenms-dash/frontend/public/logo-maskable.svg /home/jkumar/Librenms-dash/librenms-dash.github.io/public/logo-maskable.svg
cp /home/jkumar/Librenms-dash/frontend/public/manifest.webmanifest /home/jkumar/Librenms-dash/librenms-dash.github.io/public/manifest.webmanifest
cp /home/jkumar/Librenms-dash/frontend/src/styles.css /home/jkumar/Librenms-dash/librenms-dash.github.io/src/styles.css
```

- [ ] **Step 7: Create placeholder `src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Create placeholder `src/App.tsx`**

```tsx
export function App() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-gray-950">
      <p className="text-gray-400 text-sm">Demo scaffold — topology view wired in a later task.</p>
    </div>
  );
}
```

- [ ] **Step 9: Install and verify the build**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npm install
npm run build
```

Expected: `npm run build` completes with no errors, producing `docs/index.html` and bundled assets.

- [ ] **Step 10: Commit**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
git add package.json package-lock.json tsconfig.json vite.config.ts index.html .gitignore src public
git commit -m "Scaffold Vite/React/Tailwind demo app"
```

---

## Task 2: Local types + verbatim presentation components

**Files:**
- Create: `src/types.ts` (copy of `(source repo)/shared/types.ts`)
- Create: `src/components/Copyable.tsx`
- Create: `src/components/Logo.tsx`
- Create: `src/components/HoverableLinkPath.tsx`
- Create: `src/components/OverlayLink.tsx`
- Create: `src/components/LinkTooltip.tsx`
- Create: `src/components/SiteGroup.tsx`
- Create: `src/components/ArpDeviceNode.tsx`
- Create: `src/hooks/useLocalStorage.ts`
- Create: `src/hooks/usePersistedLayout.ts`
- Create: `src/hooks/layout/separation.ts`
- Create: `src/lib/linkGeometry.ts`
- Create: `src/lib/format.ts`

**Interfaces:**
- Consumes: nothing (pure copies, zero logic changes).
- Produces: `src/types.ts` exporting `TopologyResponse`, `DeviceSummary`, `Site`, `SubnetGroup`, `OverlayLink`, `NeighborLink`, `ArpLink`, `ArpDiscoveredDevice`, `Device`, `DeviceOverview`, `DeviceInterface`, `DeviceRoute`, `Port`, `HealthSensor`, `Alert`, `AssetEvent`, `OverlayPortSummary`, `DeviceSummary` — all consumed by Task 3+ via `@/types` instead of `@librenms-dash/shared`.

None of these files import `@librenms-dash/shared` or anything backend-related (verified: no `/api/`, `fetch(`, `graphUrl`, `iconUrl` references in any of them in the source repo), so every file in this task is copied byte-for-byte with no edits.

- [ ] **Step 1: Copy all files verbatim**

```bash
SRC=/home/jkumar/Librenms-dash/frontend/src
DST=/home/jkumar/Librenms-dash/librenms-dash.github.io/src
SHARED=/home/jkumar/Librenms-dash/shared

mkdir -p "$DST/hooks/layout" "$DST/lib"

cp "$SHARED/types.ts" "$DST/types.ts"
cp "$SRC/components/Copyable.tsx" "$DST/components/Copyable.tsx"
cp "$SRC/components/Logo.tsx" "$DST/components/Logo.tsx"
cp "$SRC/components/HoverableLinkPath.tsx" "$DST/components/HoverableLinkPath.tsx"
cp "$SRC/components/OverlayLink.tsx" "$DST/components/OverlayLink.tsx"
cp "$SRC/components/LinkTooltip.tsx" "$DST/components/LinkTooltip.tsx"
cp "$SRC/components/SiteGroup.tsx" "$DST/components/SiteGroup.tsx"
cp "$SRC/components/ArpDeviceNode.tsx" "$DST/components/ArpDeviceNode.tsx"
cp "$SRC/hooks/useLocalStorage.ts" "$DST/hooks/useLocalStorage.ts"
cp "$SRC/hooks/usePersistedLayout.ts" "$DST/hooks/usePersistedLayout.ts"
cp "$SRC/hooks/layout/separation.ts" "$DST/hooks/layout/separation.ts"
cp "$SRC/lib/linkGeometry.ts" "$DST/lib/linkGeometry.ts"
cp "$SRC/lib/format.ts" "$DST/lib/format.ts"
```

- [ ] **Step 2: Verify the build — expected partial failure**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npm run build
```

Correction to this task's original expectation: this will **not** fully succeed yet, and that's fine. Five of the copied files reference two files that Task 3 creates (`@/hooks/useForceLayout` and `./DevicePopover`): `ArpDeviceNode.tsx`, `OverlayLink.tsx`, and `SiteGroup.tsx` import types from `useForceLayout`; `usePersistedLayout.ts` imports from `useForceLayout`; `LinkTooltip.tsx` imports `formatTimestamp` from `DevicePopover`. `tsc -b` type-checks every file under `src/`, so it will report `Cannot find module '@/hooks/useForceLayout'` / `Cannot find module './useForceLayout'` / `Cannot find module './DevicePopover'` for exactly those five files.

Expected: the build fails, and **every** reported error is one of those three "Cannot find module" messages, pointing only at `ArpDeviceNode.tsx`, `OverlayLink.tsx`, `SiteGroup.tsx`, `usePersistedLayout.ts`, or `LinkTooltip.tsx`. If you see any other kind of error, or an error in a different file, stop and fix it — that's a real problem. Otherwise this partial failure is the correct, expected state; proceed to commit. Task 3 adds the missing files and the build will succeed from that point on.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/components src/hooks src/lib
git commit -m "Copy verbatim presentation components and local types"
```

---

## Task 3: Copy and adapt the topology canvas

**Files:**
- Create: `src/hooks/useForceLayout.ts` (copy + import edit)
- Create: `src/components/DeviceNode.tsx` (copy + import edit + icon path edit)
- Create: `src/components/AssetEventToast.tsx` (copy + import edit)
- Create: `src/components/TopologyMap.tsx` (copy + import edit)
- Modify: `src/App.tsx` (temporary smoke-test wiring, replaced fully in Task 9)

**Interfaces:**
- Consumes: `@/types` (Task 2), `usePersistedLayout`/`useLocalStorage`/`linkGeometry`/`SiteGroup`/`OverlayLink`/`HoverableLinkPath`/`ArpDeviceNode`/`Logo`/`Copyable` (Task 2).
- Produces: `TopologyMap({ data: TopologyResponse, sse: { allEvents: AssetEvent[]; connected: boolean } })` — the exact prop shape Task 9's final `App.tsx` renders. `DeviceNode` reads icons from `/icons/<filename>` (bundled in Task 6), not `/api/graph/icon/<filename>`.

These four files are otherwise identical to the source repo. `DevicePopover` is deliberately excluded here — it's rewritten in Task 7.

- [ ] **Step 1: Copy the four files**

```bash
SRC=/home/jkumar/Librenms-dash/frontend/src
DST=/home/jkumar/Librenms-dash/librenms-dash.github.io/src

cp "$SRC/hooks/useForceLayout.ts" "$DST/hooks/useForceLayout.ts"
cp "$SRC/components/DeviceNode.tsx" "$DST/components/DeviceNode.tsx"
cp "$SRC/components/AssetEventToast.tsx" "$DST/components/AssetEventToast.tsx"
cp "$SRC/components/TopologyMap.tsx" "$DST/components/TopologyMap.tsx"
```

- [ ] **Step 2: Fix the shared-types import in each copied file**

In `src/hooks/useForceLayout.ts`:

Old: `import type { TopologyResponse, DeviceSummary, ArpDiscoveredDevice } from "@librenms-dash/shared";`
New: `import type { TopologyResponse, DeviceSummary, ArpDiscoveredDevice } from "@/types";`

In `src/components/DeviceNode.tsx`:

Old: `import type { DeviceSummary } from "@librenms-dash/shared";`
New: `import type { DeviceSummary } from "@/types";`

In `src/components/AssetEventToast.tsx`:

Old: `import type { AssetEvent } from "@librenms-dash/shared";`
New: `import type { AssetEvent } from "@/types";`

In `src/components/TopologyMap.tsx`:

Old: `import type { TopologyResponse, DeviceSummary, AssetEvent } from "@librenms-dash/shared";`
New: `import type { TopologyResponse, DeviceSummary, AssetEvent } from "@/types";`

Also note: `TopologyMap.tsx` imports `DevicePopover` from `"./DevicePopover"` — that file doesn't exist until Task 7. Leave the import as-is; Task 7 creates it. The build in Step 4 below will fail until then, which is expected — see Step 4.

- [ ] **Step 3: Fix the icon path in `DeviceNode.tsx`**

Old:
```tsx
      <image
        href={`/api/graph/icon/${device?.icon ?? "generic.svg"}`}
        x={x + 6}
        y={y + 6}
        width={ICON_SIZE}
        height={ICON_SIZE}
      />
```
New:
```tsx
      <image
        href={`/icons/${device?.icon ?? "generic.svg"}`}
        x={x + 6}
        y={y + 6}
        width={ICON_SIZE}
        height={ICON_SIZE}
      />
```

- [ ] **Step 4: Create a temporary stub `DevicePopover` so the build passes**

This file is fully replaced in Task 7. It exists here only so Task 3's build/visual check doesn't depend on Task 7 being done first.

Create `src/components/DevicePopover.tsx`. Note: this stub must also export `formatTimestamp`, copied verbatim from `(source repo)/frontend/src/components/DevicePopover.tsx` — `LinkTooltip.tsx` (copied in Task 2) imports it from `./DevicePopover`, so the build won't pass without it:

```tsx
interface Props {
  hostname: string;
  icon: string;
  screenX: number;
  screenY: number;
  bottomSheet?: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClose?: () => void;
}

export function formatTimestamp(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts.replace(" ", "T"));
  if (isNaN(d.getTime())) return ts;
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return d.toLocaleString();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return d.toLocaleString();
}

export function DevicePopover(_props: Props) {
  return null;
}
```

- [ ] **Step 5: Temporarily wire `TopologyMap` into `App.tsx` with empty data**

```tsx
import type { TopologyResponse } from "@/types";
import { TopologyMap } from "@/components/TopologyMap";

const emptyData: TopologyResponse = {
  sites: [],
  overlays: [],
  neighbors: [],
  arpLinks: [],
  arpDevices: [],
  alerts: [],
  lastUpdated: new Date().toISOString(),
};

export function App() {
  return <TopologyMap data={emptyData} sse={{ allEvents: [], connected: false }} />;
}
```

- [ ] **Step 6: Build and smoke-test in the browser**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npm run build
npm run dev
```

Open `http://localhost:5173` — expected: an empty dark canvas with the logo/controls overlay, no console errors, no 404s other than icon requests (icons aren't bundled until Task 6 — that's expected and fine since `emptyData` has no devices to render icons for).

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useForceLayout.ts src/components/DeviceNode.tsx src/components/AssetEventToast.tsx src/components/TopologyMap.tsx src/components/DevicePopover.tsx src/App.tsx
git commit -m "Copy and wire topology canvas with stub popover"
```

---

## Task 4: Anonymization engine (IP/MAC remapping + free-text scrub)

**Files:**
- Create: `scripts/anonymize/engine.ts`
- Create: `scripts/anonymize/engine.test.ts`

**Interfaces:**
- Produces: `createAnonymizer()` returning an `AnonymizeEngine` with:
  - `ip(real: string): string` — subnet-grouping-preserving fake IPv4/IPv6.
  - `mac(real: string): string` — locally-administered fake MAC, same separator format as input.
  - `registerScrubEntry(real: string, fake: string): void` — records an extra real→fake pair (used by Task 5 for hostnames/site names) for the scrub pass.
  - `scrub(text: string): string` — replaces every known real substring (from `ip`/`mac`/`registerScrubEntry` calls so far) with its fake counterpart.
- Consumed by: `scripts/anonymize/transform.ts` (Task 5).

This is pure logic with no I/O — fully unit-testable, no real data involved.

- [ ] **Step 1: Write the failing tests**

Create `scripts/anonymize/engine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createAnonymizer } from "./engine";

describe("ip()", () => {
  it("returns a different value than the input", () => {
    const eng = createAnonymizer();
    expect(eng.ip("10.5.26.1")).not.toBe("10.5.26.1");
  });

  it("is stable for the same input", () => {
    const eng = createAnonymizer();
    const a = eng.ip("10.5.26.1");
    const b = eng.ip("10.5.26.1");
    expect(a).toBe(b);
  });

  it("preserves /24 grouping for IPv4", () => {
    const eng = createAnonymizer();
    const a = eng.ip("192.168.0.101");
    const b = eng.ip("192.168.0.105");
    const c = eng.ip("192.168.1.50");
    const bucket = (ip: string) => ip.split(".").slice(0, 3).join(".");
    expect(bucket(a)).toBe(bucket(b));
    expect(bucket(a)).not.toBe(bucket(c));
  });

  it("preserves prefix grouping for IPv6", () => {
    const eng = createAnonymizer();
    const a = eng.ip("2406:7400:121:396:4af1:7fff:fe43:c358");
    const b = eng.ip("2406:7400:121:396:8446:a2ff:febc:d35e");
    const c = eng.ip("fd42:2e96:a0ef:cb72::1");
    const bucket = (ip: string) => ip.split(":").slice(0, 4).join(":");
    expect(bucket(a)).toBe(bucket(b));
    expect(bucket(a)).not.toBe(bucket(c));
  });

  it("leaves loopback addresses untouched", () => {
    const eng = createAnonymizer();
    expect(eng.ip("127.0.0.1")).toBe("127.0.0.1");
    expect(eng.ip("::1")).toBe("::1");
  });
});

describe("mac()", () => {
  it("returns a locally-administered, unicast address", () => {
    const eng = createAnonymizer();
    const fake = eng.mac("8C1645FA1500");
    const firstByte = parseInt(fake.slice(0, 2), 16);
    expect(firstByte & 0x02).toBe(0x02); // locally administered bit set
    expect(firstByte & 0x01).toBe(0); // unicast bit clear
  });

  it("preserves colonless-uppercase format", () => {
    const eng = createAnonymizer();
    const fake = eng.mac("8C1645FA1500");
    expect(fake).toMatch(/^[0-9A-F]{12}$/);
  });

  it("preserves colon-lowercase format", () => {
    const eng = createAnonymizer();
    const fake = eng.mac("8c:16:45:fa:15:00");
    expect(fake).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  });

  it("maps the same real MAC to the same fake bytes regardless of format", () => {
    const eng = createAnonymizer();
    const colonless = eng.mac("8C1645FA1500");
    const colon = eng.mac("8c:16:45:fa:15:00");
    expect(colon.replace(/:/g, "").toLowerCase()).toBe(colonless.toLowerCase());
  });
});

describe("scrub()", () => {
  it("replaces every registered real value with its fake counterpart", () => {
    const eng = createAnonymizer();
    const fakeIp = eng.ip("10.5.26.1");
    eng.registerScrubEntry("blr01", "core-sw-01.demo.lan");
    const text = "Interface uplink to blr01 (10.5.26.1) is up";
    const scrubbed = eng.scrub(text);
    expect(scrubbed).not.toContain("blr01");
    expect(scrubbed).not.toContain("10.5.26.1");
    expect(scrubbed).toContain("core-sw-01.demo.lan");
    expect(scrubbed).toContain(fakeIp);
  });

  it("prefers the longest match so substrings don't clobber each other", () => {
    const eng = createAnonymizer();
    eng.registerScrubEntry("blr", "hq");
    eng.registerScrubEntry("blr01", "core-sw-01.demo.lan");
    expect(eng.scrub("blr01")).toBe("core-sw-01.demo.lan");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npx vitest run scripts/anonymize/engine.test.ts
```

Expected: FAIL — `Cannot find module './engine'`.

- [ ] **Step 3: Implement `scripts/anonymize/engine.ts`**

```ts
export interface AnonymizeEngine {
  ip(real: string): string;
  mac(real: string): string;
  registerScrubEntry(real: string, fake: string): void;
  scrub(text: string): string;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SKIP_IPS = new Set(["127.0.0.1", "::1", "0.0.0.0", ""]);
const FAKE_V4_BASE_THIRD_OCTET = 200; // 10.200.0.0 .. 10.219.255.0 — 5,120 distinct /24s
const V6_FAKE_PREFIX = "2001:db8";

function isIPv4(s: string): boolean {
  return IPV4_RE.test(s);
}

function isIPv6(s: string): boolean {
  return s.includes(":") && !IPV4_RE.test(s);
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function macFormatLike(hexColonless6: string, real: string): string {
  const isColon = real.includes(":");
  const isDash = real.includes("-");
  if (!isColon && !isDash) {
    return real === real.toLowerCase() ? hexColonless6.toLowerCase() : hexColonless6.toUpperCase();
  }
  const sep = isDash ? "-" : ":";
  const pairs = hexColonless6.match(/.{2}/g)!.join(sep);
  return real === real.toLowerCase() ? pairs.toLowerCase() : pairs.toUpperCase();
}

export function createAnonymizer(): AnonymizeEngine {
  const ipMap = new Map<string, string>();
  const v4BucketFake = new Map<string, string>(); // real "a.b.c" -> fake "10.X.Y"
  const v4UsedHosts = new Map<string, Set<number>>(); // fake prefix -> used last-octet values
  const v6BucketFake = new Map<string, string>(); // real "a:b:c:d" -> fake "2001:db8:N"
  let v4BucketCount = 0;
  let v6BucketCount = 0;

  const macMap = new Map<string, string>(); // normalized (lowercase, no separators) real -> fake hex6

  const scrubEntries: [string, string][] = [];

  function nextFakeV4Prefix(): string {
    const n = v4BucketCount++;
    const third = FAKE_V4_BASE_THIRD_OCTET + Math.floor(n / 256);
    const second = n % 256;
    return `10.${third}.${second}`;
  }

  function ip(real: string): string {
    if (SKIP_IPS.has(real)) return real;
    const cached = ipMap.get(real);
    if (cached) return cached;

    let fake: string;
    if (isIPv4(real)) {
      const octets = real.split(".");
      const realBucket = octets.slice(0, 3).join(".");
      let fakePrefix = v4BucketFake.get(realBucket);
      if (!fakePrefix) {
        fakePrefix = nextFakeV4Prefix();
        v4BucketFake.set(realBucket, fakePrefix);
        v4UsedHosts.set(fakePrefix, new Set());
      }
      const used = v4UsedHosts.get(fakePrefix)!;
      let host = 2 + (fnv1a(real) % 250);
      while (used.has(host)) host = 2 + ((host + 1) % 250);
      used.add(host);
      fake = `${fakePrefix}.${host}`;
    } else if (isIPv6(real)) {
      const realBucket = real.split(":").slice(0, 4).join(":");
      let fakePrefix = v6BucketFake.get(realBucket);
      if (!fakePrefix) {
        fakePrefix = `${V6_FAKE_PREFIX}:${v6BucketCount++}`;
        v6BucketFake.set(realBucket, fakePrefix);
      }
      const h1 = fnv1a(real).toString(16).padStart(8, "0");
      const h2 = fnv1a(`${real}:salt`).toString(16).padStart(8, "0");
      fake = `${fakePrefix}::${h1.slice(0, 4)}:${h2.slice(0, 4)}`;
    } else {
      return real; // not IP-shaped — leave untouched
    }

    ipMap.set(real, fake);
    scrubEntries.push([real, fake]);
    return fake;
  }

  function mac(real: string): string {
    const key = real.toLowerCase().replace(/[:\-]/g, "");
    if (key.length !== 12) return real; // not MAC-shaped — leave untouched
    let hex6 = macMap.get(key);
    if (!hex6) {
      const h1 = fnv1a(key);
      const h2 = fnv1a(`${key}:salt`);
      const bytes = [
        0x02, // locally administered, unicast
        (h1 >>> 24) & 0xff,
        (h1 >>> 16) & 0xff,
        (h1 >>> 8) & 0xff,
        h1 & 0xff,
        h2 & 0xff,
      ];
      hex6 = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      macMap.set(key, hex6);
    }
    const fake = macFormatLike(hex6, real);
    scrubEntries.push([real, fake]);
    return fake;
  }

  function registerScrubEntry(real: string, fake: string): void {
    if (!real || real === fake) return;
    scrubEntries.push([real, fake]);
  }

  function scrub(text: string): string {
    if (!text) return text;
    let out = text;
    const sorted = [...scrubEntries].sort((a, b) => b[0].length - a[0].length);
    for (const [real, fake] of sorted) {
      if (!real || !out.includes(real)) continue;
      out = out.split(real).join(fake);
    }
    return out;
  }

  return { ip, mac, registerScrubEntry, scrub };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run scripts/anonymize/engine.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/anonymize/engine.ts scripts/anonymize/engine.test.ts
git commit -m "Add anonymization engine (IP/MAC remap + free-text scrub)"
```

---

## Task 5: Role/site naming + structural transform

**Files:**
- Create: `scripts/anonymize/roleNames.ts`
- Create: `scripts/anonymize/transform.ts`
- Create: `scripts/anonymize/transform.test.ts`

**Interfaces:**
- Consumes: `createAnonymizer` from `scripts/anonymize/engine.ts` (Task 4); `TopologyResponse`/`DeviceOverview`/etc from `src/types.ts` (Task 2).
- Produces: `anonymizeTopology(raw: TopologyResponse, rawOverviews: Record<string, DeviceOverview>): { topology: TopologyResponse; overviews: Record<string, DeviceOverview> }`, consumed by `scripts/anonymize/run.ts` (Task 6). The returned `overviews` map is keyed by each device's **fake** hostname.

- [ ] **Step 1: Create `scripts/anonymize/roleNames.ts`**

```ts
// Icon filenames observed in the running app's device inventory map to a
// short role token used to build realistic fake hostnames. `device` is the
// fallback for any icon not in this table.
const ROLE_BY_ICON: Record<string, string> = {
  "cisco.svg": "sw",
  "opnsense.svg": "fw",
  "pfsense.svg": "fw",
  "synology.svg": "nas",
  "tplink.svg": "ap",
  "linksys.png": "ap",
  "proxmox.svg": "hv",
  "ubuntu.svg": "srv",
  "debian.svg": "srv",
  "arch.svg": "srv",
  "raspbian.svg": "srv",
  "openwrt.svg": "rtr",
  "brother.svg": "printer",
};

export function roleFromIcon(icon: string): string {
  return ROLE_BY_ICON[icon] ?? "device";
}

export const SITE_NAME_POOL = [
  "HQ",
  "Branch-East",
  "Branch-West",
  "Datacenter-1",
  "Datacenter-2",
  "Branch-North",
  "Branch-South",
  "Datacenter-3",
];

export function siteIdFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
```

- [ ] **Step 2: Write the failing test for `transform.ts`**

Create `scripts/anonymize/transform.test.ts` using a small hand-built fixture (not real data):

```ts
import { describe, it, expect } from "vitest";
import { anonymizeTopology } from "./transform";
import type { TopologyResponse, DeviceOverview } from "../../src/types";

function fixture(): { topology: TopologyResponse; overviews: Record<string, DeviceOverview> } {
  const topology: TopologyResponse = {
    sites: [
      {
        id: "blr-r",
        location: "BLR-R",
        lat: 12.2,
        lng: 77.3,
        devices: [
          {
            device_id: 1,
            hostname: "100.81.0.100",
            displayName: "blr01",
            ip: "100.81.0.100",
            lanIp: "10.5.26.1",
            ips: ["10.5.26.1"],
            allIps: ["10.5.26.1", "127.0.0.1"],
            macs: ["8C1645FA1500"],
            os: "linux",
            icon: "cisco.svg",
            status: 1,
            uptime: 100,
            location: "BLR-R",
            hardware: "Cisco Test Router mentions blr01 internally",
            sysName: "blr01",
            totalInRate: 0,
            totalOutRate: 0,
            portCount: 1,
            overlayPorts: [],
          },
        ],
      },
    ],
    overlays: [],
    neighbors: [],
    arpLinks: [],
    arpDevices: [
      {
        mac: "C6485D293A2F",
        macs: ["C6485D293A2F"],
        ips: ["192.168.0.101"],
        vendor: "",
        location: "BLR-R",
        siteId: "blr-r",
        seenByHostname: "100.81.0.100",
        seenByIp: "192.168.0.115",
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-01T00:00:00.000Z",
        stale: false,
        sourceDown: false,
      },
    ],
    alerts: [],
    lastUpdated: "2026-01-01T00:00:00.000Z",
  };

  const overviews: Record<string, DeviceOverview> = {
    "100.81.0.100": {
      device: {
        device_id: 1,
        hostname: "100.81.0.100",
        displayName: "blr01",
        ip: "100.81.0.100",
        ips: ["10.5.26.1"],
        os: "linux",
        version: "1.0",
        icon: "cisco.svg",
        status: 1,
        status_reason: "",
        location: "BLR-R",
        uptime: 100,
        sysName: "blr01",
        hardware: "Cisco Test Router",
        features: "",
        serial: "REAL-SERIAL-123",
        sysContact: "admin@realcompany.example",
        sysDescr: "Cisco IOS running on blr01",
        last_discovered: "2026-01-01T00:00:00.000Z",
        last_polled: "2026-01-01T00:00:00.000Z",
      },
      health: [],
      topPorts: [],
      routes: [],
      alerts: [],
      interfaces: [],
    },
  };

  return { topology, overviews };
}

describe("anonymizeTopology", () => {
  it("gives the device a fake hostname/displayName and drops geo coordinates", () => {
    const { topology } = anonymizeTopology(fixture().topology, fixture().overviews);
    const device = topology.sites[0].devices[0];
    expect(device.hostname).not.toBe("100.81.0.100");
    expect(device.displayName).not.toBe("blr01");
    expect(device.hostname).toBe(device.displayName); // unified fake identity
    expect(topology.sites[0].lat).toBeNull();
    expect(topology.sites[0].lng).toBeNull();
  });

  it("keeps the discovered device's seenByHostname consistent with the managed device's fake hostname", () => {
    const { topology } = anonymizeTopology(fixture().topology, fixture().overviews);
    const device = topology.sites[0].devices[0];
    const arpDevice = topology.arpDevices[0];
    expect(arpDevice.seenByHostname).toBe(device.hostname);
  });

  it("replaces the real serial and empties sysContact in the overview", () => {
    const { overviews } = anonymizeTopology(fixture().topology, fixture().overviews);
    const anon = Object.values(overviews)[0];
    expect(anon.device.serial).not.toContain("REAL-SERIAL-123");
    expect(anon.device.sysContact).toBe("");
  });

  it("scrubs the real hostname out of free-text fields", () => {
    const { topology, overviews } = anonymizeTopology(fixture().topology, fixture().overviews);
    const device = topology.sites[0].devices[0];
    expect(device.hardware).not.toContain("blr01");
    const anon = Object.values(overviews)[0];
    expect(anon.device.sysDescr).not.toContain("blr01");
    expect(anon.device.sysDescr).toContain(device.hostname);
  });

  it("keys the overviews map by the fake hostname", () => {
    const { topology, overviews } = anonymizeTopology(fixture().topology, fixture().overviews);
    const device = topology.sites[0].devices[0];
    expect(overviews[device.hostname]).toBeDefined();
    expect(overviews["100.81.0.100"]).toBeUndefined();
  });

  it("leaves loopback addresses in allIps untouched but remaps real LAN IPs", () => {
    const { topology } = anonymizeTopology(fixture().topology, fixture().overviews);
    const device = topology.sites[0].devices[0];
    expect(device.allIps).toContain("127.0.0.1");
    expect(device.allIps).not.toContain("10.5.26.1");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run scripts/anonymize/transform.test.ts
```

Expected: FAIL — `Cannot find module './transform'`.

- [ ] **Step 4: Implement `scripts/anonymize/transform.ts`**

```ts
import type {
  TopologyResponse,
  DeviceOverview,
  Site,
  DeviceSummary,
  ArpDiscoveredDevice,
  OverlayLink as OverlayLinkT,
  SubnetGroup,
  NeighborLink,
  ArpLink,
  Alert,
  DeviceRoute,
  DeviceInterface,
} from "../../src/types";
import { createAnonymizer } from "./engine";
import { roleFromIcon, siteIdFromName, SITE_NAME_POOL } from "./roleNames";

export interface AnonymizeResult {
  topology: TopologyResponse;
  overviews: Record<string, DeviceOverview>;
}

function splitCidr(cidr: string): [string, string] {
  const [addr, prefix] = cidr.split("/");
  return [addr, prefix ?? "32"];
}

export function anonymizeTopology(
  raw: TopologyResponse,
  rawOverviews: Record<string, DeviceOverview>,
): AnonymizeResult {
  const eng = createAnonymizer();
  const hostnameMap = new Map<string, string>();
  const displayNameMap = new Map<string, string>();
  const siteIdMap = new Map<string, string>();
  const siteLocationMap = new Map<string, string>();
  const roleCounters: Record<string, number> = {};

  // Pass 1: one fake identity per managed device, keyed by both the real
  // hostname (an opaque join key everywhere else in the payload) and the
  // real displayName, so any field carrying either value resolves the same.
  for (const site of raw.sites) {
    for (const d of site.devices) {
      const role = roleFromIcon(d.icon);
      roleCounters[role] = (roleCounters[role] ?? 0) + 1;
      const fakeName = `${role}-${String(roleCounters[role]).padStart(2, "0")}.demo.lan`;
      hostnameMap.set(d.hostname, fakeName);
      displayNameMap.set(d.displayName, fakeName);
      eng.registerScrubEntry(d.hostname, fakeName);
      eng.registerScrubEntry(d.displayName, fakeName);
      if (d.sysName) eng.registerScrubEntry(d.sysName, fakeName);
    }
  }

  // Pass 2: fake site identities, assigned in the order sites appear.
  raw.sites.forEach((s, i) => {
    const fakeLocation = SITE_NAME_POOL[i] ?? `Site-${i + 1}`;
    const fakeId = siteIdFromName(fakeLocation);
    siteIdMap.set(s.id, fakeId);
    siteLocationMap.set(s.location, fakeLocation);
    eng.registerScrubEntry(s.id, fakeId);
    eng.registerScrubEntry(s.location, fakeLocation);
  });

  const fakeHostname = (h: string) => hostnameMap.get(h) ?? h;
  const fakeDisplay = (n: string) => displayNameMap.get(n) ?? n;
  const fakeSiteId = (id: string) => siteIdMap.get(id) ?? id;
  const fakeLocation = (loc: string) => siteLocationMap.get(loc) ?? loc;

  function anonRoute(r: DeviceRoute): DeviceRoute {
    return {
      dest: eng.ip(r.dest),
      prefix: r.prefix,
      nextHop: eng.ip(r.nextHop),
      nextHopDevice: r.nextHopDevice ? fakeDisplay(r.nextHopDevice) : r.nextHopDevice,
      iface: r.iface,
      protocol: r.protocol,
      type: r.type,
    };
  }

  function anonDeviceSummary(d: DeviceSummary): DeviceSummary {
    return {
      device_id: d.device_id,
      hostname: fakeHostname(d.hostname),
      displayName: fakeDisplay(d.displayName),
      ip: eng.ip(d.ip),
      lanIp: eng.ip(d.lanIp),
      ips: d.ips.map((x) => eng.ip(x)),
      allIps: d.allIps.map((x) => eng.ip(x)),
      macs: d.macs.map((x) => eng.mac(x)),
      os: d.os,
      icon: d.icon,
      status: d.status,
      uptime: d.uptime,
      location: fakeLocation(d.location),
      hardware: eng.scrub(d.hardware),
      sysName: fakeDisplay(d.sysName),
      totalInRate: d.totalInRate,
      totalOutRate: d.totalOutRate,
      portCount: d.portCount,
      overlayPorts: d.overlayPorts.map((p) => ({ ...p, ip: eng.ip(p.ip) })),
      routes: d.routes?.map(anonRoute),
    };
  }

  function anonSite(s: Site): Site {
    return {
      id: fakeSiteId(s.id),
      location: fakeLocation(s.location),
      lat: null,
      lng: null,
      devices: s.devices.map(anonDeviceSummary),
    };
  }

  function anonOverlayLink(l: OverlayLinkT): OverlayLinkT {
    const [addr, prefix] = splitCidr(l.subnet);
    return {
      overlayType: l.overlayType,
      subnet: `${eng.ip(addr)}/${prefix}`,
      from: fakeHostname(l.from),
      to: fakeHostname(l.to),
      fromIp: eng.ip(l.fromIp),
      toIp: eng.ip(l.toIp),
      fromIface: l.fromIface,
      toIface: l.toIface,
    };
  }

  function anonSubnetGroup(g: SubnetGroup): SubnetGroup {
    const [addr, prefix] = splitCidr(g.subnet);
    return {
      overlayType: g.overlayType,
      subnet: `${eng.ip(addr)}/${prefix}`,
      color: g.color,
      label: eng.scrub(g.label),
      topology: g.topology,
      hub: g.hub ? fakeHostname(g.hub) : g.hub,
      links: g.links.map(anonOverlayLink),
    };
  }

  function anonNeighbor(n: NeighborLink): NeighborLink {
    return {
      id: n.id,
      localDeviceId: n.localDeviceId,
      localHostname: fakeHostname(n.localHostname),
      localPort: n.localPort,
      remoteDeviceId: n.remoteDeviceId,
      remoteHostname: fakeHostname(n.remoteHostname),
      remotePort: n.remotePort,
      protocol: n.protocol,
    };
  }

  function anonArpLink(l: ArpLink): ArpLink {
    return {
      fromHostname: fakeHostname(l.fromHostname),
      toHostname: fakeHostname(l.toHostname),
      fromIp: eng.ip(l.fromIp),
      toIp: eng.ip(l.toIp),
      mac: eng.mac(l.mac),
      fromInterface: l.fromInterface,
      fromMac: l.fromMac ? eng.mac(l.fromMac) : l.fromMac,
      toInterface: l.toInterface,
      toMac: l.toMac ? eng.mac(l.toMac) : l.toMac,
      sourceDown: l.sourceDown,
    };
  }

  function anonArpDevice(d: ArpDiscoveredDevice): ArpDiscoveredDevice {
    return {
      mac: eng.mac(d.mac),
      macs: d.macs.map((x) => eng.mac(x)),
      ips: d.ips.map((x) => eng.ip(x)),
      vendor: d.vendor,
      location: fakeLocation(d.location),
      siteId: fakeSiteId(d.siteId),
      seenByHostname: fakeHostname(d.seenByHostname),
      seenByInterface: d.seenByInterface,
      seenByIp: d.seenByIp ? eng.ip(d.seenByIp) : d.seenByIp,
      seenByMac: d.seenByMac ? eng.mac(d.seenByMac) : d.seenByMac,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      stale: d.stale,
      sourceDown: d.sourceDown,
    };
  }

  function anonAlert(a: Alert): Alert {
    return {
      id: a.id,
      device_id: a.device_id,
      hostname: fakeHostname(a.hostname),
      rule: eng.scrub(a.rule),
      severity: a.severity,
      state: a.state,
      timestamp: a.timestamp,
    };
  }

  function anonInterface(iface: DeviceInterface): DeviceInterface {
    return {
      ifName: iface.ifName,
      mac: eng.mac(iface.mac),
      vendor: iface.vendor,
      ifOperStatus: iface.ifOperStatus,
      ips: iface.ips.map((x) => eng.ip(x)),
    };
  }

  const topology: TopologyResponse = {
    sites: raw.sites.map(anonSite),
    overlays: raw.overlays.map(anonSubnetGroup),
    neighbors: raw.neighbors.map(anonNeighbor),
    arpLinks: raw.arpLinks.map(anonArpLink),
    arpDevices: raw.arpDevices.map(anonArpDevice),
    alerts: raw.alerts.map(anonAlert),
    lastUpdated: "2026-01-01T00:00:00.000Z",
  };

  const overviews: Record<string, DeviceOverview> = {};
  for (const [realHostname, ov] of Object.entries(rawOverviews)) {
    const fakeKey = fakeHostname(realHostname);
    overviews[fakeKey] = {
      device: {
        device_id: ov.device.device_id,
        hostname: fakeHostname(ov.device.hostname),
        displayName: fakeDisplay(ov.device.displayName),
        ip: eng.ip(ov.device.ip),
        ips: ov.device.ips.map((x) => eng.ip(x)),
        os: ov.device.os,
        version: ov.device.version,
        icon: ov.device.icon,
        status: ov.device.status,
        status_reason: eng.scrub(ov.device.status_reason),
        location: fakeLocation(ov.device.location),
        uptime: ov.device.uptime,
        sysName: fakeDisplay(ov.device.sysName),
        hardware: eng.scrub(ov.device.hardware),
        features: eng.scrub(ov.device.features),
        serial: ov.device.serial ? "DEMO-00000000" : "",
        sysContact: "",
        sysDescr: eng.scrub(ov.device.sysDescr),
        last_discovered: ov.device.last_discovered,
        last_polled: ov.device.last_polled,
        overlayIps: ov.device.overlayIps?.map((o) => ({ type: o.type, ip: eng.ip(o.ip) })),
      },
      health: ov.health.map((h) => ({ ...h, sensor_descr: eng.scrub(h.sensor_descr) })),
      topPorts: ov.topPorts.map((p) => ({ ...p, ifAlias: eng.scrub(p.ifAlias) })),
      routes: ov.routes.map(anonRoute),
      alerts: ov.alerts.map(anonAlert),
      interfaces: ov.interfaces.map(anonInterface),
    };
  }

  return { topology, overviews };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run scripts/anonymize/transform.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/anonymize/roleNames.ts scripts/anonymize/transform.ts scripts/anonymize/transform.test.ts
git commit -m "Add structural anonymization transform for topology + device overviews"
```

---

## Task 6: Pull the real snapshot, anonymize it, and commit the static data + icons

**Files:**
- Create: `scripts/anonymize/run.ts`
- Create: `.env.local.example`
- Create (gitignored, never committed): `.env.local`
- Modify: `package.json` (add `anonymize` script)
- Create (generated, committed): `src/data/topology.json`
- Create (generated, committed): `src/data/deviceOverviews.json`
- Create (generated, committed): `public/icons/*.svg`, `public/icons/*.png`

**Interfaces:**
- Consumes: `anonymizeTopology` from `scripts/anonymize/transform.ts` (Task 5).
- Produces: `src/data/topology.json` (shape: `TopologyResponse`) and `src/data/deviceOverviews.json` (shape: `Record<string, DeviceOverview>`, keyed by fake hostname) — both consumed directly by `src/App.tsx` and `src/hooks/useDeviceDetail.ts` in Task 7.

This task requires the app in `/home/jkumar/Librenms-dash` to be running (`docker compose ps` shows the `librenms-dash` container up). If it isn't, start it first with `docker-compose up -d` in that repo.

- [ ] **Step 1: Create `scripts/anonymize/run.ts`**

```ts
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { anonymizeTopology } from "./transform";
import type { TopologyResponse, DeviceOverview } from "../../src/types";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

if (!AUTH_USERNAME || !AUTH_PASSWORD) {
  console.error("Missing AUTH_USERNAME/AUTH_PASSWORD — copy .env.local.example to .env.local and fill it in.");
  process.exit(1);
}

async function login(): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: AUTH_USERNAME, password: AUTH_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie returned");
  return setCookie.split(";")[0];
}

async function fetchJson<T>(pathname: string, cookie: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${pathname}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`GET ${pathname}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchBinary(pathname: string, cookie: string): Promise<Buffer> {
  const res = await fetch(`${BACKEND_URL}${pathname}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`GET ${pathname}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const cookie = await login();
  console.log("Logged in.");

  const topology = await fetchJson<TopologyResponse>("/api/topology", cookie);
  const deviceCount = topology.sites.reduce((n, s) => n + s.devices.length, 0);
  console.log(`Fetched topology: ${topology.sites.length} sites, ${deviceCount} devices.`);

  const rawOverviews: Record<string, DeviceOverview> = {};
  const icons = new Set<string>();
  for (const site of topology.sites) {
    for (const device of site.devices) {
      icons.add(device.icon || "generic.svg");
      rawOverviews[device.hostname] = await fetchJson<DeviceOverview>(
        `/api/devices/${encodeURIComponent(device.hostname)}/overview`,
        cookie,
      );
      console.log(`Fetched overview for ${device.displayName}`);
    }
  }

  const { topology: anonTopology, overviews: anonOverviews } = anonymizeTopology(topology, rawOverviews);

  const dataDir = path.resolve("src/data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "topology.json"), JSON.stringify(anonTopology, null, 2));
  writeFileSync(path.join(dataDir, "deviceOverviews.json"), JSON.stringify(anonOverviews, null, 2));
  console.log(`Wrote ${dataDir}/topology.json and deviceOverviews.json`);

  const iconsDir = path.resolve("public/icons");
  mkdirSync(iconsDir, { recursive: true });
  for (const icon of icons) {
    const buf = await fetchBinary(`/api/graph/icon/${encodeURIComponent(icon)}`, cookie);
    writeFileSync(path.join(iconsDir, icon), buf);
    console.log(`Downloaded icon ${icon}`);
  }

  // Audit: confirm none of the real site/hostname/displayName strings survived
  // the anonymization pass anywhere in the output (structural fields + free text).
  const combined = JSON.stringify({ anonTopology, anonOverviews });
  const realNeedles = new Set<string>();
  for (const s of topology.sites) {
    realNeedles.add(s.location);
    realNeedles.add(s.id);
    for (const d of s.devices) {
      realNeedles.add(d.displayName);
      realNeedles.add(d.hostname);
    }
  }
  const leaks = [...realNeedles].filter((needle) => needle && needle.length > 2 && combined.includes(needle));
  if (leaks.length > 0) {
    console.error("AUDIT FAILED — real identifiers still present in output:", leaks);
    process.exit(1);
  }
  console.log("Audit passed — no real site/hostname/displayName strings found in anonymized output.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Create `.env.local.example` (committed — documents required vars, no secrets)**

```
BACKEND_URL=http://localhost:3001
AUTH_USERNAME=
AUTH_PASSWORD=
```

- [ ] **Step 3: Create the real `.env.local` (gitignored, never committed)**

```bash
cat > /home/jkumar/Librenms-dash/librenms-dash.github.io/.env.local <<'EOF'
BACKEND_URL=http://localhost:3001
AUTH_USERNAME=admin
AUTH_PASSWORD=spiderman
EOF
```

Confirm it's covered by the `.gitignore` from Task 1 (`.env.local` line) before continuing.

- [ ] **Step 4: Add the `anonymize` script to `package.json`**

In the `"scripts"` block, add:

```json
    "anonymize": "tsx scripts/anonymize/run.ts"
```

- [ ] **Step 5: Confirm the source app is running, then run the pipeline**

```bash
cd /home/jkumar/Librenms-dash
docker compose ps
```

Expected: the `librenms-dash` service shows `Up`. If not, run `docker-compose up -d` there first and wait for it to become healthy.

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npm run anonymize
```

Expected output ends with:
```
Audit passed — no real site/hostname/displayName strings found in anonymized output.
```
If it instead prints `AUDIT FAILED`, stop — do not commit. Inspect the listed leaked strings, extend `scripts/anonymize/transform.ts`'s scrub coverage for whatever field they came from, and re-run.

- [ ] **Step 6: Manual review pass**

The automated audit only checks exact real strings the script already knows about (site names/ids, hostnames, displayNames). Manually grep for the categories of leakage automation can't fully guarantee — partial IP octets and MAC OUI prefixes from the real network, in case any raw un-anonymized value slipped through a field the transform didn't cover:

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
grep -o '"[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}"' src/data/topology.json src/data/deviceOverviews.json | sort -u | grep -v '"10\.2[0-9][0-9]\.' | grep -v '"127\.0\.0\.1"'
```

Expected: no output (every IPv4 literal in the committed files is either the `10.200.x.x`–`10.219.x.x` fake range or the untouched loopback address). If this prints anything else, a real IP leaked through — find which field it came from (`grep -n "<the ip>" src/data/*.json`) and fix `transform.ts` before proceeding.

- [ ] **Step 7: Commit**

```bash
git add scripts/anonymize/run.ts .env.local.example package.json package-lock.json src/data/topology.json src/data/deviceOverviews.json public/icons
git commit -m "Pull and anonymize real topology snapshot; bundle device icons"
```

---

## Task 7: Static device detail popover (Sparkline + rewritten data hook)

**Files:**
- Create: `src/components/Sparkline.tsx`
- Create: `src/hooks/useDeviceDetail.ts` (replaces the stub deleted from Task 3's scope — this is the real implementation)
- Modify: `src/components/DevicePopover.tsx` (replace the Task 3 stub with the real component, adapted for static data)

**Interfaces:**
- Consumes: `src/data/deviceOverviews.json` (Task 6), `@/types` (Task 2).
- Produces: `useDeviceDetail(hostname: string | null): { data: DeviceOverview | undefined; isLoading: false }` — same shape `DevicePopover` already expects from the original app, so no other file needs to change. `Sparkline({ seed: number; kind: "processor" | "mempool"; width?: number; height?: number })`.

No backend `graphUrl`/`iconUrl` helper is needed anywhere in this demo: `DeviceNode.tsx` already inlines its icon path (Task 3), and `DevicePopover.tsx` does the same here — matching how the original app inlines the icon `<img src>` too.

- [ ] **Step 1: Create `src/components/Sparkline.tsx`**

```tsx
interface Props {
  seed: number;
  kind: "processor" | "mempool";
  width?: number;
  height?: number;
}

// Deterministic PRNG so the same device always renders the same fake trend
// across reloads, instead of re-randomizing every render.
function mulberry32(a: number) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POINTS = 48;

function generateSeries(seed: number): number[] {
  const rand = mulberry32(seed);
  const series: number[] = [];
  let value = 20 + rand() * 40;
  for (let i = 0; i < POINTS; i++) {
    value += (rand() - 0.5) * 12;
    value = Math.max(3, Math.min(97, value));
    series.push(value);
  }
  return series;
}

export function Sparkline({ seed, kind, width = 380, height = 100 }: Props) {
  const series = generateSeries(seed * 1000 + (kind === "processor" ? 1 : 2));
  const padding = 4;
  const w = width - padding * 2;
  const h = height - padding * 2;
  const stepX = w / (POINTS - 1);
  const points = series.map((v, i) => `${padding + i * stepX},${padding + h - (v / 100) * h}`);
  const areaPoints = [`${padding},${padding + h}`, ...points, `${padding + w},${padding + h}`];
  const color = kind === "processor" ? "#22c55e" : "#3b82f6";
  const latest = series[series.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="rounded w-full bg-gray-800">
      <polygon points={areaPoints.join(" ")} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={1.5} />
      <text x={width - 6} y={14} textAnchor="end" fill={color} fontSize={11} fontFamily="monospace">
        {latest.toFixed(0)}%
      </text>
    </svg>
  );
}
```

- [ ] **Step 2: Create `src/hooks/useDeviceDetail.ts`**

```ts
import deviceOverviews from "@/data/deviceOverviews.json";
import type { DeviceOverview } from "@/types";

const overviews = deviceOverviews as Record<string, DeviceOverview>;

export function useDeviceDetail(hostname: string | null) {
  return { data: hostname ? overviews[hostname] : undefined, isLoading: false };
}
```

- [ ] **Step 3: Replace the Task 3 stub `DevicePopover.tsx` with the real component**

Copy the original as a starting point:

```bash
cp /home/jkumar/Librenms-dash/frontend/src/components/DevicePopover.tsx /home/jkumar/Librenms-dash/librenms-dash.github.io/src/components/DevicePopover.tsx
```

Then apply these edits:

Old:
```tsx
import type { HealthSensor, Port, Alert, DeviceRoute, DeviceInterface } from "@librenms-dash/shared";
import { useDeviceDetail } from "@/hooks/useDeviceDetail";
import { graphUrl } from "@/lib/api";
import { formatRate } from "@/lib/format";
import { Copyable } from "./Copyable";
```
New:
```tsx
import type { HealthSensor, Port, Alert, DeviceRoute, DeviceInterface } from "@/types";
import { useDeviceDetail } from "@/hooks/useDeviceDetail";
import { formatRate } from "@/lib/format";
import { Copyable } from "./Copyable";
import { Sparkline } from "./Sparkline";
```

Old:
```tsx
            <img
              src={`/api/graph/icon/${icon}`}
              alt=""
              className="w-8 h-8 shrink-0"
            />
```
New:
```tsx
            <img
              src={`/icons/${icon}`}
              alt=""
              className="w-8 h-8 shrink-0"
            />
```

Old:
```tsx
          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-1 font-semibold">CPU (24h)</div>
            <img
              src={graphUrl(hostname, "device_processor", { width: 380, height: 100 })}
              alt="CPU"
              className="rounded w-full bg-gray-800"
              loading="eager"
            />
          </div>

          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-1 font-semibold">Memory (24h)</div>
            <img
              src={graphUrl(hostname, "device_mempool", { width: 380, height: 100 })}
              alt="Memory"
              className="rounded w-full bg-gray-800"
              loading="eager"
            />
          </div>
```
New:
```tsx
          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-1 font-semibold">CPU (24h)</div>
            <Sparkline seed={data.device.device_id} kind="processor" width={380} height={100} />
          </div>

          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-1 font-semibold">Memory (24h)</div>
            <Sparkline seed={data.device.device_id} kind="mempool" width={380} height={100} />
          </div>
```

- [ ] **Step 4: Build and smoke-test**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npm run build
npm run dev
```

Open `http://localhost:5173`, click a device box (App.tsx still renders `emptyData` from Task 3 at this point, so there's nothing to click yet — this build check only confirms compilation succeeds; the visual popover check happens in Task 9 once `App.tsx` renders the real data).

Expected: `npm run build` succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sparkline.tsx src/hooks/useDeviceDetail.ts src/components/DevicePopover.tsx
git commit -m "Replace live device-detail fetch and RRD graphs with static data and sparklines"
```

---

## Task 8: Simulated live activity (replaces SSE)

**Files:**
- Create: `src/hooks/useDemoEvents.ts`

**Interfaces:**
- Consumes: `src/data/topology.json` (Task 6, via the bundled `arpDevices` array), `AssetEvent` type from `@/types`.
- Produces: `useDemoEvents(): { allEvents: AssetEvent[]; connected: boolean }` — the exact shape `TopologyMap` expects for its `sse` prop (Task 3), so `App.tsx` (Task 9) can call it as a drop-in replacement for the original `useSSE()`.

Real asset-change events use one of several `category` values (`"discovered-device"`, `"device"`, `"port"`, `"ip"`, `"overlay-link"`, `"route"`), each with its own `asset` string format (verified in `(source repo)/backend/src/jobs/poller.ts`). To keep this simple and avoid inventing formats `AssetEventToast` wasn't built to parse, the demo only simulates `"discovered-device"` events — format `"<mac> at <location>"`, sampled from the already-anonymized `arpDevices` bundled in `topology.json` — which `AssetEventToast`'s `CopyableAsset` already knows how to render (it special-cases exactly this category/format).

- [ ] **Step 1: Create `src/hooks/useDemoEvents.ts`**

```ts
import { useEffect, useRef, useState } from "react";
import topologyData from "@/data/topology.json";
import type { AssetEvent, TopologyResponse } from "@/types";

const topology = topologyData as TopologyResponse;

const TICK_BASE_MS = 20_000;
const TICK_JITTER_MS = 10_000;
const MAX_EVENTS = 200;

function formatMacColon(mac: string): string {
  return mac.replace(/(.{2})(?=.)/g, "$1:");
}

export function useDemoEvents() {
  const [allEvents, setAllEvents] = useState<AssetEvent[]>([]);
  const idRef = useRef(1);

  useEffect(() => {
    const pool = topology.arpDevices;
    if (pool.length === 0) return;

    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const device = pool[Math.floor(Math.random() * pool.length)];
      const action: AssetEvent["action"] = Math.random() < 0.7 ? "added" : "removed";
      const event: AssetEvent = {
        id: idRef.current++,
        timestamp: new Date().toISOString(),
        action,
        category: "discovered-device",
        asset: `${formatMacColon(device.mac)} at ${device.location}`,
      };
      setAllEvents((prev) => {
        const merged = [...prev, event];
        return merged.length > MAX_EVENTS ? merged.slice(-MAX_EVENTS) : merged;
      });
      timer = setTimeout(tick, TICK_BASE_MS + Math.random() * TICK_JITTER_MS);
    };

    timer = setTimeout(tick, TICK_BASE_MS + Math.random() * TICK_JITTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return { allEvents, connected: true };
}
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
npm run build
```

Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useDemoEvents.ts
git commit -m "Add simulated live asset-event ticker in place of SSE"
```

---

## Task 9: Final assembly, production build, and browser verification

**Files:**
- Modify: `src/App.tsx` (final version — replaces the Task 3 smoke-test stub)
- Modify: `.gitignore` (stop ignoring `docs/`, now the intentional Pages source)

**Interfaces:**
- Consumes: `topology.json` (Task 6), `TopologyMap` (Task 3), `useDemoEvents` (Task 8) — everything built in Tasks 1–8.
- Produces: the finished app.

- [ ] **Step 1: Write the final `src/App.tsx`**

```tsx
import topologyData from "@/data/topology.json";
import type { TopologyResponse } from "@/types";
import { TopologyMap } from "@/components/TopologyMap";
import { useDemoEvents } from "@/hooks/useDemoEvents";

const data = topologyData as TopologyResponse;

export function App() {
  const sse = useDemoEvents();
  return <TopologyMap data={data} sse={sse} />;
}
```

- [ ] **Step 2: Stop ignoring the build output**

In `.gitignore`, remove the `docs/` line (added in Task 1 only to keep early partial builds out of git). The file should now read:

```
node_modules/
*.tsbuildinfo
.DS_Store
.env.local
.scratch/
```

- [ ] **Step 3: Production build**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
rm -rf docs
npm run build
```

Expected: succeeds, `docs/index.html` and hashed asset bundles exist, `docs/icons/*` present (copied from `public/icons/` by Vite).

- [ ] **Step 4: Manual browser verification**

```bash
npm run dev
```

Open `http://localhost:5173` and check, in order:
1. The topology canvas loads directly — no login screen, no spinner stuck on "Loading topology...".
2. Sites render with their (fake) location labels; devices render with their bundled icons (no broken image icons).
3. Click a device box: the popover opens, shows a fake `role-NN.demo.lan` hostname, fake IPs (`10.2xx.x.x` range), a CPU and Memory sparkline chart (not a broken image), and no `serial`/`sysContact` real values.
4. Open the browser devtools console: no errors, no failed network requests (aside from expectedly-absent ones — there should be none, since everything is bundled).
5. Use the search box to search a fake IP or fake hostname fragment — matching devices highlight (confirms the anonymized `allIps`/`lanIp` fields still round-trip through the existing search logic).
6. Wait ~20–30s: an asset-change toast should slide in at the bottom-right showing a `discovered-device` added/removed event with a fake MAC/location.
7. Reload the page: the CPU/Memory sparkline for a given device should look the same as before the reload (confirms the seeded PRNG is deterministic, not re-randomized per mount).

If any of these fail, fix the responsible file from the earlier task before proceeding — do not move on with a known-broken demo.

- [ ] **Step 5: Commit**

```bash
cd /home/jkumar/Librenms-dash/librenms-dash.github.io
git add .gitignore src/App.tsx docs
git commit -m "Wire final demo app and commit production build to docs/"
```

- [ ] **Step 6: Report to the user**

Tell the user the demo repo is ready at `/home/jkumar/Librenms-dash/librenms-dash.github.io` with the build committed to `docs/`, and that they still need to (outside this plan, since it touches GitHub's hosted settings, not local files): create the GitHub repository (if not already), push `main`, and enable GitHub Pages in the repo settings with source = `main` branch, `/docs` folder.

---

## Self-Review

**Spec coverage:**
- Repo/build structure (Vite source at root, `outDir: docs`, no Actions workflow, manual build+commit) → Tasks 1, 9.
- One-time anonymization pipeline (fetch → remap tables → global scrub → manual review → commit) → Tasks 4, 5, 6.
- Subnet-preserving IP remap, MAC randomization, role-based hostnames, fixed site pool, lat/lng nulled, serials/sysContact stripped → Task 5, tested in Task 4/5, executed in Task 6.
- Component reuse split (copied verbatim / rewritten / dropped) → Tasks 2, 3, 7, 8, 9 (auth dropped by simply never including `AuthContext`/`AuthScreen`/`LoginPage`/`lib/auth.ts` in any copy list).
- Icons bundled locally → Task 6 (download step), Task 3 (path edit).
- Sparkline instead of RRD graphs → Task 7.
- Simulated live activity instead of SSE → Task 8.
- Testing/verification (build succeeds, manual browser check, grep anonymization audit) → Tasks 6 (audit), 9 (browser check + build).

**Placeholder scan:** no TBD/TODO markers; every step has literal, complete code or exact commands with expected output.

**Type consistency check:** `TopologyResponse`/`DeviceOverview`/`AssetEvent`/etc. are defined once in `src/types.ts` (Task 2) and imported by name identically in every later task. `useDeviceDetail`'s return shape (`{ data, isLoading }`) matches what `DevicePopover.tsx` destructures (`const { data, isLoading } = useDeviceDetail(hostname);`, unchanged from the original file). `useDemoEvents`'s return shape (`{ allEvents, connected }`) matches the `SSEState` interface `TopologyMap.tsx` declares and the props `AssetEventToast` consumes. `anonymizeTopology`'s signature and the `overviews` record's fake-hostname keying match what `run.ts` (Task 6) and `useDeviceDetail.ts` (Task 7) both assume.
