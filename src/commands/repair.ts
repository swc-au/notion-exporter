import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { requireToken } from "../config.js";
import { createAssetCollector } from "../export/assets.js";
import { finalizeSite } from "../export/finalizeAssets.js";
import type { SitemapEntry } from "../export/html.js";
import { RAW_DATABASES, RAW_PAGES } from "../export/json.js";
import {
  findLatestExport,
  type Manifest,
  readManifest,
  writeManifest,
} from "../export/manifest.js";
import { formatProp } from "../export/markdown.js";
import { buildPaths, type ExportPaths } from "../export/paths.js";
import {
  type DbData,
  type DocRef,
  type RawDatabaseInput,
  type RawPageInput,
  type RenderContext,
  renderDatabase,
  renderPage,
} from "../export/pipeline.js";
import { plainText, readSearchBodies, type SearchDoc } from "../export/searchIndex.js";
import { enrichTitleHtml } from "../export/titleHtml.js";
import { markSnapshotVerified, verifiedMaintenanceInventory } from "../export/verifiedSnapshot.js";
import type { Logger } from "../logger.js";
import { FILE_BLOCK_TYPES, type NotionBlock, walkBlocks } from "../notion/blocks.js";
import { RateLimitedNotion } from "../notion/client.js";
import { fetchCustomEmojis } from "../notion/customEmojis.js";
import { validateDataSourceSchema } from "../notion/dataSourceSchema.js";
import { type NotionMediaPayload, resolveArchiveIcon, sitemapIconFromObj } from "../notion/meta.js";
import { normalizeViews } from "../notion/views.js";
import {
  assertWithinRoot,
  readDirSafe,
  readFileWithinRootAsync,
  readFileWithinRootAsyncWithPath,
} from "../util/fs.js";
import { createPool } from "../util/pool.js";

export interface RepairOptions {
  exportRoot?: string;
}

export interface RepairResult {
  exportRoot: string;
  scanned: number;
  refreshed: number;
  stillFailing: number;
}

interface RawPage {
  page: {
    id?: string;
    icon?: NotionMediaPayload;
    cover?: NotionMediaPayload;
    properties?: Record<string, unknown>;
  } | null;
  blocks: NotionBlock[];
  comments?: import("../notion/comments.js").NotionComment[];
}

interface RawDatabase {
  database: {
    id?: string;
    icon?: NotionMediaPayload;
    cover?: NotionMediaPayload;
  } | null;
  rows: Array<{
    id?: string;
    icon?: NotionMediaPayload;
    cover?: NotionMediaPayload;
  }>;
  // Optional data-source schema persisted by the exporter. Repair doesn't
  // refresh it — it round-trips whatever's on disk, so loaders just need
  // to know about the field.
  dataSource?: import("../notion/dataSourceSchema.js").DataSourceSchema;
  // Persisted views (Views API): new `views[]` or legacy single
  // `view`/`rowOrder`. Round-tripped like `dataSource`; `normalizeViews`
  // accepts both and validates before the renderer reads them.
  views?: unknown;
  view?: unknown;
  rowOrder?: unknown;
}

type AssetCollector = ReturnType<typeof createAssetCollector>;

function localPathOf(p: NotionMediaPayload): string | undefined {
  return p?.file?.local_path ?? p?.external?.local_path;
}
function urlOf(p: NotionMediaPayload): string | undefined {
  return p?.file?.url ?? p?.external?.url;
}

function blockFileUrl(b: NotionBlock): { url?: string; localPath?: string } | null {
  if (!FILE_BLOCK_TYPES.has(b.type)) return null;
  const payload = b[b.type] as NotionMediaPayload | undefined;
  if (!payload) return null;
  return { url: urlOf(payload), localPath: localPathOf(payload) };
}

// Apply a `local_path` mutation to whichever payload variant carries the URL.
function applyLocalPath(media: NotionMediaPayload, localPath: string): void {
  if (media?.file) media.file.local_path = localPath;
  if (media?.external) media.external.local_path = localPath;
}

