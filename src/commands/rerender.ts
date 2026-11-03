import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { createAssetCollector } from "../export/assets.js";
import { finalizeSite } from "../export/finalizeAssets.js";
import type { SitemapEntry } from "../export/html.js";
import { RAW_DATABASES, RAW_PAGES } from "../export/json.js";
import { findLatestExport, type Manifest, readManifest } from "../export/manifest.js";
import { formatProp } from "../export/markdown.js";
import { buildPaths, type ExportPaths, relUrl, safeSegment } from "../export/paths.js";
import {
  type DbData,
  type DocRef,
  type RawPageInput,
  type RenderContext,
  renderDatabase,
  renderPage,
} from "../export/pipeline.js";
import { plainText, type SearchDoc } from "../export/searchIndex.js";
import { enrichTitleHtml } from "../export/titleHtml.js";
import { markSnapshotVerified, verifiedMaintenanceInventory } from "../export/verifiedSnapshot.js";
import { acquireWriterLock } from "../export/writerLock.js";
import type { Logger } from "../logger.js";
import { type NotionBlock, walkBlocks } from "../notion/blocks.js";
import { fetchCustomEmojis } from "../notion/customEmojis.js";
import { validateDataSourceSchema } from "../notion/dataSourceSchema.js";
import { type NotionMediaPayload, resolveArchiveIcon, sitemapIconFromObj } from "../notion/meta.js";
import { normalizeViews } from "../notion/views.js";
import { readDirSafe, readFileWithinRootAsync } from "../util/fs.js";
import { createPool } from "../util/pool.js";

export interface RerenderOptions {
  exportRoot?: string;
}

export interface RerenderResult {
  exportRoot: string;
  pages: number;
  databases: number;
}

type RawPage = {
  page: PagePayload | null;
  blocks: NotionBlock[];
  comments?: import("../notion/comments.js").NotionComment[];
};
// `dataSource` is the schema retrieved from
// `notion.dataSources.retrieve` during the original export. Older exports
// won't have it — the renderer treats `undefined` as "fall back to legacy
// heuristics" so loading is best-effort.
type RawDatabase = {
  database: DatabasePayload | null;
  rows: RowPayload[];
  dataSource?: import("../notion/dataSourceSchema.js").DataSourceSchema;
  // Persisted views (Views API): new `views[]` shape, or legacy single
  // `view`/`rowOrder` — `normalizeViews` accepts both and validates each.
  // Older exports lack all of them — renderer falls back to heuristics.
  views?: unknown;
  view?: unknown;
  rowOrder?: unknown;
};
type ParentPayload = {
  type?: string;
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  block_id?: string;
};
type PagePayload = {
  id?: string;
  icon?: NotionMediaPayload;
  cover?: NotionMediaPayload;
  properties?: Record<string, unknown>;
  parent?: ParentPayload;
} | null;
type DatabasePayload = {
  id?: string;
  icon?: NotionMediaPayload;
  cover?: NotionMediaPayload;
  title?: Array<{ plain_text?: string }>;
  parent?: ParentPayload;
} | null;
type RowPayload = {
  id?: string;
  icon?: NotionMediaPayload;
  cover?: NotionMediaPayload;
  properties?: Record<string, unknown>;
};

// Mirror of crawl.ts normalizeParent — derive the canonical parent id from a
// raw Notion parent object. Data-source rows map to their containing database.
function resolveParentId(parent: ParentPayload | undefined): string | undefined {
  if (!parent) return undefined;
  if (parent.type === "page_id") return parent.page_id;
  if (parent.type === "database_id") return parent.database_id;
  if (parent.type === "data_source_id") return parent.database_id;
  if (parent.type === "block_id") return parent.block_id;
  return undefined;
}

