import fsp from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { NotionBlock } from "../notion/blocks.js";
import { fetchBlocksRecursive } from "../notion/blocks.js";
import type { RateLimitedNotion } from "../notion/client.js";
import { asPaginatedList, paginate } from "../notion/client.js";
import type { DiscoveredObject } from "../notion/crawl.js";
import { type DataSourceSchema, retrieveDataSourceSchema } from "../notion/dataSourceSchema.js";
import { hydratePageProperties } from "../notion/properties.js";
import type { ViewWithOrder } from "../notion/views.js";
import { createPool } from "../util/pool.js";
import { safeSegment } from "./paths.js";

export interface ExportedPage {
  id: string;
  title: string;
  page: unknown;
  blocks: NotionBlock[];
}

export interface ExportedDatabase {
  id: string;
  title: string;
  database: unknown;
  rows: unknown[];
  /**
   * Schema for the database's first data source, fetched once per unique
   * `data_source_id` per export. Gives the renderer the canonical option
   * order for status/select/multi_select columns. `undefined` when the
   * database has no data sources or the retrieve call failed (we log + skip;
   * renderer falls back to legacy heuristics).
   */
  dataSource?: DataSourceSchema;
  /**
   * Every view of the database (GA Views API), in Notion tab order. Each entry
   * is the view config + its filtered/sorted page-id `rowOrder`. Drives the
   * tabbed multi-view renderer; `undefined`/empty when the database exposes no
   * view or the integration lacks the capability. Persisted so rerender
   * reproduces ordering without re-querying (query handles expire).
   */
  views?: ViewWithOrder[];
}

export async function fetchPageFull(
  notion: RateLimitedNotion,
  pageId: string,
  blocksOverride?: NotionBlock[],
): Promise<{ page: unknown; blocks: NotionBlock[] }> {
  const retrieved = await notion.run((c) => c.pages.retrieve({ page_id: pageId }));
  const page = await hydratePageProperties(notion, retrieved);
  const blocks = blocksOverride ?? (await fetchBlocksRecursive(notion, pageId));
  return { page, blocks };
}

/**
 * Notion API v5 replaced `databases.query` with `dataSources.query`. A
 * database now exposes one or more data sources via `data_sources[]` on the
 * retrieve response. To preserve v4 behavior (one database → its rows) we
 * query each data source attached to the database and concatenate the
 * results. In practice most databases have exactly one data source, so this
 * matches the old shape; databases with multiple sources still get every row.
 */
export async function fetchDatabaseFull(
  notion: RateLimitedNotion,
  databaseId: string,
): Promise<{ database: unknown; rows: unknown[]; dataSourceIds: string[] }> {
  const database = await notion.run((c) => c.databases.retrieve({ database_id: databaseId }));
  const dataSourceIds = extractDataSourceIds(database);
  const rows: unknown[] = [];
  for (const dataSourceId of dataSourceIds) {
    for (const r of await queryDataSourceRows(notion, dataSourceId)) rows.push(r);
  }
  return { database, rows, dataSourceIds };
}

/** Page through every row of one data source. Shared by `fetchDatabaseFull`
 * and the linked-view resolver (a linked view's rows live in a data source the
 * inline block's own stub doesn't expose). */
export async function queryDataSourceRows(
  notion: RateLimitedNotion,
  dataSourceId: string,
): Promise<unknown[]> {
  const rows = await paginate<unknown>(async (cursor) =>
    asPaginatedList<unknown>(
      await notion.run((c) =>
        c.dataSources.query({ data_source_id: dataSourceId, start_cursor: cursor, page_size: 100 }),
      ),
    ),
  );
  // Preserve the data-source row shape but replace truncated page properties
  // before any raw JSON is written or rows are reused by linked views.
  const pool = createPool(4);
  return Promise.all(rows.map((row) => pool.run(() => hydratePageProperties(notion, row))));
}

/** A linked-view inline block reports `data_sources: []` and zero rows; the
 * view's `data_source_id` points at the real source. Query it and keep only
 * the rows the view actually shows (its filtered+ordered `rowOrder`), so the
 * persisted stub stays lean and the renderer reproduces the view exactly. */
