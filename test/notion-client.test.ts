import { describe, expect, it, vi } from "vitest";
import {
  asPaginatedList,
  isRateLimitError,
  isRetryableError,
  paginate,
  RateLimitedNotion,
} from "../src/notion/client.js";

describe("notion client helpers", () => {
  it("detects 429 as rate limit", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ code: "rate_limited" })).toBe(true);
    expect(isRateLimitError({ status: 400 })).toBe(false);
  });

  it("treats 5xx as retryable", () => {
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("treats transport failures (SDK timeout, undici fetch failed) as retryable", () => {
    expect(isRetryableError({ code: "notionhq_client_request_timeout" })).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError(new TypeError("x is not a function"))).toBe(false);
  });

  it("disables the SDK's own retry so it does not nest inside ours", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "slow" }),
          { status: 429, headers: { "retry-after": "0", "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const notion = new RateLimitedNotion({ token: "t", minTime: 1, maxRetries: 0 });
      await expect(notion.run((c) => c.users.me({}))).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("paginate follows has_more cursor until exhausted", async () => {
    const pages = [
      { results: [1, 2], has_more: true, next_cursor: "a" },
      { results: [3], has_more: true, next_cursor: "b" },
      { results: [4, 5], has_more: false, next_cursor: null },
    ];
    let i = 0;
    const all = await paginate<number>(async () => pages[i++]!);
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts a well-formed terminal API page", () => {
    expect(
      asPaginatedList<number>({ results: [1, 2], has_more: false, next_cursor: null }),
    ).toEqual({ results: [1, 2], has_more: false, next_cursor: null });
  });

  it.each([
    ["null payload", null],
    ["array payload", []],
    ["missing results", { has_more: false, next_cursor: null }],
    ["non-array results", { results: {}, has_more: false, next_cursor: null }],
    ["missing has_more", { results: [], next_cursor: null }],
    ["non-boolean has_more", { results: [], has_more: "false", next_cursor: null }],
    ["missing continuation cursor", { results: [1], has_more: true, next_cursor: null }],
    ["empty continuation cursor", { results: [1], has_more: true, next_cursor: "" }],
    ["missing terminal cursor", { results: [], has_more: false }],
    ["unexpected terminal cursor", { results: [], has_more: false, next_cursor: "next" }],
  ])("rejects %s instead of silently truncating an export", (_case, response) => {
    expect(() => asPaginatedList(response)).toThrow(/Invalid Notion pagination response/);
  });

  it("rejects malformed pages even when a caller bypasses asPaginatedList", async () => {
    await expect(
      paginate<number>(async () => ({ results: [1], has_more: true, next_cursor: null })),
    ).rejects.toThrow(/missing continuation cursor/);
  });

  it("aborts the export if a later page has an invalid continuation cursor", async () => {
    const pages = [
      { results: [1, 2], has_more: true, next_cursor: "a" },
      { results: [3], has_more: true, next_cursor: null },
    ];
    let calls = 0;
    await expect(paginate<number>(async () => pages[calls++]!)).rejects.toThrow(
      /missing continuation cursor/,
    );
    expect(calls).toBe(2);
  });

  it("rejects pagination cursor cycles rather than looping indefinitely", async () => {
    const pages = [
      { results: [1], has_more: true, next_cursor: "a" },
      { results: [2], has_more: true, next_cursor: "b" },
      { results: [3], has_more: true, next_cursor: "a" },
    ];
    let i = 0;
    await expect(paginate<number>(async () => pages[i++]!)).rejects.toThrow(
      /repeated continuation cursor/,
    );
    expect(i).toBe(3);
  });

  it("retries 429 then succeeds", async () => {
    const notion = new RateLimitedNotion({ token: "t", minTime: 1, maxRetries: 3 });
    let calls = 0;
    const result = await notion.run(async () => {
      calls++;
      if (calls < 2) {
        const err: { status: number; headers: Record<string, string> } = {
          status: 429,
          headers: { "retry-after": "0" },
        };
        throw err;
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries", async () => {
    const notion = new RateLimitedNotion({ token: "t", minTime: 1, maxRetries: 2 });
    await expect(
      notion.run(async () => {
        throw { status: 500 };
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