// --- Phase: load raw page/db JSON -------------------------------------------
async function loadRawData(
  paths: ExportPaths,
): Promise<{ rawPageById: Map<string, RawPage>; rawDbById: Map<string, RawDatabase> }> {
  const pageFiles = (await readDirSafe(path.join(paths.raw, RAW_PAGES))).filter((f) =>
    f.endsWith(".json"),
  );
  const dbFiles = (await readDirSafe(path.join(paths.raw, RAW_DATABASES))).filter((f) =>
    f.endsWith(".json"),
  );
  const pool = createPool(24);
  const rawPageById = new Map<string, RawPage>();
  const rawDbById = new Map<string, RawDatabase>();
  await Promise.all([
    Promise.all(
      pageFiles.map((f) =>
        pool.run(async () => {
          // Read via O_NOFOLLOW + realpath in one helper so a symlink swap
          // can't race between gate and read. Helper expects
          // ROOT-RELATIVE candidates ("raw/pages/foo.json"), not CWD-relative
          // ("./exports/<ts>/…") — otherwise path.resolve(absRoot, cwdRel)
          // doubles the export-dir segment and every read silently ENOENTs.
          const data = JSON.parse(
            await readFileWithinRootAsync(paths.root, path.join("raw", RAW_PAGES, f)),
          ) as RawPage;
          if (data.page?.id) rawPageById.set(data.page.id, data);
        }),
      ),
    ),
    Promise.all(
      dbFiles.map((f) =>
        pool.run(async () => {
          const data = JSON.parse(
            await readFileWithinRootAsync(paths.root, path.join("raw", RAW_DATABASES, f)),
          ) as RawDatabase;
          if (data.database?.id) rawDbById.set(data.database.id, data);
        }),
      ),
    ),
  ]);
  return { rawPageById, rawDbById };
}

// --- Phase: fused rerender index build --------------------------------------
// Single DFS per page that produces both setup indexes the rerender phase
// needs before it starts rendering:
//   • positionById         — sidebar order for child_page/child_database
//   • childPageParents     — child_page/child_database block id → owner pages
//   • blockContainers      — every block id → owner pages
//
// One fused walk rather than two independent ones. For 900 pages × ~200 blocks deep that's ~376k
// visits — fusing collapses it to ~190k.
//
// The custom-emoji harvest is intentionally NOT folded in here — it lives in
// `src/notion/customEmojis.ts` so the export command can share it. Keeping
// it external avoids re-walking the block tree from inside that helper while
// still letting both call sites use the same code path.
export interface RerenderIndexes {
  positionById: Map<string, number>;
  childPageParents: Map<string, Set<string>>;
  blockContainers: Map<string, Set<string>>;
}

export function buildRerenderIndexes(rawPageById: Map<string, RawPage>): RerenderIndexes {
  const positionById = new Map<string, number>();
  const childPageParents = new Map<string, Set<string>>();
  const blockContainers = new Map<string, Set<string>>();

  const addContainer = (map: Map<string, Set<string>>, key: string, val: string): void => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(val);
  };

  for (const [containerId, data] of rawPageById) {
    // Pre-order DFS over the block tree matches the user-visible
    // top-to-bottom Notion sequence; `nextPosition` tracks the child slot
    // within this container so `positionById` ends up identical to the old
    // per-parent assignment.
    let nextPosition = 0;
    for (const b of walkBlocks(data.blocks ?? [])) {
      if (b.id) addContainer(blockContainers, b.id, containerId);
      if (b.type === "child_page" || b.type === "child_database") {
        addContainer(childPageParents, b.id, containerId);
        // First-wins across containers preserves the original parent's
        // ordering when the same page appears via synced blocks.
        if (!positionById.has(b.id)) positionById.set(b.id, nextPosition);
        nextPosition++;
      }
    }
  }

  return { positionById, childPageParents, blockContainers };
}

