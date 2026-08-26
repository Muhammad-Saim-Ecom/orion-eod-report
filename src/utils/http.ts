import { logger } from "./logger.js";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Number of retry attempts on transient failures (429/5xx/network). */
  retries?: number;
}

const DEFAULT_RETRIES = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch wrapper with JSON handling and exponential-backoff retry on transient
 * errors (HTTP 429 / 5xx / network). Throws on non-OK responses after retries.
 *
 * Used by the Time Doctor client; the Slack and Notion SDKs do their own HTTP.
 */
export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const headers: Record<string, string> = { ...opts.headers };
  let bodyInit: string | undefined;

  if (opts.body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    bodyInit = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: bodyInit,
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      const transient = res.status === 429 || res.status >= 500;
      const text = await res.text().catch(() => "");
      if (transient && attempt < retries) {
        // Honor Retry-After if the server sends it (seconds); else exponential
        // backoff. Rate limits (429) get a longer floor so we back off hard.
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = 2 ** attempt * 1000;
        const floor = res.status === 429 ? 3000 : 0;
        const wait = retryAfter > 0 ? retryAfter * 1000 : Math.max(backoff, floor);
        logger.warn(`HTTP ${res.status} on ${redact(url)}; retrying in ${wait}ms`, text.slice(0, 200));
        await sleep(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${redact(url)}: ${text.slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = 2 ** attempt * 500;
        logger.warn(`Request error on ${redact(url)}; retrying in ${wait}ms`, String(err));
        await sleep(wait);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Strip query-string secrets (token=) before logging a URL. */
function redact(url: string): string {
  return url.replace(/token=[^&]+/g, "token=***");
}