// --- Phase: scan one raw page file ------------------------------------------
async function scanPage(
  filePath: string,
  data: RawPage,
  notion: RateLimitedNotion,
  assets: AssetCollector,
  log: Logger,
  stats: { scanned: number; refreshed: number },
): Promise<boolean> {
  let pageDirty = false;

  // page icon
  if (data.page?.icon && data.page.icon.type !== "emoji" && !localPathOf(data.page.icon)) {
    const url = urlOf(data.page.icon);
    if (url && data.page.id) {
      stats.scanned++;
      const localPath = await refreshAndDownload(assets, log, async () => {
        const fresh = (await notion.run((c) =>
          c.pages.retrieve({ page_id: data.page!.id as string }),
        )) as { icon?: NotionMediaPayload };
        if (fresh.icon?.type === "emoji") return null;
        const freshUrl = urlOf(fresh.icon ?? null);
        if (!freshUrl) return null;
        // mutate raw so future renders see the new URL
        if (data.page!.icon?.file && fresh.icon?.file?.url)
          data.page!.icon.file.url = fresh.icon.file.url;
        if (data.page!.icon?.external && fresh.icon?.external?.url)
          data.page!.icon.external.url = fresh.icon.external.url;
        return freshUrl;
      });
      if (localPath) {
        applyLocalPath(data.page.icon, localPath);
        stats.refreshed++;
        pageDirty = true;
      }
    }
  }
  // page cover
  if (data.page?.cover && !localPathOf(data.page.cover)) {
    const url = urlOf(data.page.cover);
    if (url && data.page.id) {
      stats.scanned++;
      const localPath = await refreshAndDownload(assets, log, async () => {
        const fresh = (await notion.run((c) =>
          c.pages.retrieve({ page_id: data.page!.id as string }),
        )) as { cover?: NotionMediaPayload };
        const freshUrl = urlOf(fresh.cover ?? null);
        if (!freshUrl) return null;
        if (data.page!.cover?.file && fresh.cover?.file?.url)
          data.page!.cover.file.url = fresh.cover.file.url;
        if (data.page!.cover?.external && fresh.cover?.external?.url)
          data.page!.cover.external.url = fresh.cover.external.url;
        return freshUrl;
      });
      if (localPath) {
        applyLocalPath(data.page.cover, localPath);
        stats.refreshed++;
        pageDirty = true;
      }
    }
  }
  // media blocks
  for (const b of walkBlocks(data.blocks ?? [])) {
    const info = blockFileUrl(b);
    if (!info || info.localPath || !info.url) continue;
    stats.scanned++;
    const localPath = await refreshAndDownload(assets, log, async () => {
      const fresh = (await notion.run((c) => c.blocks.retrieve({ block_id: b.id }))) as NotionBlock;
      const freshInfo = blockFileUrl(fresh);
      if (!freshInfo?.url) return null;
      // mutate in-place
      const blockPayload = b[b.type] as NotionMediaPayload | undefined;
      const freshPayload = fresh[fresh.type] as NotionMediaPayload | undefined;
      if (blockPayload?.file && freshPayload?.file?.url)
        blockPayload.file.url = freshPayload.file.url;
      if (blockPayload?.external && freshPayload?.external?.url)
        blockPayload.external.url = freshPayload.external.url;
      return freshInfo.url;
    });
    if (localPath) {
      const payload = b[b.type] as NotionMediaPayload | undefined;
      if (payload) applyLocalPath(payload, localPath);
      stats.refreshed++;
      pageDirty = true;
    }
  }

  if (pageDirty) {
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
  }
  return pageDirty;
}