export function filterRowsToOrder(rows: unknown[], rowOrder: string[]): unknown[] {
  if (rowOrder.length === 0) return [];
  const wanted = new Set(rowOrder);
  return rows.filter((r) => wanted.has((r as { id?: string })?.id ?? ""));
}

/**
 * Cached data-source schema fetcher. A single data source can back multiple
 * inline views — caching by `data_source_id` keeps the API call count to one
 * per unique source per export (CLAUDE.md invariant: every Notion call goes
 * through `RateLimitedNotion#run`, which `retrieveDataSourceSchema` honors).
 *
 * Returns `undefined` on failure (e.g. integration lacks access). The
 * orchestrator continues without a schema; the renderer's existing
 * heuristics handle the missing case.
 */
export function createDataSourceSchemaCache(
  notion: RateLimitedNotion,
  log?: Logger,
): (dataSourceId: string) => Promise<DataSourceSchema | undefined> {
  const cache = new Map<string, Promise<DataSourceSchema | undefined>>();
  return (dataSourceId: string) => {
    const cached = cache.get(dataSourceId);
    if (cached) return cached;
    const p = (async () => {
      try {
        return await retrieveDataSourceSchema(notion, dataSourceId);
      } catch (err) {
        log?.warn(
          { dataSourceId, err: (err as Error).message },
          "data source schema retrieve failed; renderer will fall back",
        );
        return undefined;
      }
    })();
    cache.set(dataSourceId, p);
    return p;
  };
}

interface DataSourceRef {
  id?: unknown;
}

interface DatabaseLike {
  data_sources?: DataSourceRef[];
}

function extractDataSourceIds(database: unknown): string[] {
  const refs = (database as DatabaseLike | null | undefined)?.data_sources;
  if (!Array.isArray(refs)) return [];
  const ids: string[] = [];
  for (const ref of refs) {
    if (ref && typeof ref.id === "string") ids.push(ref.id);
  }
  return ids;
}

export const RAW_PAGES = "pages" as const;
export const RAW_DATABASES = "databases" as const;
export type RawKind = typeof RAW_PAGES | typeof RAW_DATABASES;

