import { describe, expect, it, vi } from "vitest";
import { fetchPageFull, queryDataSourceRows } from "../src/export/json.js";
import type { RateLimitedNotion } from "../src/notion/client.js";
import { hydratePageProperties } from "../src/notion/properties.js";

type PropertyRequest = {
  page_id: string;
  property_id: string;
  page_size?: number;
  start_cursor?: string;
};
type FakeClient = {
  pages?: {
    retrieve?: (args: { page_id: string }) => Promise<unknown>;
    properties?: { retrieve: (args: PropertyRequest) => Promise<unknown> };
  };
  dataSources?: {
    query: (args: { data_source_id: string; start_cursor?: string }) => Promise<unknown>;
  };
};

function makeNotion(client: FakeClient): RateLimitedNotion {
  return {
    run: <T>(fn: (c: FakeClient) => Promise<T>) => fn(client),
  } as unknown as RateLimitedNotion;
}

const relations = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({ id: `related-${from + i}` }));
const relationItems = (from: number, to: number) =>
  relations(from, to).map((relation) => ({
    object: "property_item",
    type: "relation",
    relation,
  }));
const list = (
  results: unknown[],
  has_more = false,
  next_cursor: string | null = null,
  property_item?: unknown,
) => ({
  object: "list",
  type: "property_item",
  results,
  has_more,
  next_cursor,
  ...(property_item ? { property_item } : {}),
});

