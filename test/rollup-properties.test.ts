import { expect, it } from "vitest";
import { formatProp } from "../src/export/markdown/properties.js";
import type { RateLimitedNotion } from "../src/notion/client.js";
import { hydratePageProperties } from "../src/notion/properties.js";

const notionFor = (response: unknown) =>
  ({
    run: (fn: (c: unknown) => unknown) =>
      fn({ pages: { properties: { retrieve: async () => response } } }),
  }) as unknown as RateLimitedNotion;

it("retains show_original values in the canonical rollup and renderer", async () => {
  const page = {
    id: "page",
    properties: {
      Total: {
        id: "roll",
        type: "rollup",
        rollup: {
          type: "array",
          function: "show_original",
          array: [{ type: "number", number: 7 }],
        },
      },
    },
  };
  const response = {
    object: "list",
    type: "property_item",
    results: [{ object: "property_item", id: "roll", type: "number", number: 7 }],
    has_more: false,
    next_cursor: null,
    property_item: {
      id: "roll",
      type: "rollup",
      next_url: null,
      rollup: { type: "array", array: [], function: "show_original" },
    },
  };
  const hydrated = await hydratePageProperties(notionFor(response), page);
  expect(formatProp(page.properties.Total)).toBe("7");
  expect(formatProp(hydrated.properties.Total)).toBe("7");
});

it("does not replace a known median value with unsupported endpoint metadata", async () => {
  const page = {
    id: "page",
    properties: {
      Total: {
        id: "roll",
        type: "rollup",
        rollup: { type: "number", function: "median", number: 7 },
      },
    },
  };
  const response = {
    object: "list",
    type: "property_item",
    results: [{ object: "property_item", id: "roll", type: "number", number: 7 }],
    has_more: false,
    next_cursor: null,
    property_item: {
      id: "roll",
      type: "rollup",
      next_url: null,
      rollup: { type: "unsupported", unsupported: {}, function: "median" },
    },
  };
  const hydrated = await hydratePageProperties(notionFor(response), page);
  expect(formatProp(page.properties.Total)).toBe("7");
  expect(formatProp(hydrated.properties.Total)).toBe("7");
  expect(hydrated.properties.Total).toMatchObject({
    rollup_items: response.results,
    rollup_property_item: response.property_item,
  });
});

it("rebuilds rollup arrays across pages and normalizes singular property items", async () => {
  const page = {
    id: "page",
    properties: {
      Total: {
        id: "roll",
        type: "rollup",
        rollup: {
          type: "array",
          function: "show_original",
          array: [{ type: "number", number: 7 }],
        },
      },
    },
  };
  const values = [
    { type: "number", number: 7 },
    {
      type: "rich_text",
      rich_text: { type: "text", plain_text: "Note", text: { content: "Note" } },
    },
    { type: "title", title: { type: "text", plain_text: "Title", text: { content: "Title" } } },
    { type: "people", people: { object: "user", id: "user-1", name: "Ada" } },
    { type: "relation", relation: { id: "related-page" } },
    { type: "multi_select", multi_select: [{ id: "option", name: "Blue", color: "blue" }] },
    { type: "date", date: null },
  ];
  const items = values.map((value) => ({
    object: "property_item",
    id: "source-property",
    ...value,
  }));
  const cursors: Array<string | undefined> = [];
  const notion = {
    run: (fn: (c: unknown) => unknown) =>
      fn({
        pages: {
          properties: {
            retrieve: async ({ start_cursor }: { start_cursor?: string }) => {
              cursors.push(start_cursor);
              return {
                object: "list",
                type: "property_item",
                results: start_cursor ? items.slice(1) : items.slice(0, 1),
                has_more: !start_cursor,
                next_cursor: start_cursor ? null : "second",
                property_item: {
                  id: "roll",
                  type: "rollup",
                  rollup: { type: "array", array: [], function: "show_original" },
                },
              };
            },
          },
        },
      }),
  } as unknown as RateLimitedNotion;
  const out = await hydratePageProperties(notion, page);
  expect(cursors).toEqual([undefined, "second"]);
  expect(out.properties.Total.rollup.array).toEqual(
    values.map((value) => {
      const type = value.type as keyof typeof value;
      return {
        type,
        [type]: ["rich_text", "title", "people", "relation"].includes(type)
          ? [value[type]]
          : value[type],
      };
    }),
  );
  expect(out.properties.Total).toMatchObject({ rollup_items: items });
  expect(formatProp(out.properties.Total)).toContain("7, Note, Title, Ada");
  expect(page.properties.Total.rollup.array).toEqual([{ type: "number", number: 7 }]);
  // Raw JSON remains sufficient for rerendering without any endpoint calls.
  expect(formatProp(JSON.parse(JSON.stringify(out)).properties.Total)).toBe(
    formatProp(out.properties.Total),
  );
});

it.each([
  { type: "number", number: 0, function: "median" },
  { type: "number", number: null, function: "median" },
  { type: "date", date: { start: "2026-11-02" }, function: "median" },
  { type: "date", date: null, function: "median" },
])("preserves a usable page scalar when the rollup endpoint is unsupported: %j", async (rollup) => {
  const response = {
    object: "list",
    type: "property_item",
    results: [],
    has_more: false,
    next_cursor: null,
    property_item: {
      type: "rollup",
      rollup: { type: "unsupported", unsupported: {}, function: "median" },
    },
  };
  const page = { id: "page", properties: { Total: { id: "roll", type: "rollup", rollup } } };
  const out = await hydratePageProperties(notionFor(response), page);
  expect(out.properties.Total.rollup).toEqual(rollup);
  expect(out.properties.Total).toMatchObject({ rollup_property_item: response.property_item });
});

it.each([
  { type: "unsupported", unsupported: {} },
  { type: "incomplete", incomplete: {} },
  { type: "array", array: [{ type: "number", number: 7 }], function: "show_unique" },
  { type: "number" },
])("rejects unsupported rollups without a usable scalar: %j", async (rollup) => {
  const response = {
    object: "list",
    type: "property_item",
    results: [],
    has_more: false,
    next_cursor: null,
    property_item: { type: "rollup", rollup: { type: "unsupported", unsupported: {} } },
  };
  await expect(
    hydratePageProperties(notionFor(response), {
      id: "page",
      properties: { Total: { id: "roll", type: "rollup", rollup } },
    }),
  ).rejects.toThrow(/no usable complete scalar/);
});

it("rejects malformed show-original items instead of writing an empty value", async () => {
  const response = {
    object: "list",
    type: "property_item",
    results: [{ object: "property_item", type: "number" }],
    has_more: false,
    next_cursor: null,
    property_item: { type: "rollup", rollup: { type: "array", array: [] } },
  };
  await expect(
    hydratePageProperties(notionFor(response), {
      id: "page",
      properties: { Total: { id: "roll", type: "rollup", rollup: { type: "array", array: [] } } },
    }),
  ).rejects.toThrow(/invalid item in rollup array/);
});