// Authoritative parent resolution per page (multi-parent aware):
//   1. Manifest's `parentId` (recent exports populate it)
//   2. page.parent.block_id → blockContainers (prefer deepest candidate)
//   3. childPageParents (same preference rule)
//   4. Raw page.parent.type === "page_id"/"database_id"
//
// Depth = distance from workspace root. We use it to pick the deepest
// candidate parent when a block id appears on multiple pages (Notion syncs
// the block + everything below it into each ancestor's block tree).
export function makeAuthoritativeParent(
  rawPageById: Map<string, RawPage>,
  childPageParents: Map<string, Set<string>>,
  blockContainers: Map<string, Set<string>>,
): (id: string, raw: PagePayload | DatabasePayload) => string | undefined {
  const depthCache = new Map<string, number>();
  // A5 (correctness): only cache results whose entire recursive subtree
  // completed without a cycle bail-out. The previous shape unconditionally
  // wrote `depthCache.set(id, d)` even when a recursive call returned 0
  // because `seen.has(cand)` short-circuited inside the loop — that 0 is
  // local to one traversal's `seen` set; a later non-cyclic re-entry would
  // read the cached 0 and miscompute downstream depths. Mirrors
  // `buildHierarchy` in export.ts ("don't cache partial cycle answers").
  function depthOf(id: string, seen: Set<string> = new Set()): { depth: number; cycle: boolean } {
    const cached = depthCache.get(id);
    if (cached !== undefined) return { depth: cached, cycle: false };
    // Local cycle break: a recursion already in flight reached `id` again.
    // Returning `cycle: true` propagates "don't cache" up the chain.
    if (seen.has(id)) return { depth: 0, cycle: true };
    seen.add(id);
    const raw = rawPageById.get(id)?.page ?? null;
    const rp = raw?.parent;
    let parentId: string | undefined;
    let cycle = false;
    if (rp?.type === "block_id" && rp.block_id) {
      // Among candidate owners of the wrapping block, pick the deepest one
      // that's not the page itself — keeps recursion stable.
      const owners = blockContainers.get(rp.block_id);
      if (owners) {
        let bestId: string | undefined;
        let bestDepth = -1;
        for (const cand of owners) {
          if (cand === id || seen.has(cand)) continue;
          const sub = depthOf(cand, seen);
          if (sub.cycle) cycle = true;
          if (sub.depth > bestDepth) {
            bestId = cand;
            bestDepth = sub.depth;
          }
        }
        parentId = bestId;
      }
    } else {
      parentId = resolveParentId(rp);
    }
    if (!parentId || !rawPageById.has(parentId)) {
      if (!cycle) depthCache.set(id, 0);
      return { depth: 0, cycle };
    }
    const sub = depthOf(parentId, seen);
    const d = sub.depth + 1;
    const subCycle = cycle || sub.cycle;
    if (!subCycle) depthCache.set(id, d);
    return { depth: d, cycle: subCycle };
  }
  function pickContainer(set: Set<string> | undefined, excludeId: string): string | undefined {
    if (!set || set.size === 0) return undefined;
    let best: string | undefined;
    let bestDepth = -1;
    for (const candidate of set) {
      if (candidate === excludeId) continue;
      const { depth: d } = depthOf(candidate);
      if (d > bestDepth) {
        best = candidate;
        bestDepth = d;
      }
    }
    return best;
  }
  return (id, raw) => {
    const rp = raw?.parent;
    if (rp?.type === "block_id" && rp.block_id) {
      const owner = pickContainer(blockContainers.get(rp.block_id), id);
      if (owner) return owner;
    }
    const childOwner = pickContainer(childPageParents.get(id), id);
    if (childOwner) return childOwner;
    return resolveParentId(rp);
  };
}

// --- Phase: build the corrected pageIndex -----------------------------------
type Info = { id: string; kind: "page" | "database"; title: string; parentId?: string };

