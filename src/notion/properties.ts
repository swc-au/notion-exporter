import type { RateLimitedNotion } from "./client.js";
import { asPaginatedList, paginate } from "./client.js";

type JsonObject = Record<string, unknown>;
type ArrayPropertyType = "relation" | "people" | "rich_text" | "title";
const ARRAY_TYPES = new Set<string>(["relation", "people", "rich_text", "title"]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The page and data-source query endpoints can truncate property values at
 * 25 items. For backup purposes a partial relation is not a valid result.
 *
 * A relation's has_more flag is authoritative when present; an array of 25
 * may also have been truncated. Rollups/formulas can depend on >25 referenced
 * pages, so always resolve their current value via the property-item API.
 */
function needsFullValue(property: JsonObject): boolean {
  const type = property.type;
  if (type === "rollup" || type === "formula") return true;
  if (type === "relation") {
    return (
      property.has_more === true ||
      (Array.isArray(property.relation) && property.relation.length >= 25)
    );
  }
  return (
    (type === "people" || type === "title" || type === "rich_text") &&
    Array.isArray(property[type]) &&
    property[type].length >= 25
  );
}

function propertyError(pageId: string, name: string, detail: string): Error {
  return new Error(`Cannot back up property "${name}" on page ${pageId}: ${detail}`);
}

/**
 * Read one complete property, following every cursor. SDK property-item
 * responses are either a single property_item (e.g. formula) or a paginated
 * list of property_items (relation, title, rich_text, people and rollups).
 *
 * The original PagePropertyValue shape remains the canonical representation
 * in raw JSON and for the existing renderers. For rollup lists we retain the
 * source aggregation items separately as rollup_items.
 */
async function retrieveCompleteProperty(
  notion: RateLimitedNotion,
  pageId: string,
  name: string,
  property: JsonObject,
): Promise<JsonObject> {
  const type = property.type;
  const propertyId = property.id;
  if (typeof propertyId !== "string" || propertyId.length === 0) {
    throw propertyError(pageId, name, "missing stable property ID");
  }

  const get = (cursor?: string) =>
    notion.run((c) =>
      c.pages.properties.retrieve({
        page_id: pageId,
        property_id: propertyId,
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: 100,
      }),
    );

  const first = await get();
  if (!isObject(first)) {
    throw propertyError(pageId, name, "invalid property-item response");
  }

  if (first.object === "property_item") {
    if (first.type !== type || (type !== "formula" && type !== "rollup")) {
      throw propertyError(pageId, name, "unexpected scalar property-item type");
    }
    if (!isObject(first[type])) {
      throw propertyError(pageId, name, "missing computed property value");
    }
    return { ...property, [type]: first[type] };
  }

  if (first.object !== "list" || first.type !== "property_item") {
    throw propertyError(pageId, name, "expected a paginated property-item list");
  }
  if (!ARRAY_TYPES.has(String(type)) && type !== "rollup") {
    throw propertyError(pageId, name, "unexpected paginated property type");
  }

  let current: JsonObject = first;
  let firstPage = true;
  let finalItem: unknown;
  const results = await paginate<unknown>(async (cursor) => {
    if (!firstPage) {
      const response = await get(cursor);
      if (!isObject(response) || response.object !== "list" || response.type !== "property_item") {
        throw propertyError(pageId, name, "invalid continuation response");
      }
      current = response;
    }
    firstPage = false;
    finalItem = current.property_item;
    return asPaginatedList<unknown>(current);
  });

  if (type === "rollup") {
    if (!isObject(finalItem) || finalItem.type !== "rollup" || !isObject(finalItem.rollup)) {
      throw propertyError(pageId, name, "missing final rollup aggregation");
    }
    if (finalItem.rollup.type === "incomplete") {
      throw propertyError(pageId, name, "rollup aggregation remained incomplete");
    }
    // Preserve all underlying list items: the final rollup value alone can
    // hide the source relations used to calculate the aggregate.
    return { ...property, rollup: finalItem.rollup, rollup_items: results };
  }

  const arrayType = type as ArrayPropertyType;
  const complete = results.map((item) => {
    if (
      !isObject(item) ||
      item.object !== "property_item" ||
      item.type !== arrayType ||
      !(arrayType in item) ||
      !isObject(item[arrayType])
    ) {
      throw propertyError(pageId, name, "invalid item in property list");
    }
    return item[arrayType];
  });
  const original = property[arrayType];
  if (Array.isArray(original) && complete.length < original.length) {
    throw propertyError(
      pageId,
      name,
      "property shrank during export; retry for a consistent snapshot",
    );
  }
  return {
    ...property,
    [arrayType]: complete,
    ...(arrayType === "relation" ? { has_more: false } : {}),
  };
}

/**
 * Hydrate both standalone page retrievals and data-source query rows.
 * Exporters must call this BEFORE persisting raw JSON or rendering a row.
 * All API traffic travels through RateLimitedNotion's limiter/retry path.
 */
export async function hydratePageProperties<T>(notion: RateLimitedNotion, page: T): Promise<T> {
  if (!isObject(page) || !isObject(page.properties)) return page;
  const pageId = page.id;
  if (typeof pageId !== "string" || pageId.length === 0) {
    throw new Error("Cannot back up page properties: missing page ID");
  }
  let updated: JsonObject | undefined;
  for (const [name, value] of Object.entries(page.properties)) {
    if (!isObject(value) || !needsFullValue(value)) continue;
    const hydrated = await retrieveCompleteProperty(notion, pageId, name, value);
    if (!updated) updated = { ...page.properties };
    updated[name] = hydrated;
  }
  return updated ? ({ ...page, properties: updated } as T) : page;
}