describe("full-fidelity property items", () => {
  it("hydrates a 41-link relation using every cursor and the stable property ID", async () => {
    const raw = {
      id: "page-1",
      properties: {
        Related: { id: "x%5Ey", type: "relation", has_more: true, relation: relations(0, 25) },
        Name: { id: "title", type: "title", title: [{ plain_text: "Example" }] },
      },
    };
    const retrieveProperty = vi.fn(async (args: PropertyRequest) =>
      args.start_cursor
        ? list(relationItems(25, 41))
        : list(relationItems(0, 25), true, "cursor-2"),
    );
    const notion = makeNotion({
      pages: {
        retrieve: vi.fn(async () => raw),
        properties: { retrieve: retrieveProperty },
      },
    });
    const exported = await fetchPageFull(notion, "page-1", []);
    const related = (exported.page as typeof raw).properties.Related;
    expect(related.relation).toHaveLength(41);
    expect(related.relation[40]?.id).toBe("related-40");
    expect(related.has_more).toBe(false);
    expect(raw.properties.Related.relation).toHaveLength(25); // don't mutate API response
    expect(retrieveProperty).toHaveBeenCalledTimes(2);
    expect(retrieveProperty).toHaveBeenNthCalledWith(1, {
      page_id: "page-1",
      property_id: "x%5Ey",
      page_size: 100,
    });
    expect(retrieveProperty).toHaveBeenNthCalledWith(2, {
      page_id: "page-1",
      property_id: "x%5Ey",
      page_size: 100,
      start_cursor: "cursor-2",
    });
  });

  it("hydrates truncated relations on database rows, not only standalone pages", async () => {
    const row = {
      id: "row-1",
      object: "page",
      properties: {
        Projects: {
          id: "rel-id",
          type: "relation",
          has_more: true,
          relation: relations(0, 25),
        },
      },
    };
    const retrieveProperty = vi.fn(async () => list(relationItems(0, 38)));
    const notion = makeNotion({
      pages: { properties: { retrieve: retrieveProperty } },
      dataSources: {
        query: vi.fn(async () => ({
          results: [row],
          has_more: false,
          next_cursor: null,
        })),
      },
    });
    const rows = await queryDataSourceRows(notion, "source-1");
    const first = rows[0] as typeof row;
    expect(first.properties.Projects.relation).toHaveLength(38);
    expect(retrieveProperty).toHaveBeenCalledOnce();
  });

  it("does not add API calls for short complete relation and rich text values", async () => {
    const retrieveProperty = vi.fn();
    const row = {
      id: "short",
      properties: {
        Related: { id: "r", type: "relation", has_more: false, relation: relations(0, 3) },
        Name: { id: "title", type: "title", title: [{ plain_text: "Done" }] },
        Note: { id: "txt", type: "rich_text", rich_text: [{ plain_text: "one" }] },
      },
    };
    const hydrated = await hydratePageProperties(
      makeNotion({ pages: { properties: { retrieve: retrieveProperty } } }),
      row,
    );
    expect(hydrated).toBe(row);
    expect(retrieveProperty).not.toHaveBeenCalled();
  });

  it.each(["people", "title", "rich_text"] as const)(
    "hydrates a 26-item %s property",
    async (type) => {
      const values = Array.from({ length: 25 }, (_, i) => ({ id: `value-${i}` }));
      const items = Array.from({ length: 26 }, (_, i) => ({
        object: "property_item",
        type,
        [type]: { id: `value-${i}` },
      }));
      const retrieveProperty = vi.fn(async () => list(items));
      const page = {
        id: "p1",
        properties: {
          Lots: { id: "long", type, [type]: values },
        },
      };
      const out = await hydratePageProperties(
        makeNotion({ pages: { properties: { retrieve: retrieveProperty } } }),
        page,
      );
      expect((out.properties.Lots as Record<string, unknown>)[type]).toHaveLength(26);
    },
  );

  it("refreshes formula values through the property-item API", async () => {
    const out = await hydratePageProperties(
      makeNotion({
        pages: {
          properties: {
            retrieve: vi.fn(async () => ({
              object: "property_item",
              type: "formula",
              formula: { type: "number", number: 46 },
            })),
          },
        },
      }),
      {
        id: "p1",
        properties: {
          Count: { id: "f", type: "formula", formula: { type: "number", number: 25 } },
        },
      },
    );
    expect(out.properties.Count.formula.number).toBe(46);
  });

  it("preserves all rollup source items and its final computed value", async () => {
    const raw = {
      id: "p1",
      properties: {
        Total: { id: "roll", type: "rollup", rollup: { type: "incomplete" } },
      },
    };
    const notion = makeNotion({
      pages: {
        properties: {
          retrieve: vi.fn(async (args: PropertyRequest) =>
            args.start_cursor
              ? list(relationItems(25, 38), false, null, {
                  type: "rollup",
                  rollup: { type: "number", number: 38, function: "count" },
                })
              : list(relationItems(0, 25), true, "next"),
          ),
        },
      },
    });
    const out = await hydratePageProperties(notion, raw);
    const roll = out.properties.Total as Record<string, unknown>;
    expect((roll.rollup as { number: number }).number).toBe(38);
    expect(roll.rollup_items).toHaveLength(38);
  });

  it("rejects a data-source row when one property cannot be retrieved", async () => {
    const notion = makeNotion({
      pages: {
        properties: {
          retrieve: vi.fn(async () => {
            throw new Error("relation access revoked");
          }),
        },
      },
      dataSources: {
        query: vi.fn(async () => ({
          results: [
            {
              id: "row-with-revoked-relation",
              properties: {
                Links: { id: "r", type: "relation", has_more: true, relation: relations(0, 25) },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        })),
      },
    });
    await expect(queryDataSourceRows(notion, "source-1")).rejects.toThrow(
      /relation access revoked/,
    );
  });

  it("fails instead of archiving a truncated relation after an incomplete API response", async () => {
    const notion = makeNotion({
      pages: {
        properties: { retrieve: vi.fn(async () => list(relationItems(0, 25), true, null)) },
      },
    });
    await expect(
      hydratePageProperties(notion, {
        id: "p1",
        properties: {
          Links: { id: "r", type: "relation", has_more: true, relation: relations(0, 25) },
        },
      }),
    ).rejects.toThrow(/missing continuation cursor/);
  });

  it("fails on relation counts that shrink between the page and property reads", async () => {
    const notion = makeNotion({
      pages: { properties: { retrieve: vi.fn(async () => list(relationItems(0, 4))) } },
    });
    await expect(
      hydratePageProperties(notion, {
        id: "p1",
        properties: {
          Links: { id: "r", type: "relation", has_more: true, relation: relations(0, 25) },
        },
      }),
    ).rejects.toThrow(/property shrank during export/);
  });

  it("propagates permission errors rather than treating missing relations as empty", async () => {
    const notion = makeNotion({
      pages: {
        properties: {
          retrieve: vi.fn(async () => {
            throw Object.assign(new Error("restricted_resource"), { status: 403 });
          }),
        },
      },
    });
    await expect(
      hydratePageProperties(notion, {
        id: "p1",
        properties: {
          Links: { id: "r", type: "relation", has_more: true, relation: relations(0, 25) },
        },
      }),
    ).rejects.toThrow(/restricted_resource/);
  });
});