function buildPageIndex(
  manifest: Manifest,
  paths: ExportPaths,
  rawPageById: Map<string, RawPage>,
  rawDbById: Map<string, RawDatabase>,
  authoritativeParent: (id: string, raw: PagePayload | DatabasePayload) => string | undefined,
): { pageIndex: Map<string, DocRef>; infoById: Map<string, Info> } {
  // Pull titles from manifest (single source of truth). Derive each entry's
  // canonical parent id via the page's own raw parent (authoritative).
  const infoById = new Map<string, Info>();
  for (const e of manifest.entries) {
    const raw: PagePayload | DatabasePayload =
      e.kind === "page"
        ? (rawPageById.get(e.id)?.page ?? null)
        : (rawDbById.get(e.id)?.database ?? null);
    // Trust the manifest's parentId only when it names a real page/db. Older
    // exports mistakenly stored a raw `parent.block_id` (a *block* id, e.g. a
    // callout/column wrapping a child page), which matches no entry and would
    // orphan the page to the root. Fall back to the authoritative resolver,
    // which maps block_id -> the owning container page.
    const trustedParent =
      e.parentId && (rawPageById.has(e.parentId) || rawDbById.has(e.parentId))
        ? e.parentId
        : undefined;
    const parentId = trustedParent ?? authoritativeParent(e.id, raw);
    infoById.set(e.id, {
      id: e.id,
      kind: e.kind,
      title: e.title,
      ...(parentId ? { parentId } : {}),
    });
  }

  // Walk parent chain → directory under markdown/html root. Drops parents
  // that aren't themselves in infoById (e.g. workspace, missing dbs).
  const subdirCache = new Map<string, string>();
  const resolvingSubdir = new Set<string>();
  function resolveSubdir(id: string): string {
    const cached = subdirCache.get(id);
    if (cached !== undefined) return cached;
    if (resolvingSubdir.has(id)) return "";
    resolvingSubdir.add(id);
    const info = infoById.get(id);
    if (!info?.parentId) {
      subdirCache.set(id, "");
      resolvingSubdir.delete(id);
      return "";
    }
    const parent = infoById.get(info.parentId);
    if (!parent) {
      subdirCache.set(id, "");
      resolvingSubdir.delete(id);
      return "";
    }
    const parentSubdir = resolveSubdir(parent.id);
    const dir = path.join(parentSubdir, safeSegment(parent.title));
    subdirCache.set(id, dir);
    resolvingSubdir.delete(id);
    return dir;
  }

  const pageIndex = new Map<string, DocRef>();
  for (const info of infoById.values()) {
    const subdir = resolveSubdir(info.id);
    const filename = `${safeSegment(info.title)}.${info.id}.md`;
    const mdAbsPath = path.join(paths.markdown, subdir, filename);
    pageIndex.set(info.id, {
      id: info.id,
      title: info.title,
      kind: info.kind,
      mdAbsPath,
      subdir,
      ...(info.parentId ? { parentId: info.parentId } : {}),
    });
  }
  return { pageIndex, infoById };
}

export async function runRerender(
  cfg: Config,
  log: Logger,
  opts: RerenderOptions = {},
): Promise<RerenderResult> {
  const lock = await acquireWriterLock(cfg.io.outDir);
  try {
    await lock.write({ operation: "rerender" });
    return await rerenderLocked(cfg, log, opts);
  } finally {
    await lock.release();
  }
}