// --- Phase: scan one raw database file --------------------------------------
async function scanDatabase(
  filePath: string,
  data: RawDatabase,
  notion: RateLimitedNotion,
  assets: AssetCollector,
  log: Logger,
  stats: { scanned: number; refreshed: number },
): Promise<boolean> {
  let dbDirty = false;
  for (const row of data.rows ?? []) {
    for (const which of ["cover", "icon"] as const) {
      const media = row[which];
      if (!media || media.type === "emoji" || localPathOf(media)) continue;
      const url = urlOf(media);
      if (!url || !row.id) continue;
      stats.scanned++;
      const localPath = await refreshAndDownload(assets, log, async () => {
        const fresh = (await notion.run((c) =>
          c.pages.retrieve({ page_id: row.id as string }),
        )) as { icon?: NotionMediaPayload; cover?: NotionMediaPayload };
        const freshUrl = urlOf(fresh[which] ?? null);
        if (!freshUrl) return null;
        if (media.file && fresh[which]?.file?.url) media.file.url = fresh[which]!.file!.url!;
        if (media.external && fresh[which]?.external?.url)
          media.external.url = fresh[which]!.external!.url!;
        return freshUrl;
      });
      if (localPath) {
        applyLocalPath(media, localPath);
        stats.refreshed++;
        dbDirty = true;
      }
    }
  }
  if (dbDirty) await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
  return dbDirty;
}

// --- Phase: scan + refresh all raws -----------------------------------------
async function scanAndRefreshAssets(
  paths: ExportPaths,
  notion: RateLimitedNotion,
  assets: AssetCollector,
  log: Logger,
): Promise<{
  scanned: number;
  refreshed: number;
  dirtyPages: Array<{ file: string; data: RawPage }>;
  dirtyDbs: Array<{ file: string; data: RawDatabase }>;
}> {
  const pageFiles = (await readDirSafe(path.join(paths.raw, RAW_PAGES))).filter((f) =>
    f.endsWith(".json"),
  );
  const dbFiles = (await readDirSafe(path.join(paths.raw, RAW_DATABASES))).filter((f) =>
    f.endsWith(".json"),
  );
  log.info({ pages: pageFiles.length, databases: dbFiles.length }, "repair: scanning raw");

  const stats = { scanned: 0, refreshed: 0 };
  const dirtyPages: Array<{ file: string; data: RawPage }> = [];
  const dirtyDbs: Array<{ file: string; data: RawDatabase }> = [];

  // Pool=24 parallelizes raw JSON read + scan; the inner Notion API calls are
  // already bounded by `RateLimitedNotion`, and asset downloads by the asset
  // collector. SSDs benefit from 8-16 in-flight reads.
  const pool = createPool(24);
  await Promise.all(
    pageFiles.map((fileName) =>
      pool.run(async () => {
        // Read via O_NOFOLLOW + realpath in one helper so a symlink swap
        // can't race between gate and read. Helper returns the
        // post-realpath path so the later writeback (`scanPage` → fsp.writeFile)
        // hits the same inode we just validated.
        const { path: filePath, data: raw } = await readFileWithinRootAsyncWithPath(
          paths.root,
          path.join("raw", RAW_PAGES, fileName),
        );
        const data = JSON.parse(raw) as RawPage;
        if (await scanPage(filePath, data, notion, assets, log, stats)) {
          dirtyPages.push({ file: filePath, data });
        }
      }),
    ),
  );
  await Promise.all(
    dbFiles.map((fileName) =>
      pool.run(async () => {
        const { path: filePath, data: raw } = await readFileWithinRootAsyncWithPath(
          paths.root,
          path.join("raw", RAW_DATABASES, fileName),
        );
        const data = JSON.parse(raw) as RawDatabase;
        if (await scanDatabase(filePath, data, notion, assets, log, stats)) {
          dirtyDbs.push({ file: filePath, data });
        }
      }),
    ),
  );

  log.info(
    {
      scanned: stats.scanned,
      refreshed: stats.refreshed,
      dirtyPages: dirtyPages.length,
      dirtyDbs: dirtyDbs.length,
    },
    "repair: assets refreshed",
  );
  return { ...stats, dirtyPages, dirtyDbs };
}

