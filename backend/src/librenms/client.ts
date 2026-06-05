import { LIBRENMS_URL, LIBRENMS_TOKEN } from "../config.js";

let activeRequests = 0;
const MAX_CONCURRENT = 2;
const REQUEST_TIMEOUT_MS = 30_000;
const queue: Array<() => void> = [];

function releaseSlot() {
  activeRequests--;
  const next = queue.shift();
  if (next) next();
}

function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push(() => {
      activeRequests++;
      resolve();
    });
  });
}

export async function librenmsGet<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
  await acquireSlot();
  try {
    const url = new URL(`/api/v0${path}`, LIBRENMS_URL);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { "X-Auth-Token": LIBRENMS_TOKEN },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`LibreNMS ${path} returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    releaseSlot();
  }
}

export interface BufferWithType {
  buffer: Buffer;
  contentType: string;
}

export async function librenmsGetBuffer(path: string, params?: Record<string, string>): Promise<BufferWithType> {
  await acquireSlot();
  try {
    const url = new URL(`/api/v0${path}`, LIBRENMS_URL);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { "X-Auth-Token": LIBRENMS_TOKEN },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`LibreNMS ${path} returned ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    // Detect actual content type — LibreNMS may return SVG even for "graph" endpoints
    let contentType = res.headers.get("content-type") ?? "image/png";
    if (buffer.length > 5 && buffer.subarray(0, 5).toString().startsWith("<?xml")) {
      contentType = "image/svg+xml";
    }
    return { buffer, contentType };
  } finally {
    releaseSlot();
  }
}

export async function librenmsGetRaw(rawPath: string): Promise<Buffer> {
  await acquireSlot();
  try {
    const url = new URL(rawPath, LIBRENMS_URL);
    const res = await fetch(url.toString(), {
      headers: { "X-Auth-Token": LIBRENMS_TOKEN },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`LibreNMS ${rawPath} returned ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    releaseSlot();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