async function rerenderLocked(
  cfg: Config,
  log: Logger,
  opts: RerenderOptions,
): Promise<RerenderResult> {
  const exportRoot = opts.exportRoot ?? (await findLatestExport(cfg.io.outDir));
  if (!exportRoot) throw new Error("no export found to rerender");
  log.info({ exportRoot }, "rerender: target");

  const paths = buildPaths(cfg.io.outDir, path.basename(exportRoot));

  const manifest = await readManifest(paths.manifest, { log });
  if (!manifest) throw new Error(`failed to read manifest at ${paths.manifest}`);
  const verifiedBefore = await verifiedMaintenanceInventory(paths.root);

  // Asset collector for the one thing rerender *does* download: static Notion
  // custom-emoji icons hosted on public.notion-static.com. These URLs are not
  // signed and don't expire, so no API call is needed to refresh them.
  const assets = createAssetCollector({
    assetsDir: paths.assets,
    exportRoot: paths.root,
    log,
    concurrency: cfg.io.assetConcurrency,
  });
  // Cache-once: a URL EXPORT_ICON becomes a local `assets/<hash>.png` path so
  // the sidebar's workspace icon works offline.
  const archiveIcon =
    (await resolveArchiveIcon(cfg.render.exportIcon, (u) => assets.collect(u))) ??
    cfg.render.exportIcon;

  // Load all raw pages + databases into memory once. We need the full set
  // before we can resolve hierarchy + icons + custom emojis.
  const { rawPageById, rawDbById } = await loadRawData(paths);

  // Single DFS per page produces sidebar position + container indexes.
  const { positionById, childPageParents, blockContainers } = buildRerenderIndexes(rawPageById);
  const authoritativeParent = makeAuthoritativeParent(
    rawPageById,
    childPageParents,
    blockContainers,
  );
  const { pageIndex, infoById } = buildPageIndex(
    manifest,
    paths,
    rawPageById,
    rawDbById,
    authoritativeParent,
  );

  const customEmojiByName = await fetchCustomEmojis(rawPageById.values(), assets, log);

  // Variant for sitemap entries: the rendered sidebar HTML is shared across
  // every page (different depths), so we emit root-relative `assets/<hash>`
  // paths and let injectSidebars rewrite them per page.
  //
  // A3 (security): escape the WHOLE title FIRST, then swap escaped `:slug:`
  // matches for the `<img>` injection. The whole-title escape + url-escape
  // invariants live in `enrichTitleHtml`; this wrapper just curries the
  // custom-emoji map and uses identity for `resolveSrc` (root-relative).
  function enrichTitleRootRelative(title: string): string {
    return enrichTitleHtml(title, customEmojiByName);
  }

  // Clear existing markdown + html so we don't leave orphan files at old
  // hierarchy locations from the previous render. Asset/raw dirs are kept.
  await fsp.rm(paths.markdown, { recursive: true, force: true });
  await fsp.rm(paths.html, { recursive: true, force: true });

  const sitemap: SitemapEntry[] = [];
  const searchDocs: SearchDoc[] = [];
  // Semantics: `exportTimestamp` is the wall-clock time at which the rendered
  // HTML was last produced. Rerender re-emits every page now, so the footer
  // and sitemap stamp reflect *this* run — not the original export. The
  // manifest's `timestamp` is updated to match below so the on-disk shape
  // stays consistent. See CLAUDE.md "Invariants" for the contract.
  const exportTimestamp = new Date().toISOString();
  manifest.timestamp = exportTimestamp;

  // Adapt rawDbById to the pipeline's DbData shape (compatible — both have
  // `database` and `rows`; the pipeline tolerates `title` being absent).
  const dbDataById = new Map<string, DbData>();
  let dbsWithSchema = 0;
  let dbsWithView = 0;
  for (const [id, raw] of rawDbById) {
    if (!raw.database) continue;
    // Forward the persisted data-source schema into `DbData` so the
    // renderer can read it via `dbDataById`. Backward compat: legacy raws
    // have no `dataSource` field — entry is set without it and renderer
    // falls back to heuristics.
    //
    // Defense-in-depth: the raw JSON is operator-untrusted (a member could
    // hand-edit it). Validate the shape before threading into the
    // renderer; on rejection drop the schema and fall back to heuristics.
    const validatedDs = raw.dataSource ? validateDataSourceSchema(raw.dataSource, id, log) : null;
    if (validatedDs) dbsWithSchema++;
    // Normalize + validate the persisted views (new `views[]` or legacy single
    // `view`/`rowOrder`). Operator-untrusted raw JSON — `normalizeViews`
    // validates each entry and drops malformed ones.
    const views = normalizeViews(raw, log);
    if (views.length) dbsWithView++;
    dbDataById.set(id, {
      database: raw.database,
      rows: raw.rows ?? [],
      ...(validatedDs ? { dataSource: validatedDs } : {}),
      ...(views.length ? { views } : {}),
    } as DbData);
  }
  if (dbsWithView === 0 && rawDbById.size > 0) {
    log.info(
      { databases: rawDbById.size },
      "rerender: no views on disk (legacy export); renderer will use heuristics",
    );
  }
  if (dbsWithSchema === 0 && rawDbById.size > 0) {
    log.info(
      { databases: rawDbById.size },
      "rerender: no data-source schemas on disk (legacy export); renderer will use heuristics",
    );
  } else if (dbsWithSchema < rawDbById.size) {
    log.info(
      { withSchema: dbsWithSchema, total: rawDbById.size },
      "rerender: some databases lack a data-source schema",
    );
  }

  // Walk the parent chain to build the ancestor list for breadcrumbs. Stops
  // at the first parent that isn't itself in pageIndex (workspace, missing).
  //
  // Memoised by id: ancestor chains overlap heavily across siblings —
  // without the cache a 941-page workspace × avg depth 5 walks the parent
  // chain ~4.7k times, each pass allocating a fresh array + Set. Mirrors
  // `html.ts:applyActiveMarkers`/`injectSidebars`'s `ancestorCache`.
  const ancestorCache = new Map<string, string[]>();
  function ancestorChain(id: string): string[] {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const out: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = pageIndex.get(id)?.parentId;
    while (cursor && pageIndex.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      out.unshift(cursor);
      cursor = pageIndex.get(cursor)?.parentId;
    }
    ancestorCache.set(id, out);
    return out;
  }

  // Wrap rawPageById in the pipeline's RawPageInput shape so the resolveLink
  // closure can look up icons on link targets (titles get the icon glyph next
  // to the link).
  const rawPageByIdForPipeline = new Map<string, RawPageInput>();
  for (const [id, raw] of rawPageById) {
    const info = infoById.get(id);
    if (!info || !raw.page) continue;
    rawPageByIdForPipeline.set(id, {
      id,
      title: info.title,
      page: raw.page,
      blocks: raw.blocks ?? [],
    });
  }

  // Pre-resolve per-target icons so `pipeline.iconForLink` short-circuits to
  // an O(1) Map.get instead of re-running `rebuildIconMeta` per outbound link.
  // Mirrors `runExport`'s `prefetchPageIcons` (built from `o.icon`).
  const pageIcons = new Map<
    string,
    { kind: "emoji"; value: string } | { kind: "image"; localPath: string }
  >();
  function recordIcon(id: string, icon: NotionMediaPayload): void {
    if (!icon) return;
    if (icon.type === "emoji" && icon.emoji) {
      pageIcons.set(id, { kind: "emoji", value: icon.emoji });
      return;
    }
    const lp = icon.file?.local_path ?? icon.external?.local_path;
    if (lp) pageIcons.set(id, { kind: "image", localPath: lp });
  }
  for (const [id, raw] of rawPageById) {
    recordIcon(id, raw.page?.icon ?? null);
  }
  for (const [id, raw] of rawDbById) {
    recordIcon(id, raw.database?.icon ?? null);
  }

  const ctx: RenderContext = {
    paths,
    pageIndex,
    dbDataById,
    customEmojiByName,
    archiveIcon,
    archiveTitle: cfg.render.exportTitle,
    cfg,
    assets,
    log,
    exportTimestamp,
    ancestorIds: ancestorChain,
    pageIcons,
  };

  const { pages, databases } = await renderAll({
    ctx,
    rawPageById,
    rawDbById,
    pageIndex,
    rawPageByIdForPipeline,
    sitemap,
    searchDocs,
    positionById,
    enrichTitle: enrichTitleRootRelative,
    authoritativeParent,
    paths,
  });

  // Stylesheet + sitemap + sidebar + search are rebuilt fully.
  await finalizeSite({
    htmlDir: paths.html,
    rawDir: paths.raw,
    sitemap,
    searchDocs,
    timestamp: exportTimestamp,
    archiveTitle: cfg.render.exportTitle,
    archiveIcon,
    // Persist the refreshed `timestamp` (set above to `exportTimestamp`) so the
    // on-disk manifest matches what the HTML footer/sitemap report. We don't
    // re-shape `entries`/`assets` — only the top-level timestamp changes.
    persistManifest: async () => {
      await fsp.writeFile(paths.manifest, JSON.stringify(manifest, null, 2));
      return manifest;
    },
  });

  if (verifiedBefore) {
    await markSnapshotVerified(
      paths.root,
      verifiedBefore.entries.map((e) => ({ id: e.id, object: e.kind })),
      0,
      verifiedBefore,
    );
  }

  log.info({ pages, databases }, "rerender: complete");
  return { exportRoot, pages, databases };
}