export async function writeRawJson(
  rawDir: string,
  kind: RawKind,
  obj: { id: string; title: string },
  data: unknown,
  opts: { pretty?: boolean } = {},
): Promise<string> {
  const filename = `${safeSegment(obj.title)}.${obj.id}.json`;
  const abs = path.join(rawDir, kind, filename);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const pretty = opts.pretty !== false;
  await fsp.writeFile(abs, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  return abs;
}

export interface ExportCounts {
  pages: number;
  databases: number;
  errors: number;
}

export type ProgressEvent =
  | { kind: "crawl"; visited: number; queued: number; total: number }
  | { kind: "start"; total: number; pages: number; databases: number }
  | { kind: "page"; done: number; total: number; title: string }
  | { kind: "database"; done: number; total: number; title: string; rows: number }
  | { kind: "error"; done: number; total: number; id: string; message: string }
  | { kind: "done"; counts: ExportCounts };

export async function exportAllJson(opts: {
  notion: RateLimitedNotion;
  objects: DiscoveredObject[];
  log: Logger;
  concurrency?: number;
  onPage: (p: ExportedPage) => Promise<void>;
  onDatabase: (d: ExportedDatabase) => Promise<void>;
  onProgress?: (e: ProgressEvent) => void;
  /** Pre-fetched block trees keyed by page id; skips re-fetching during the
   * page pass. Used when crawlAll already walked block trees for discovery. */
  blocksCache?: Map<string, NotionBlock[]>;
  /** Shared cache that fetches a data source schema at most once per unique
   * `data_source_id` per export. Pass the function returned by
   * `createDataSourceSchemaCache`. When omitted, no schema is attached and
   * raw DB JSON omits the `dataSource` field. */
  dataSourceSchema?: (dataSourceId: string) => Promise<DataSourceSchema | undefined>;
  /** Resolves all of a database's views (config + per-view row order). Pass a
   * thunk over `fetchAllViews`. When omitted, no views are attached and raw DB
   * JSON omits the `views` field. */
  allViews?: (databaseId: string) => Promise<ViewWithOrder[]>;
}): Promise<ExportCounts> {
  const counts: ExportCounts = { pages: 0, databases: 0, errors: 0 };
  const total = opts.objects.length;
  const totals = {
    pages: opts.objects.filter((o) => o.object === "page").length,
    databases: opts.objects.filter((o) => o.object === "database").length,
  };
  opts.onProgress?.({ kind: "start", total, pages: totals.pages, databases: totals.databases });

  const pool = createPool(opts.concurrency ?? 4);
  let completed = 0;
  // Many linked views ("Ansicht: …") point at the SAME source data source.
  // Query each source once and share the full row set across every view that
  // reads it; per-view filtering to `rowOrder` happens after.
  const sourceRowsCache = new Map<string, Promise<unknown[]>>();
  const sourceRows = (dataSourceId: string) => {
    let p = sourceRowsCache.get(dataSourceId);
    if (!p) {
      p = queryDataSourceRows(opts.notion, dataSourceId);
      sourceRowsCache.set(dataSourceId, p);
    }
    return p;
  };

  await Promise.all(
    opts.objects.map((obj) =>
      pool.run(async () => {
        try {
          if (obj.object === "page") {
            const data = await fetchPageFull(opts.notion, obj.id, opts.blocksCache?.get(obj.id));
            await opts.onPage({ id: obj.id, title: obj.title, ...data });
            counts.pages++;
            completed++;
            opts.onProgress?.({ kind: "page", done: completed, total, title: obj.title });
          } else {
            const data = await fetchDatabaseFull(opts.notion, obj.id);
            // Fetch the schema for the first data source attached to this
            // database. Most databases have exactly one; for multi-
            // source DBs we persist the primary source's schema (matches the
            // renderer's existing first-source-wins convention for views).
            // The cache de-dupes across databases that share a data source.
            let dataSource: DataSourceSchema | undefined;
            const primaryId = data.dataSourceIds[0];
            if (primaryId && opts.dataSourceSchema) {
              dataSource = await opts.dataSourceSchema(primaryId);
            }
            // Resolve every view (layout + group-by + filtered/sorted row
            // order). Best-effort: `[]` leaves the renderer on its heuristics.
            const views = opts.allViews ? await opts.allViews(obj.id) : [];
            // Linked-view rescue: the inline block exposes no data source of its
            // own (`data_sources: []` → zero rows), but the views point at the
            // real source. Query it once, keep only the rows ANY view shows
            // (union of every view's rowOrder), and hydrate its schema too.
            let rows = data.rows;
            const srcId = views.find((v) => v.view.dataSourceId)?.view.dataSourceId;
            if (rows.length === 0 && data.dataSourceIds.length === 0 && srcId) {
              const union = [...new Set(views.flatMap((v) => v.rowOrder))];
              rows = filterRowsToOrder(await sourceRows(srcId), union);
              if (!dataSource && opts.dataSourceSchema)
                dataSource = await opts.dataSourceSchema(srcId);
            }
            await opts.onDatabase({
              id: obj.id,
              title: obj.title,
              database: data.database,
              rows,
              ...(dataSource ? { dataSource } : {}),
              ...(views.length ? { views } : {}),
            });
            counts.databases++;
            completed++;
            opts.onProgress?.({
              kind: "database",
              done: completed,
              total,
              title: obj.title,
              rows: rows.length,
            });
          }
        } catch (err) {
          counts.errors++;
          completed++;
          const message = (err as Error).message;
          opts.log.error({ id: obj.id, err: message }, "failed to export object");
          opts.onProgress?.({ kind: "error", done: completed, total, id: obj.id, message });
        }
      }),
    ),
  );

  opts.onProgress?.({ kind: "done", counts });
  return counts;
}