// --- Phase: rerender dirty + write manifest ---------------------------------
// Regenerate markdown + html for every page/db we touched. Build a pageIndex
// from the manifest so cross-page links + inline DB tables come back when we
// re-render — without it, repaired pages regress to bare page-link cards.
async function rerenderDirty(
  cfg: Config,
  log: Logger,
  paths: ExportPaths,
  manifest: Manifest,
  assets: AssetCollector,
  dirtyPages: Array<{ file: string; data: RawPage }>,
  dirtyDbs: Array<{ file: string; data: RawDatabase }>,
): Promise<{
  freshBodies: Map<string, string>;
  sitemap: SitemapEntry[];
  archiveIcon: string;
}> {
  // Capture each dirty page/db's rendered md in memory so collectSearchDocs
  // can skip the disk read for those entries.
  const freshBodies = new Map<string, string>();
  const pageIndex = new Map<string, DocRef>();
  for (const e of manifest.entries) {
    // Manifest stores rawPath as `raw/pages/<file>.json` — swap to markdown.
    const mdRel = e.rawPath
      .replace(/^raw\/pages\//, "markdown/")
      .replace(/^raw\/databases\//, "markdown/")
      .replace(/\.json$/, ".md");
    const mdAbsPath = assertWithinRoot(paths.root, mdRel);
    pageIndex.set(e.id, {
      id: e.id,
      title: e.title,
      kind: e.kind,
      mdAbsPath,
      subdir: path.relative(paths.markdown, path.dirname(mdAbsPath)),
      ...(e.parentId ? { parentId: e.parentId } : {}),
    });
  }

  // Pool for parallel raw I/O + render passes. Same pattern as rerender:
  // pool=24 matches injectSidebars and the export's per-page concurrency
  // ceiling; CPU + small fs writes, not network-bound.
  const pool = createPool(24);

  // Index of database id → loaded RawDatabase so we can rebuild inline gallery
  // views. Load lazily; most pages don't reference any DBs.
  const dbDataById = new Map<string, DbData>();
  const dbFiles = (await readDirSafe(path.join(paths.raw, RAW_DATABASES))).filter((f) =>
    f.endsWith(".json"),
  );
  await Promise.all(
    dbFiles.map((fileName) =>
      pool.run(async () => {
        const cached = JSON.parse(
          await readFileWithinRootAsync(paths.root, path.join("raw", RAW_DATABASES, fileName)),
        ) as RawDatabase;
        const id = cached.database?.id;
        if (!id) return;
        // v7-iter-8 (defense-in-depth): mirror rerender.ts — operator-untrusted
        // raw JSON may carry a malformed `dataSource` (hand-edited, partial
        // write, etc). Reject it before the renderer reads from `properties`.
        const validatedDs = cached.dataSource
          ? validateDataSourceSchema(cached.dataSource, id, log)
          : null;
        // Normalize + validate the persisted views (new `views[]` or legacy
        // single view/rowOrder). Drop the raw view fields from the spread.
        const views = normalizeViews(cached, log);
        const { dataSource: _rejected, views: _vs, view: _v, rowOrder: _ro, ...rest } = cached;
        void _rejected;
        void _vs;
        void _v;
        void _ro;
        dbDataById.set(id, {
          ...rest,
          ...(validatedDs ? { dataSource: validatedDs } : {}),
          ...(views.length ? { views } : {}),
        } as DbData);
      }),
    ),
  );
  // Newly written dirty DBs override their on-disk snapshot.
  for (const { data } of dirtyDbs) {
    if (data.database?.id) dbDataById.set(data.database.id, data as DbData);
  }

  // Load all raw page JSON so resolveLink can rebuild icons on cross-page
  // links AND so we can pre-populate `pageIcons` for the pipeline's O(1)
  // short-circuit. Without this, `pipeline.iconForLink` falls into
  // `rebuildIconMeta(rawDb)` per link, and cross-page **page** link icons
  // disappear entirely on repaired pages.
  const rawPageById = new Map<string, RawPageInput>();
  const pageIcons = new Map<
    string,
    { kind: "emoji"; value: string } | { kind: "image"; localPath: string }
  >();
  const pageFiles = (await readDirSafe(path.join(paths.raw, RAW_PAGES))).filter((f) =>
    f.endsWith(".json"),
  );
  await Promise.all(
    pageFiles.map((fileName) =>
      pool.run(async () => {
        const cached = JSON.parse(
          await readFileWithinRootAsync(paths.root, path.join("raw", RAW_PAGES, fileName)),
        ) as RawPage;
        const id = cached.page?.id;
        if (!id || !cached.page) return;
        const info = pageIndex.get(id);
        rawPageById.set(id, {
          id,
          title: info?.title ?? "",
          page: cached.page,
          blocks: cached.blocks ?? [],
          comments: cached.comments ?? [],
        });
        const icon = cached.page.icon;
        if (icon?.type === "emoji" && icon.emoji) {
          pageIcons.set(id, { kind: "emoji", value: icon.emoji });
        } else {
          const lp = icon?.file?.local_path ?? icon?.external?.local_path;
          if (lp) pageIcons.set(id, { kind: "image", localPath: lp });
        }
      }),
    ),
  );
  // dirty page mutations override the on-disk snapshot for both maps.
  for (const { data } of dirtyPages) {
    const id = data.page?.id;
    if (!id || !data.page) continue;
    const info = pageIndex.get(id);
    rawPageById.set(id, {
      id,
      title: info?.title ?? "",
      page: data.page,
      blocks: data.blocks ?? [],
      comments: data.comments ?? [],
    });
    const icon = data.page.icon;
    if (icon?.type === "emoji" && icon.emoji) {
      pageIcons.set(id, { kind: "emoji", value: icon.emoji });
    } else {
      const lp = icon?.file?.local_path ?? icon?.external?.local_path;
      if (lp) pageIcons.set(id, { kind: "image", localPath: lp });
    }
  }
  // Same for database icons (cross-page links to standalone DBs).
  for (const [id, raw] of dbDataById) {
    const icon = (raw.database as { icon?: NotionMediaPayload } | null)?.icon ?? null;
    if (icon?.type === "emoji" && icon.emoji) {
      pageIcons.set(id, { kind: "emoji", value: icon.emoji });
    } else {
      const lp = icon?.file?.local_path ?? icon?.external?.local_path;
      if (lp) pageIcons.set(id, { kind: "image", localPath: lp });
    }
  }

  // Ancestor chain via manifest parentId — repair doesn't re-crawl, but the
  // manifest's persisted `parentId` is enough to rebuild breadcrumbs.
  // Memoised by id: ancestor chains overlap heavily across
  // siblings — without the cache, a 941-page workspace × avg depth 5 walks
  // the parent chain ~4.7k times. Mirrors the `ancestorCache` pattern in
  // `html.ts:applyActiveMarkers`/`injectSidebars`.
  const ancestorCache = new Map<string, string[]>();
  function ancestorIds(id: string): string[] {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = pageIndex.get(id)?.parentId;
    while (cursor && pageIndex.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      chain.unshift(cursor);
      cursor = pageIndex.get(cursor)?.parentId;
    }
    ancestorCache.set(id, chain);
    return chain;
  }

  // Cache-once: a URL EXPORT_ICON becomes a local `assets/<hash>.png`. Without
  // this resolution, repaired pages would embed the raw URL while neighbours
  // (export/rerender) embed the local hash — breaking sidebar consistency.
  const archiveIcon =
    (await resolveArchiveIcon(cfg.render.exportIcon, (u) => assets.collect(u))) ??
    cfg.render.exportIcon;

  // Resolve `:slug:` custom-emoji shortcodes in titles so repaired pages keep
  // parity with export/rerender.
  const customEmojiByName = await fetchCustomEmojis(rawPageById.values(), assets, log);

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
    exportTimestamp: manifest.timestamp,
    ancestorIds,
    pageIcons,
  };

  await Promise.all(
    dirtyPages.map(({ data }) =>
      pool.run(async () => {
        if (!data.page?.id) return;
        const id = data.page.id;
        const self = pageIndex.get(id);
        if (!self) return;
        const raw: RawPageInput = {
          id,
          title: self.title,
          page: data.page,
          blocks: data.blocks ?? [],
          comments: data.comments ?? [],
        };
        const rendered = await renderPage(ctx, raw, { formatProp, rawPageById });
        if (rendered) freshBodies.set(id, rendered.md);
      }),
    ),
  );

  await Promise.all(
    dirtyDbs.map(({ data }) =>
      pool.run(async () => {
        if (!data.database?.id) return;
        const id = data.database.id;
        const self = pageIndex.get(id);
        if (!self) return;
        const views = normalizeViews(data, log);
        const raw: RawDatabaseInput = {
          id,
          title: self.title,
          database: data.database,
          rows: data.rows,
          ...(data.dataSource ? { dataSource: data.dataSource } : {}),
          ...(views.length ? { views } : {}),
        };
        const rendered = await renderDatabase(ctx, raw);
        if (rendered) freshBodies.set(id, rendered.md);
      }),
    ),
  );

  // Build the sitemap from manifest entries, sourcing icon meta from the
  // in-memory raw payloads. `rawPageById` / `dbDataById` were already
  // overlaid with dirty mutations above, so a refreshed page's icon flows
  // into every OTHER page's left-rail nav. Without rebuilding
  // the sidebar, neighbours render the stale icon (or 📄 fallback) until a
  // full re-export.
  // Root-relative emission: the sitemap is shared across every page, so
  // `injectSidebars` rewrites depth prefixes per-page. We pass identity as
  // `resolveSrc` and let the shared helper handle attr-escape + url-escape.
  //
  // SECURITY: title HTML must be both attr-escaped (for nav titles) and
  // url-escaped (for img src). The shared helper enforces both invariants;
  // do not inline a local implementation.
  function enrichTitleRootRelative(title: string): string {
    return enrichTitleHtml(title, customEmojiByName);
  }
  const sitemap: SitemapEntry[] = [];
  for (const e of manifest.entries) {
    const self = pageIndex.get(e.id);
    if (!self) continue;
    // `mdAbsPath` is rooted at `paths.markdown` and the html/ tree mirrors
    // that layout — derive the html-relative href off `paths.markdown` and
    // swap the extension. Computing it off `paths.html` would yield
    // `../markdown/...` and injectSidebars would look up files that don't
    // exist (same shape as the search-href regression below).
    const htmlRel = path
      .relative(paths.markdown, self.mdAbsPath)
      .replace(/\.md$/, ".html")
      .split(path.sep)
      .join("/");
    let icon: SitemapEntry["icon"];
    if (e.kind === "page") {
      const raw = rawPageById.get(e.id);
      if (raw?.page) icon = sitemapIconFromObj(raw.page);
    } else {
      const raw = dbDataById.get(e.id);
      if (raw?.database) icon = sitemapIconFromObj(raw.database);
    }
    sitemap.push({
      id: e.id,
      title: e.title,
      titleHtml: enrichTitleRootRelative(e.title),
      href: htmlRel,
      kind: e.kind,
      ...(e.parentId ? { parentId: e.parentId } : {}),
      ...(icon ? { icon } : {}),
    });
  }

  return { freshBodies, sitemap, archiveIcon };
}

// --- Phase: rebuild search docs from on-disk md ----------------------------
// Repair re-renders dirty pages and keeps their markdown in memory; for
// clean entries we still read from disk. This keeps the index in lockstep
// with what the HTML actually shows while avoiding redundant work on the
// dirty subset (a 941-page workspace previously paid ~24 MB of disk reads
// on a 1-asset repair).
//
// We walk the markdown/ tree (NOT manifest entries' rawPath) because the raw
// layout is flat (`raw/pages/<title>.<uuid>.json`) while md/html mirror the
// hierarchy (`markdown/Haus/Küche/<title>.<uuid>.md`). Deriving `mdRel` from
// `rawPath` via regex silently drops every nested page from the rebuilt
// index.
async function collectSearchDocs(
  paths: ExportPaths,
  manifest: Manifest,
  freshBodies: Map<string, string>,
  log: Logger,
): Promise<SearchDoc[]> {
  const byId = new Map(manifest.entries.map((e) => [e.id, e]));
  // <title>.<uuid>.md — uuid is hex with dashes; keep regex tight.
  const FILENAME = /\.([0-9a-f-]{36})\.md$/i;

  // Read the previous run's body sidecar (written by export/rerender) so we
  // can skip re-reading every clean entry's md. On a 941-page workspace with
  // 1 dirty asset, this turns ~940 disk reads + ~940 plainText() passes into
  // a single sidecar read. Sidecar absent → legacy export or
  // never-rerendered tree; we fall back to per-entry md reads.
  const previousBodies = await readSearchBodies(paths.html);
  const sidecarHit = previousBodies !== null;

  // Walk markdown/ to discover the real on-disk location of every entry's
  // md file. We need this for href derivation (html/-relative hrefs) even
  // when we don't read the file's contents. The walk itself is
  // fast — fs.readdir(withFileTypes) is one syscall per directory and avoids
  // opening any files.
  const mdPathById = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (ent) => {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) return walk(full);
        if (!ent.isFile() || !ent.name.endsWith(".md")) return;
        const m = ent.name.match(FILENAME);
        if (!m?.[1]) return;
        if (!byId.has(m[1])) return;
        mdPathById.set(m[1], full);
      }),
    );
  }
  await walk(paths.markdown);

  const docs: SearchDoc[] = [];
  let freshHits = 0;
  let sidecarHits = 0;
  let diskReads = 0;

  await Promise.all(
    [...mdPathById].map(async ([id, full]) => {
      const e = byId.get(id);
      if (!e) return;
      // The walk is rooted at `paths.markdown`, so derive the relative
      // *site* path from there and swap the extension. Using `paths.html`
      // as the base produces `../markdown/...` hrefs: every
      // search-result click 404s because the rebuilt index sits in
      // `html/search-index.js` and links must be relative to `html/`.
      const htmlRel = path
        .relative(paths.markdown, full)
        .replace(/\.md$/, ".html")
        .split(path.sep)
        .join("/");

      // Body source priority:
      //   1. freshBodies — page was re-rendered this run; canonical truth.
      //   2. previousBodies — clean entry; sidecar has the indexed body
      //      from the previous run. Identical to what the lunr index
      //      already has, so reusing it is exact (no quality regression).
      //   3. on-disk md — fallback when the sidecar is missing (legacy
      //      export) or the entry simply wasn't in it (new pages, sidecar
      //      from before this entry was added). One read per miss.
      const inMemory = freshBodies.get(id);
      if (inMemory !== undefined) {
        docs.push({
          id,
          title: e.title,
          body: plainText(inMemory),
          href: htmlRel,
          kind: e.kind,
        });
        freshHits++;
        return;
      }
      const cached = previousBodies?.[id];
      if (cached !== undefined) {
        // Already plainText + sliced when the sidecar was written; reuse as-is.
        docs.push({ id, title: e.title, body: cached, href: htmlRel, kind: e.kind });
        sidecarHits++;
        return;
      }
      const mdRel = path.relative(paths.root, full);
      try {
        const md = await readFileWithinRootAsync(paths.root, mdRel);
        diskReads++;
        docs.push({
          id,
          title: e.title,
          body: plainText(md),
          href: htmlRel,
          kind: e.kind,
        });
      } catch (err) {
        // Missing/unreadable md — skip the snippet, but log so operators
        // notice when (for example) a symlink trips `assertWithinRootAsync`
        // or the md file vanishes mid-walk.
        log.warn(
          { filename: path.basename(full), err: (err as Error).message },
          "repair: search-doc read failed; snippet skipped",
        );
      }
    }),
  );

  log.info(
    { freshHits, sidecarHits, diskReads, sidecar: sidecarHit ? "hit" : "miss" },
    "repair: search docs assembled",
  );
  return docs;
}

