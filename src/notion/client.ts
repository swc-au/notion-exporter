import { setTimeout as sleep } from "node:timers/promises";
import { Client, type LogLevel } from "@notionhq/client";
import Bottleneck from "bottleneck";
import type { Logger } from "../logger.js";

export { sleep };

export interface RateLimitedClientOptions {
  token: string;
  minTime?: number; // ms between requests; default 150 (~6 req/s) overshoots Notion's ~3/s, so 429s are expected and absorbed by retry. Raise to ~350 to mostly stay under.
  maxConcurrent?: number; // default 4; 429 retry handles overshoot
  maxRetries?: number; // default 8 — Notion bursts can produce long Retry-After
  reservoir?: number | null;
  log?: Logger;
}

interface NotionApiError {
  status?: number;
  code?: string;
  headers?: Record<string, string | string[] | undefined>;
}

function getRetryAfterMs(err: unknown): number | null {
  const e = err as NotionApiError;
  const headers = e?.headers ?? {};
  const ra = headers["retry-after"] ?? headers["Retry-After"];
  if (!ra) return null;
  const v = Array.isArray(ra) ? ra[0] : ra;
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export function isRateLimitError(err: unknown): boolean {
  const e = err as NotionApiError;
  return e?.status === 429 || e?.code === "rate_limited";
}

export function isRetryableError(err: unknown): boolean {
  const e = err as NotionApiError;
  if (isRateLimitError(err)) return true;
  if (typeof e?.status === "number" && e.status >= 500 && e.status < 600) return true;
  // Transient transport failures carry no HTTP status: the SDK's own timeout,
  // and undici's `TypeError("fetch failed")` on a reset/refused socket. Every
  // call we make is a read, so replaying one is safe.
  if (e?.code === "notionhq_client_request_timeout") return true;
  if (err instanceof TypeError && err.message === "fetch failed") return true;
  return false;
}

export class RateLimitedNotion {
  readonly client: Client;
  readonly limiter: Bottleneck;
  private readonly maxRetries: number;
  private readonly log: Logger | undefined;

  constructor(opts: RateLimitedClientOptions) {
    // We own retry/backoff (see attempt() below), so turn the SDK's built-in
    // retry off — left on, it nests inside ours (up to 3 × maxRetries attempts,
    // each SDK back-off sleeping while it holds a limiter slot) — and silence
    // its per-request WARN logs for handled 429/5xx; genuine errors still
    // surface. Literal (= LogLevel.ERROR) keeps this a type-only import, so
    // test mocks of @notionhq/client need not also export the LogLevel enum.
    this.client = new Client({ auth: opts.token, logLevel: "error" as LogLevel, retry: false });
    this.limiter = new Bottleneck({
      minTime: opts.minTime ?? 150,
      maxConcurrent: opts.maxConcurrent ?? 4,
      reservoir: opts.reservoir ?? null,
    });
    this.maxRetries = opts.maxRetries ?? 8;
    this.log = opts.log;
  }

  async run<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    return this.limiter.schedule(() => this.attempt(fn, 0));
  }

  private async attempt<T>(fn: (c: Client) => Promise<T>, attempt: number): Promise<T> {
    for (let i = attempt; i <= this.maxRetries; i++) {
      try {
        return await fn(this.client);
      } catch (err) {
        if (!isRetryableError(err) || i >= this.maxRetries) throw err;
        const retryAfter = getRetryAfterMs(err);
        const backoff = retryAfter ?? Math.min(30_000, 500 * 2 ** i);
        this.log?.warn({ attempt: i + 1, backoffMs: backoff }, "notion request failed, retrying");
        await sleep(backoff);
      }
    }
    throw new Error("unreachable");
  }
}

/** Shape `paginate` consumes from every Notion list/query endpoint. */
export interface PaginatedList<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Validate a Notion list/query response before trusting it as a complete
 * snapshot. The SDK's broad response unions require a runtime shape check.
 *
 * Never turn malformed or incomplete API responses into an empty terminal
 * page: that would make a truncated backup appear successful.
 */
export function asPaginatedList<T>(res: unknown): PaginatedList<T> {
  if (res === null || typeof res !== "object" || Array.isArray(res)) {
    throw new Error("Invalid Notion pagination response: expected an object");
  }
  const r = res as Record<string, unknown>;
  if (!Array.isArray(r.results)) {
    throw new Error("Invalid Notion pagination response: results must be an array");
  }
  if (typeof r.has_more !== "boolean") {
    throw new Error("Invalid Notion pagination response: has_more must be a boolean");
  }
  if (r.has_more && (typeof r.next_cursor !== "string" || r.next_cursor.length === 0)) {
    throw new Error("Invalid Notion pagination response: missing continuation cursor");
  }
  // Some endpoints have returned a stale next_cursor with has_more: false.
  // has_more is the authoritative terminal marker; do not follow that cursor.
  // An omitted cursor on the final page is also valid.
  if (
    !r.has_more &&
    r.next_cursor !== null &&
    r.next_cursor !== undefined &&
    typeof r.next_cursor !== "string"
  ) {
    throw new Error("Invalid Notion pagination response: invalid terminal cursor type");
  }
  return {
    results: r.results as T[],
    next_cursor: r.has_more ? (r.next_cursor as string) : null,
    has_more: r.has_more,
  };
}

export async function paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<PaginatedList<T>>,
): Promise<T[]> {
  const all: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    // Also validate direct callers that don't explicitly use asPaginatedList.
    const page = asPaginatedList<T>(await fetchPage(cursor));
    for (const r of page.results) all.push(r);
    if (!page.has_more) return all;

    const next = page.next_cursor as string; // guaranteed by asPaginatedList
    if (seenCursors.has(next)) {
      throw new Error("Invalid Notion pagination response: repeated continuation cursor");
    }
    seenCursors.add(next);
    cursor = next;
  }
}