// --- Phase: render loop -----------------------------------------------------
interface RenderAllArgs {
  ctx: RenderContext;
  rawPageById: Map<string, RawPage>;
  rawDbById: Map<string, RawDatabase>;
  pageIndex: Map<string, DocRef>;
  rawPageByIdForPipeline: Map<string, RawPageInput>;
  sitemap: SitemapEntry[];
  searchDocs: SearchDoc[];
  positionById: Map<string, number>;
  enrichTitle: (title: string) => string;
  authoritativeParent: (id: string, raw: PagePayload | DatabasePayload) => string | undefined;
  paths: ExportPaths;
}

async function renderAll(args: RenderAllArgs): Promise<{ pages: number; databases: number }> {
  const {
    ctx,
    rawPageById,
    rawDbById,
    pageIndex,
    rawPageByIdForPipeline,
    sitemap,
    searchDocs,
    positionById,
    enrichTitle,
    authoritativeParent,
    paths,
  } = args;
  // Pool=24 matches `injectSidebars` — the workload is CPU + small fs writes,
  // not network-bound. PAGE_CONCURRENCY defaults to 4 (sized for Notion API
  // concurrency, not local rendering), so we don't reuse it here.
  const pool = createPool(24);

  // Index → ordered slots so the sitemap matches insertion order of the
  // source Map even though renders complete out of order. Keeping the order
  // stable preserves deterministic output for snapshot-based tests.
  const pageEntries = [...rawPageById];
  const pageSitemap = new Array<SitemapEntry | null>(pageEntries.length).fill(null);
  const pageSearch = new Array<SearchDoc | null>(pageEntries.length).fill(null);
  let pages = 0;
  await Promise.all(
    pageEntries.map(([id, data], idx) =>
      pool.run(async () => {
        const self = pageIndex.get(id);
        if (!self || !data.page) return;
        const raw: RawPageInput = {
          id,
          title: self.title,
          page: data.page,
          blocks: data.blocks ?? [],
          comments: data.comments ?? [],
        };
        const rendered = await renderPage(ctx, raw, {
          formatProp,
          rawPageById: rawPageByIdForPipeline,
        });
        if (!rendered) return;
        const htmlRel = relUrl(paths.html, rendered.htmlAbs);
        pageSitemap[idx] = {
          id,
          title: self.title,
          titleHtml: enrichTitle(self.title),
          href: htmlRel,
          kind: "page",
          parentId: self.parentId ?? authoritativeParent(id, data.page),
          icon: sitemapIconFromObj(data.page),
          ...(positionById.has(id) ? { position: positionById.get(id) } : {}),
        };
        pageSearch[idx] = {
          id,
          title: self.title,
          body: plainText(rendered.md),
          href: htmlRel,
          kind: "page",
        };
        pages++;
      }),
    ),
  );

  const dbEntries = [...rawDbById];
  const dbSitemap = new Array<SitemapEntry | null>(dbEntries.length).fill(null);
  const dbSearch = new Array<SearchDoc | null>(dbEntries.length).fill(null);
  let databases = 0;
  await Promise.all(
    dbEntries.map(([id, data], idx) =>
      pool.run(async () => {
        const self = pageIndex.get(id);
        if (!self || !data.database) return;
        // Normalize + validate the persisted views (operator-untrusted raw
        // JSON) before they reach the renderer. Mirrors the dbDataById guard.
        const views = normalizeViews(data, ctx.log);
        const rendered = await renderDatabase(ctx, {
          id,
          title: self.title,
          database: data.database,
          rows: data.rows,
          ...(data.dataSource ? { dataSource: data.dataSource } : {}),
          ...(views.length ? { views } : {}),
        });
        if (!rendered) return;
        const htmlRel = relUrl(paths.html, rendered.htmlAbs);
        dbSitemap[idx] = {
          id,
          title: self.title,
          titleHtml: enrichTitle(self.title),
          href: htmlRel,
          kind: "database",
          parentId: self.parentId ?? authoritativeParent(id, data.database),
          icon: sitemapIconFromObj(data.database),
          ...(positionById.has(id) ? { position: positionById.get(id) } : {}),
        };
        dbSearch[idx] = {
          id,
          title: self.title,
          body: plainText(rendered.md),
          href: htmlRel,
          kind: "database",
        };
        databases++;
      }),
    ),
  );

  for (const entry of pageSitemap) if (entry) sitemap.push(entry);
  for (const doc of pageSearch) if (doc) searchDocs.push(doc);
  for (const entry of dbSitemap) if (entry) sitemap.push(entry);
  for (const doc of dbSearch) if (doc) searchDocs.push(doc);

  return { pages, databases };
}