// --- Phase: persist updated manifest ----------------------------------------
async function writeRepairedManifest(
  paths: ExportPaths,
  manifest: Manifest,
  assets: AssetCollector,
): Promise<number> {
  const newAssets = [...(manifest.assets ?? []), ...assets.records()];
  const remainingFailures = assets.failures();
  await writeManifest({
    exportRoot: paths.root,
    manifestPath: paths.manifest,
    version: manifest.tool.version,
    timestamp: manifest.timestamp,
    entries: manifest.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      rawAbs: assertWithinRoot(paths.root, e.rawPath),
      lastEditedTime: e.lastEditedTime,
    })),
    assets: newAssets,
    failedAssets: remainingFailures,
    skipped: manifest.counts.skipped ?? 0,
    ...(manifest.basedOn ? { basedOn: manifest.basedOn } : {}),
  });
  return remainingFailures.length;
}

export async function runRepair(
  cfg: Config,
  log: Logger,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const token = requireToken(cfg);
  const notion = new RateLimitedNotion({
    token,
    log,
    minTime: cfg.notion.minTime,
    maxConcurrent: cfg.notion.maxConcurrent,
    maxRetries: cfg.notion.maxRetries,
  });
  const exportRoot = opts.exportRoot ?? (await findLatestExport(cfg.io.outDir));
  if (!exportRoot) throw new Error("no export found to repair");
  log.info({ exportRoot }, "repair: target");

  const paths = buildPaths(cfg.io.outDir, path.basename(exportRoot));

  const manifest = await readManifest(paths.manifest, { log });
  if (!manifest) throw new Error(`failed to read manifest at ${paths.manifest}`);
  const verifiedBefore = await verifiedMaintenanceInventory(paths.root);

  const assets = createAssetCollector({
    assetsDir: paths.assets,
    exportRoot: paths.root,
    log,
    concurrency: cfg.io.assetConcurrency,
  });

  const { scanned, refreshed, dirtyPages, dirtyDbs } = await scanAndRefreshAssets(
    paths,
    notion,
    assets,
    log,
  );

  if (dirtyPages.length === 0 && dirtyDbs.length === 0) {
    log.info("repair: nothing to rewrite");
    return { exportRoot, scanned, refreshed, stillFailing: assets.failures().length };
  }

  const { freshBodies, sitemap, archiveIcon } = await rerenderDirty(
    cfg,
    log,
    paths,
    manifest,
    assets,
    dirtyPages,
    dirtyDbs,
  );

  // Refresh every client-side asset every HTML page references. Repair doesn't
  // re-crawl, but the static client assets (style.css, katex.min.css, lunr,
  // search.js, lightbox.js) must still be emitted so a freshly-repaired tree
  // that was bootstrapped from a partial export is self-contained. The
  // search-index *data* is rebuilt below from the on-disk markdown so the
  // index reflects whatever the most recent renders produced. Skipping any
  // of these writers leaves repaired exports referencing missing assets.
  const searchDocs = await collectSearchDocs(paths, manifest, freshBodies, log);
  // Rebuild the index page + the per-page sidebar so a refreshed page's icon
  // propagates to every OTHER page's left-rail entry. Without this, neighbours
  // keep rendering the stale icon (or 📄 fallback) until a full re-export.
  // Timestamp stays `manifest.timestamp` — repair is asset-only, not a render
  // (CLAUDE.md invariant #11), so the footer must not advance.
  let stillFailing = 0;
  await finalizeSite({
    htmlDir: paths.html,
    rawDir: paths.raw,
    sitemap,
    searchDocs,
    timestamp: manifest.timestamp,
    archiveTitle: cfg.render.exportTitle,
    archiveIcon,
    // Rebuild the manifest's failed-asset list using the collector's tally.
    persistManifest: async () => {
      stillFailing = await writeRepairedManifest(paths, manifest, assets);
      return manifest;
    },
  });

  if (verifiedBefore) {
    await markSnapshotVerified(
      paths.root,
      verifiedBefore.entries.map((e) => ({ id: e.id, object: e.kind })),
      stillFailing,
      verifiedBefore,
    );
  }

  log.info({ scanned, refreshed, stillFailing }, "repair: complete");
  return { exportRoot, scanned, refreshed, stillFailing };
}

async function refreshAndDownload(
  assets: AssetCollector,
  log: Logger,
  refresh: () => Promise<string | null>,
): Promise<string | null> {
  try {
    const freshUrl = await refresh();
    if (!freshUrl) return null;
    const rec = await assets.collect(freshUrl);
    return rec.localPath;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "repair: asset retry failed");
    return null;
  }
}
