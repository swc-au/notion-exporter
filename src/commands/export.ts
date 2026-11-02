import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { requireToken } from "../config.js";
import { collectLocalAssetPaths } from "../export/assetReferences.js";
import type { AssetRecord } from "../export/assets.js";
import { createAssetCollector, rewriteBlocksWithAssets, safeUrlForLog } from "../export/assets.js";
import { attachmentRequirements } from "../export/attachmentRequirements.js";
import { finalizeSite } from "../export/finalizeAssets.js";
import type { SitemapEntry } from "../export/html.js";
import {
  createDataSourceSchemaCache,
  type ExportCounts,
  type ExportedDatabase,
  type ExportedPage,
  exportAllJson,
  filterRowsToOrder,
  type ProgressEvent,
  queryDataSourceRows,
  RAW_DATABASES,
  RAW_PAGES,
  writeRawJson,
} from "../export/json.js";
import {
  findPartialExport,
  type Manifest,
  type ManifestInput,
  writeManifest,
} from "../export/manifest.js";
import { formatProp } from "../export/markdown.js";
import { buildPaths, type ExportPaths, relUrl, safeSegment } from "../export/paths.js";
import {
  type DbData,
  type DocRef,
  type RawDatabaseInput,
  type RawPageInput,
  type RenderContext,
  renderDatabase,
  renderPage,
} from "../export/pipeline.js";
import { applyRetention } from "../export/retention.js";
import { plainText, type SearchDoc } from "../export/searchIndex.js";
import { enrichTitleHtml } from "../export/titleHtml.js";
import {
  findPreviousSourceInventory,
  findVerifiedPreviousExport,
  markSnapshotVerified,
} from "../export/verifiedSnapshot.js";
import type { Logger } from "../logger.js";
import type { NotionBlock } from "../notion/blocks.js";
import { RateLimitedNotion } from "../notion/client.js";
import { fetchPageComments, type NotionComment } from "../notion/comments.js";
import type { DiscoveredObject } from "../notion/crawl.js";
import { crawlAll } from "../notion/crawl.js";
import { fetchCustomEmojis, type RawPageLike } from "../notion/customEmojis.js";
import {
  extractCover,
  extractIconUrlForDownload,
  notionUrlFor,
  resolveArchiveIcon,
  sitemapIconFromObj,
} from "../notion/meta.js";
import { fetchAllViews, normalizeViews } from "../notion/views.js";
import { assertWithinRoot, assertWithinRootAsync } from "../util/fs.js";
import { cloneFile } from "../util/fsclone.js";
import { VERSION } from "../version.js";

export interface ExportOptions {
  dryRun: boolean;
  outDir?: string;
  retention?: number;
  incremental?: boolean;
  resume?: boolean;
  onProgress?: (e: ProgressEvent) => void;
  onAsset?: () => void;
}

export interface ExportResult {
  dryRun: boolean;
  objects: DiscoveredObject[];
  pages: number;
  databases: number;
  assets: number;
  errors: number;
  skipped: number;
  basedOn?: string;
  exportRoot?: string;
}

// A3 (security): produce a sitemap `titleHtml` from a (potentially attacker-
// controlled) plain-text title plus a custom-emoji map. Returns `null` when
// the title carries no `:slug:` shortcode syntax — the caller then leaves
// `entry.titleHtml` unset so `injectSidebars` falls back to its own
// `htmlEscape(entry.title)` path (output is byte-identical to the helper for
// plain titles; the null short-circuit is a perf optimisation that skips a
// sitemap-wide walk on workspaces with zero shortcode-bearing titles).
//
// All the real work — whole-title attr-escape FIRST, then `:slug:` swap to
// `<img>` with url-escaped `src` and attr-escaped `alt`/`title` — lives in
// the shared `enrichTitleHtml` helper. This thin wrapper preserves the
// null-iff-no-shortcode contract that the call site relies on.
export function enrichSitemapTitleHtml(
  title: string,
  customEmojiByName: Map<string, string>,
): string | null {
  // Match the original gate: "no `:slug:` syntax" — not "no resolvable
  // shortcode". A title carrying `:unknown:` still passes through so the
  // shortcode text ships as escaped literal (covered by export.audit.test).
  if (!/:[a-zA-Z0-9_\-+]+:/.test(title)) return null;
  return enrichTitleHtml(title, customEmojiByName);
}

function buildHierarchy(objects: DiscoveredObject[]): Map<string, string> {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const cache = new Map<string, string>();
  function resolve(id: string, visited: Set<string>): { dir: string; cycle: boolean } {
    if (cache.has(id)) return { dir: cache.get(id)!, cycle: false };
    if (visited.has(id)) return { dir: "", cycle: true };
    visited.add(id);
    const obj = byId.get(id);
    if (!obj) return { dir: "", cycle: false };
    const parentId = obj.parent.id;
    let dir = "";
    let parentCycle = false;
    if (parentId && byId.has(parentId)) {
      const parent = byId.get(parentId)!;
      const parentResult = resolve(parentId, visited);
      parentCycle = parentResult.cycle;
      dir = path.join(parentResult.dir, safeSegment(parent.title));
    }
    // Don't cache when an ancestor was short-circuited by the cycle break —
    // a different traversal path may resolve correctly.
    if (!parentCycle) cache.set(id, dir);
    return { dir, cycle: parentCycle };
  }
  for (const o of objects) resolve(o.id, new Set());
  return cache;
}

function buildPageIndex(
  objects: DiscoveredObject[],
  hierarchy: Map<string, string>,
  markdownRoot: string,
): Map<string, DocRef> {
  const idx = new Map<string, DocRef>();
  for (const o of objects) {
    const subdir = hierarchy.get(o.id) ?? "";
    const filename = `${safeSegment(o.title)}.${o.id}.md`;
    idx.set(o.id, {
      id: o.id,
      title: o.title,
      kind: o.object,
      mdAbsPath: path.join(markdownRoot, subdir, filename),
      subdir,
      ...(o.parent.id ? { parentId: o.parent.id } : {}),
    });
  }
  return idx;
}

// Walk a directory tree once and return a Map<id, absPath> for files matching
// `<title>.<uuid>.<ext>`. Used by --incremental to look up the previous run's
// md/html paths in O(1) per skipped page instead of O(treeSize) per lookup.
async function indexById(rootDir: string, ext: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const stack: string[] = [rootDir];
  const re = new RegExp(`\\.([0-9a-f-]{36})\\${ext}$`, "i");
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        const m = e.name.match(re);
        if (m?.[1]) out.set(m[1], full);
      }
    }
  }
  return out;
}

type AssetCollectorRef = ReturnType<typeof createAssetCollector>;

async function resolveIconForPage(
  page: unknown,
  assets: AssetCollectorRef,
  log: Logger,
  refreshPage?: (pageId: string) => Promise<unknown | null>,
): Promise<void> {
  // `extractIcon` returns null for file icons without `local_path`
  // (renderer safety). The download side needs the remote URL, so use the
  // dedicated download-side extractor here.
  const iconUrl = extractIconUrlForDownload(page);
  if (!iconUrl) return;
  try {
    const pageId = (page as { id?: string })?.id;
    const rec = await assets.collect(iconUrl, {
      refresh:
        refreshPage && pageId
          ? async () => {
              const fresh = await refreshPage(pageId);
              if (!fresh) return null;
              const freshUrl = extractIconUrlForDownload(fresh);
              if (!freshUrl) return null;
              const cp = page as {
                icon?: { file?: { url?: string }; external?: { url?: string } };
              };
              const fp = fresh as {
                icon?: { file?: { url?: string }; external?: { url?: string } };
              };
              if (fp.icon?.file?.url && cp.icon?.file) cp.icon.file.url = fp.icon.file.url;
              if (fp.icon?.external?.url && cp.icon?.external)
                cp.icon.external.url = fp.icon.external.url;
              return freshUrl;
            }
          : undefined,
    });
    const p = page as {
      icon?: { file?: { local_path?: string }; external?: { local_path?: string } };
    };
    if (p.icon?.file) p.icon.file.local_path = rec.localPath;
    if (p.icon?.external) p.icon.external.local_path = rec.localPath;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "icon download failed");
  }
}

async function resolveCoverForPage(
  page: unknown,
  assets: AssetCollectorRef,
  log: Logger,
  refreshPage?: (pageId: string) => Promise<unknown | null>,
): Promise<void> {
  const cover = extractCover(page);
  if (!cover?.url) return;
  try {
    const pageId = (page as { id?: string })?.id;
    const rec = await assets.collect(cover.url, {
      refresh:
        refreshPage && pageId
          ? async () => {
              const fresh = await refreshPage(pageId);
              if (!fresh) return null;
              const freshCover = extractCover(fresh);
              if (!freshCover?.url) return null;
              const cp = page as {
                cover?: { file?: { url?: string }; external?: { url?: string } };
              };
              const fp = fresh as {
                cover?: { file?: { url?: string }; external?: { url?: string } };
              };
              if (fp.cover?.file?.url && cp.cover?.file) cp.cover.file.url = fp.cover.file.url;
              if (fp.cover?.external?.url && cp.cover?.external)
                cp.cover.external.url = fp.cover.external.url;
              return freshCover.url;
            }
          : undefined,
    });
    const p = page as {
      cover?: { file?: { local_path?: string }; external?: { local_path?: string } };
    };
    if (p.cover?.file) p.cover.file.local_path = rec.localPath;
    if (p.cover?.external) p.cover.external.local_path = rec.localPath;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "cover download failed");
  }
}

type RowMedia = {
  cover?: {
    file?: { url?: string; local_path?: string };
    external?: { url?: string; local_path?: string };
  } | null;
  icon?: {
    type?: string;
    file?: { url?: string; local_path?: string };
    external?: { url?: string; local_path?: string };
  } | null;
};

async function localizeRowCoverIcon(
  row: unknown,
  assets: AssetCollectorRef,
  log: Logger,
  refreshPage?: (pageId: string) => Promise<unknown | null>,
): Promise<void> {
  const r = row as RowMedia & { id?: string };
  const tasks: Array<Promise<void>> = [];
  const refreshFor = (which: "cover" | "icon", kind: "file" | "external") => {
    if (!refreshPage || !r.id) return undefined;
    return async () => {
      const fresh = (await refreshPage(r.id as string)) as RowMedia | null;
      if (!fresh) return null;
      const freshUrl = fresh[which]?.[kind]?.url;
      const curTarget = r[which]?.[kind];
      if (freshUrl && curTarget) curTarget.url = freshUrl;
      return freshUrl ?? null;
    };
  };
  const grab = async (
    url: string,
    target: { local_path?: string },
    refresh?: () => Promise<string | null>,
  ) => {
    try {
      const rec = await assets.collect(url, { refresh });
      target.local_path = rec.localPath;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "row asset download failed");
    }
  };
  if (r.cover?.external?.url)
    tasks.push(grab(r.cover.external.url, r.cover.external, refreshFor("cover", "external")));
  if (r.cover?.file?.url)
    tasks.push(grab(r.cover.file.url, r.cover.file, refreshFor("cover", "file")));
  if (r.icon?.type !== "emoji") {
    if (r.icon?.external?.url)
      tasks.push(grab(r.icon.external.url, r.icon.external, refreshFor("icon", "external")));
    if (r.icon?.file?.url)
      tasks.push(grab(r.icon.file.url, r.icon.file, refreshFor("icon", "file")));
  }
  await Promise.all(tasks);
}

function ancestorIds(id: string, byId: Map<string, DiscoveredObject>): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = byId.get(id)?.parent.id;
  // Push (O(1)) then reverse once at the end — `unshift` per hop is O(depth)
  // and makes the whole walk O(depth²) on deep hierarchies.
  while (cursor && byId.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    chain.push(cursor);
    cursor = byId.get(cursor)?.parent.id;
  }
  chain.reverse();
  return chain;
}

function buildChildrenMap(objects: DiscoveredObject[]): Map<string, DiscoveredObject[]> {
  const map = new Map<string, DiscoveredObject[]>();
  for (const o of objects) {
    const parentId = o.parent.id;
    if (!parentId) continue;
    const list = map.get(parentId) ?? [];
    list.push(o);
    map.set(parentId, list);
  }
  return map;
}

type PageIcon = { kind: "emoji"; value: string } | { kind: "image"; localPath: string };

type SitemapIcon = NonNullable<ReturnType<typeof sitemapIconFromObj>>;

/**
 * Resolve a sitemap-entry icon for `id` without paying for a `JSON.parse` of
 * the raw page/database file. `ctx.pageIcons` was populated by
 * `prefetchPageIcons` from the discovered crawl objects and already contains
 * every icon we'd otherwise re-derive from disk. Falls back to parsing
 * `rawText` only when the in-memory map has no entry — which only happens for
 * objects that surfaced post-crawl (none on the current paths, but worth a
 * belt for safety).
 */
function sitemapIconFromCtxOrParse(
  ctx: PhaseContext,
  id: string,
  rawText?: string,
): SitemapIcon | undefined {
  const pre = ctx.pageIcons.get(id);
  if (pre) {
    if (pre.kind === "emoji") return { kind: "emoji", value: pre.value };
    return { kind: "image", value: `../${pre.localPath}` };
  }
  if (!rawText) return undefined;
  try {
    const parsed = JSON.parse(rawText) as { page?: unknown; database?: unknown };
    return sitemapIconFromObj(
      (parsed.page ?? parsed.database) as Parameters<typeof sitemapIconFromObj>[0],
    );
  } catch (err) {
    // Corrupt raw JSON → no sidebar icon for this page. Not fatal (📄 fallback),
    // but log so an operator can spot a truncated/poisoned raw file.
    ctx.log.debug({ err: (err as Error).message }, "sitemap icon parse failed");
    return undefined;
  }
}

// Aggregated mutable phase state. The orchestrator builds this once, then
// each phase reads from / writes into it. Beats a 10-arg signature on every
// helper and keeps the orchestrator's data dependencies in one place.
export interface PhaseContext {
  cfg: Config;
  log: Logger;
  paths: ExportPaths;
  objects: DiscoveredObject[];
  byId: Map<string, DiscoveredObject>;
  hierarchy: Map<string, string>;
  pageIndex: Map<string, DocRef>;
  childrenMap: Map<string, DiscoveredObject[]>;
  pageIcons: Map<string, PageIcon>;
  assets: AssetCollectorRef;
  skipIds: Set<string>;
  manifestEntries: ManifestInput[];
  sitemap: SitemapEntry[];
  searchDocs: SearchDoc[];
  carriedAssets: AssetRecord[];
  dbDataById: Map<string, DbData>;
  /** Shared `:slug:` → root-relative `assets/<hash>.png` map. Populated
   * incrementally as pages are fetched so cross-page link titles + sidebar
   * entries can swap shortcodes for inline `<img>` tags. The same Map ref
   * is wired into `renderCtx.customEmojiByName` so per-page renders see
   * additions made by earlier pages without resetup. */
  customEmojiByName: Map<string, string>;
  // Sticky flag: once `fetchPageComments` returns `restricted_resource` (the
  // integration lacks the "Read comments" capability) we stop calling the
  // endpoint for the rest of the run. Avoids ~5min of wasted 403s on a
  // 941-page workspace. Transient errors (5xx, network) do NOT set this.
  commentsDisabled: boolean;
}

// --- Phase: prefetch page icons ---------------------------------------------
// Pre-resolve page icons (download images) so child_page/database renders and
// mention rich-text can show the target page's real icon. Run all downloads
// in parallel — the asset collector already bounds concurrency.
//
// Pass a refresh callback so the collector can re-sign Notion S3 URLs that
// expired between the crawl (search endpoint) and this phase. Without it,
// an incremental export based on a 1+h-old crawl manifest re-uses stale
// signed URLs and hits 403s for every page-icon and database-icon. The
// icon URLs originate from the search payload, so refresh by calling
// `pages.retrieve` / `databases.retrieve` and reading the freshly-signed
// url back out via `extractIconUrlForDownload`.
async function prefetchPageIcons(ctx: PhaseContext, notion?: RateLimitedNotion): Promise<void> {
  await Promise.all(
    ctx.objects.map(async (o) => {
      const i = o.icon;
      if (!i) return;
      if (i.kind === "emoji") {
        ctx.pageIcons.set(o.id, { kind: "emoji", value: i.value });
        return;
      }
      const refresh = notion
        ? async (): Promise<string | null> => {
            try {
              const fresh =
                o.object === "page"
                  ? await notion.run((c) => c.pages.retrieve({ page_id: o.id }))
                  : await notion.run((c) => c.databases.retrieve({ database_id: o.id }));
              const freshUrl = extractIconUrlForDownload(fresh);
              if (!freshUrl) return null;
              return freshUrl;
            } catch (err) {
              ctx.log.debug(
                { id: o.id, err: (err as Error).message },
                "page icon URL refresh failed",
              );
              return null;
            }
          }
        : undefined;
      try {
        const rec = await ctx.assets.collect(i.value, { refresh });
        ctx.pageIcons.set(o.id, { kind: "image", localPath: rec.localPath });
      } catch (err) {
        ctx.log.warn({ id: o.id, err: (err as Error).message }, "page icon download failed");
      }
    }),
  );
}

// --- Phase: resume rehydrate ------------------------------------------------
// Rebuild manifest/sitemap/search entries from raw JSON + md files that were
// written by a prior aborted run. Pages whose raw files exist are marked as
// skipped so the fetch phases don't re-download them.
export async function rehydrateResume(ctx: PhaseContext): Promise<void> {
  const doneIds = new Set<string>();
  for (const kind of [RAW_PAGES, RAW_DATABASES] as const) {
    const dir = path.join(ctx.paths.raw, kind);
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const idMatch = f.match(/\.([0-9a-f-]{36})\.json$/i);
      if (!idMatch) continue;
      const id = idMatch[1]!;
      const obj = ctx.byId.get(id);
      if (!obj) continue;
      const subdir = ctx.hierarchy.get(id) ?? "";
      const rawAbs = path.join(dir, f);
      // Derive md/html paths from the on-disk JSON filename stem rather than
      // `safeSegment(obj.title)`. If the page was renamed between the aborted
      // run and the resume, the current crawl's title no longer matches what
      // the previous run wrote to disk — using `obj.title` here pointed
      // mdAbs/htmlAbs at non-existent files and pushed a broken sitemap href.
      // The on-disk stem is the source of truth for resumed entries.
      const stem = f.replace(/\.json$/, "");
      // SECURITY: the on-disk filename is operator-untrusted on a tampered
      // resume tree. A stem like `..%2F..%2Fetc%2Fpasswd.<uuid>`
      // (where `%2F` is the literal three-char sequence on disk, not an
      // already-decoded slash) is benign, but a stem containing real `..`
      // path segments OR a leading slash would let `path.join` traverse out
      // of `paths.markdown`. Refuse such stems and validate the resulting
      // mdAbs/htmlAbs are still inside the markdown/html roots before any
      // fs read.
      if (stem.includes("..") || stem.includes("/") || stem.includes("\\")) {
        ctx.log.warn({ stem }, "resume: refusing suspicious filename stem");
        continue;
      }
      let mdAbs: string;
      let htmlAbs: string;
      try {
        mdAbs = assertWithinRoot(ctx.paths.markdown, path.join(subdir, `${stem}.md`));
        htmlAbs = assertWithinRoot(ctx.paths.html, path.join(subdir, `${stem}.html`));
      } catch (err) {
        ctx.log.warn(
          { stem, err: (err as Error).message },
          "resume: refusing path-traversing filename",
        );
        continue;
      }
      doneIds.add(id);
      ctx.manifestEntries.push({
        id,
        kind: obj.object,
        title: obj.title,
        rawAbs,
        lastEditedTime: obj.lastEditedTime,
        parentId: obj.parent.id,
      });
      // Preserve the page/db icon across resume rehydrate so the sidebar +
      // index tree don't fall back to 📄/🗂 placeholders for already-completed
      // pages. Prefer the in-memory `ctx.pageIcons` (already populated by
      // `prefetchPageIcons`) to avoid a 100-500 KB JSON.parse per page.
      const icon = sitemapIconFromCtxOrParse(ctx, id);
      ctx.sitemap.push({
        id,
        title: obj.title,
        href: relUrl(ctx.paths.html, htmlAbs),
        kind: obj.object,
        parentId: obj.parent.id,
        ...(icon ? { icon } : {}),
      });
      try {
        const md = await fsp.readFile(mdAbs, "utf8");
        ctx.searchDocs.push({
          id,
          title: obj.title,
          body: plainText(md),
          href: relUrl(ctx.paths.html, htmlAbs),
          kind: obj.object,
        });
      } catch (err) {
        // md missing/unreadable — keep manifest entry but this page won't be
        // searchable until a full re-render. Surface it rather than vanish it.
        ctx.log.debug({ id, err: (err as Error).message }, "resume: search snippet skipped");
      }
    }
  }
  ctx.log.info({ done: doneIds.size }, "resume: rehydrated state");
  for (const id of doneIds) ctx.skipIds.add(id);
}

// --- Phase: incremental clone -----------------------------------------------
// For every id in skipIds with a matching entry in the previous export, clone
// its raw/md/html files into this run's tree and carry forward referenced
// asset records so the manifest stays self-consistent without refetching.
export async function cloneIncremental(
  ctx: PhaseContext,
  prevExport: { root: string; manifest: Manifest },
): Promise<void> {
  const prevAssetByPath = new Map(prevExport.manifest.assets.map((a) => [a.localPath, a]));
  const usedAssetPaths = new Set<string>();
  // Pre-index for O(1) lookups instead of O(n) per skipped page.
  const prevEntryById = new Map(prevExport.manifest.entries.map((e) => [e.id, e]));
  const prevMdById = await indexById(path.join(prevExport.root, "markdown"), ".md");
  const prevHtmlById = await indexById(path.join(prevExport.root, "html"), ".html");
  for (const id of ctx.skipIds) {
    const prevEntry = prevEntryById.get(id);
    if (!prevEntry) continue;
    const obj = ctx.byId.get(id);
    if (!obj) continue;
    const subdir = ctx.hierarchy.get(id) ?? "";
    // Derive the destination filename stem from the SOURCE raw filename
    // (the one the previous export wrote) rather than
    // from the current crawl's title. After a rename between exports, the
    // current `obj.title` no longer matches what the previous run wrote to
    // disk — using it pointed the cloned md/html paths at non-existent
    // sources (md/html clones silently no-op'd) and broke the manifest's
    // mdRel/htmlRel hrefs. `rehydrateResume` already uses the on-disk stem
    // for the same reason. Falls back to the current title only when the
    // previous raw filename can't be derived (defensive).
    const prevRawBase = path.basename(prevEntry.rawPath);
    const prevStem = prevRawBase.endsWith(".json") ? prevRawBase.slice(0, -".json".length) : "";
    // Validate the previous stem is well-formed (`<safeSegment>.<uuid>`); if
    // not, fall back to the current-title shape so we don't propagate a
    // tampered or unexpected filename.
    const stemValid = /\.[0-9a-f-]{36}$/i.test(prevStem) && !prevStem.includes("/");
    const filename = stemValid ? prevStem : `${safeSegment(obj.title)}.${obj.id}`;

    // clone raw
    // A-sec: gate the SOURCE side of the clone — `prevEntry.rawPath` is
    // operator-untrusted (manifest is a JSON file on disk that could have
    // been tampered with between runs). The stem-validation above only
    // protects the destination filename; without this gate a manifest entry
    // like `rawPath: "../../../etc/passwd.<uuid>.json"` would read from
    // outside the previous export root before failing closed. On any
    // traversal attempt, refetch the page fresh.
    let rawSrc: string;
    try {
      rawSrc = assertWithinRoot(prevExport.root, prevEntry.rawPath);
    } catch (err) {
      ctx.log.warn(
        { id, err: (err as Error).message },
        "incremental: prev rawPath escapes prev export root, refetching",
      );
      ctx.skipIds.delete(id);
      continue;
    }
    const rawDst = path.join(
      ctx.paths.raw,
      obj.object === "page" ? RAW_PAGES : RAW_DATABASES,
      `${filename}.json`,
    );
    const cloned = await cloneFile(rawSrc, rawDst);
    if (!cloned) {
      ctx.log.warn({ id }, "incremental: prev raw missing, will refetch");
      ctx.skipIds.delete(id);
      continue;
    }
    // clone markdown
    const mdDst = path.join(ctx.paths.markdown, subdir, `${filename}.md`);
    const mdSrc = prevMdById.get(id);
    if (mdSrc) await cloneFile(mdSrc, mdDst);
    // clone html
    const htmlDst = path.join(ctx.paths.html, subdir, `${filename}.html`);
    const htmlSrc = prevHtmlById.get(id);
    if (htmlSrc) await cloneFile(htmlSrc, htmlDst);

    // Use the same parsed reference inventory as snapshot verification.
    const rawText = await fsp.readFile(rawDst, "utf8");
    const referencedPaths = collectLocalAssetPaths(JSON.parse(rawText));
    for (const localPath of referencedPaths) {
      const rec = prevAssetByPath.get(localPath);
      if (!rec)
        throw new Error(`Incremental source is missing a required asset record: ${localPath}`);
      if (usedAssetPaths.has(localPath)) continue;
      await cloneFile(path.join(prevExport.root, localPath), path.join(ctx.paths.root, localPath));
      ctx.carriedAssets.push(rec);
      usedAssetPaths.add(localPath);
    }

    ctx.manifestEntries.push({
      id,
      kind: obj.object,
      title: obj.title,
      rawAbs: rawDst,
      lastEditedTime: obj.lastEditedTime,
      parentId: obj.parent.id,
    });
    const htmlRel = relUrl(ctx.paths.html, htmlDst);
    // Prefer the in-memory `ctx.pageIcons` (populated by `prefetchPageIcons`)
    // to avoid a 100-500 KB JSON.parse per cloned page. Falls back to parsing
    // the already-read `rawText` if the id isn't in the map.
    const icon = sitemapIconFromCtxOrParse(ctx, obj.id, rawText);
    ctx.sitemap.push({
      id: obj.id,
      title: obj.title,
      href: htmlRel,
      kind: obj.object,
      parentId: obj.parent.id,
      ...(icon ? { icon } : {}),
    });
    // best-effort: rebuild search snippet from the cloned markdown if present
    try {
      const md = mdSrc ? await fsp.readFile(mdDst, "utf8") : "";
      ctx.searchDocs.push({
        id: obj.id,
        title: obj.title,
        body: plainText(md),
        href: htmlRel,
        kind: obj.object,
      });
    } catch (err) {
      // Cloned md unreadable → this carried-forward page drops out of search
      // until re-render. Best-effort, but log the reason.
      ctx.log.debug({ id: obj.id, err: (err as Error).message }, "incremental: snippet skipped");
    }
  }
  ctx.log.info(
    { cloned: ctx.manifestEntries.length, carriedAssets: ctx.carriedAssets.length },
    "incremental: reused",
  );
}

// --- Phase: preload skipped databases for inline rendering ------------------
// When --incremental cloned an unchanged database from the previous export,
// the fresh phase 1 won't fetch it — but a *changed* page that still
// references it needs its rows to render the inline view. Pre-load every
// skipped DB's cloned raw JSON so the same map serves both cases.
async function preloadSkippedDatabases(ctx: PhaseContext): Promise<void> {
  for (const id of ctx.skipIds) {
    const obj = ctx.byId.get(id);
    if (obj?.object !== "database") continue;
    try {
      const filename = `${safeSegment(obj.title)}.${obj.id}.json`;
      const rawAbs = path.join(ctx.paths.raw, RAW_DATABASES, filename);
      const raw = JSON.parse(await fsp.readFile(rawAbs, "utf8")) as {
        database: unknown;
        rows: unknown[];
        // Optional persisted data-source schema. Older exports won't carry
        // it — renderer falls back to heuristics.
        dataSource?: import("../notion/dataSourceSchema.js").DataSourceSchema;
        // Persisted views (Views API): new `views[]` shape, or legacy single
        // `view`/`rowOrder` — `normalizeViews` accepts both.
        views?: unknown;
        view?: unknown;
        rowOrder?: unknown;
      };
      const views = normalizeViews(raw, ctx.log);
      ctx.dbDataById.set(id, {
        database: raw.database,
        rows: (raw.rows ?? []) as DbData["rows"],
        title: obj.title,
        ...(raw.dataSource ? { dataSource: raw.dataSource } : {}),
        ...(views.length ? { views } : {}),
      } as DbData);
    } catch (err) {
      ctx.log.warn(
        { id, err: (err as Error).message },
        "incremental: failed to load cloned DB for inline render",
      );
    }
  }
}

// When a previous export predates view capture, its cloned-unchanged
// databases carry no `view`/`rowOrder` (or are linked-view stubs cloned with
// zero rows). Rather than force a full re-fetch of the whole workspace,
// backfill per cloned DB: capture the view, and — for linked-view stubs whose
// own data source is empty — resolve the rows from the view's source data
// source, localize their media, then patch the raw JSON and re-render. Cheap
// relative to `--force` (no page/block re-fetch) and one-time: once the raw
// carries view + rows, the next run's clone carries them forward and this
// skips the DB.
async function backfillSkippedDatabaseViews(
  ctx: PhaseContext,
  notion: RateLimitedNotion,
  renderCtx: RenderContext,
): Promise<void> {
  const schemaCache = createDataSourceSchemaCache(notion, ctx.log);
  const sourceRowsCache = new Map<string, Promise<unknown[]>>();
  const sourceRows = (dsId: string) => {
    let p = sourceRowsCache.get(dsId);
    if (!p) {
      p = queryDataSourceRows(notion, dsId);
      sourceRowsCache.set(dsId, p);
    }
    return p;
  };
  const refreshRowPage = async (pageId: string) => {
    try {
      return await notion.run((c) => c.pages.retrieve({ page_id: pageId }));
    } catch (err) {
      ctx.log.debug({ pageId, err: (err as Error).message }, "backfill: row page refresh failed");
      return null;
    }
  };

  let views = 0;
  let linkedResolved = 0;
  for (const id of ctx.skipIds) {
    const obj = ctx.byId.get(id);
    if (obj?.object !== "database") continue;
    const dbData = ctx.dbDataById.get(id);
    if (!dbData?.database) continue;

    // Capture views if the clone didn't carry any — OR re-fetch for an
    // *unresolved linked-view stub*: zero rows + some view has a `rowOrder`
    // (the view query found rows) but none records a `dataSourceId` (the views
    // were captured by an older build). The re-fetch supplies the
    // `dataSourceId` the rescue below needs. Genuinely-empty DBs (no rowOrder)
    // never match, so they aren't re-fetched every run.
    let capturedViews = false;
    const hadViews = (dbData.views?.length ?? 0) > 0;
    const anyRowOrder = (dbData.views ?? []).some((v) => v.rowOrder.length > 0);
    const anySrc = (dbData.views ?? []).some((v) => v.view.dataSourceId);
    const unresolvedStub = dbData.rows.length === 0 && anyRowOrder && !anySrc;
    if (!hadViews || unresolvedStub) {
      const fetched = await fetchAllViews(notion, id, ctx.log);
      if (fetched.length) {
        dbData.views = fetched;
        capturedViews = true;
        if (!hadViews) views++;
      } else if (!hadViews) {
        continue;
      }
    }

    // Linked-view rescue: a stub cloned with zero rows whose views name a
    // source we can query. Pull every row any view shows (union of rowOrders)
    // + localize their media.
    const srcId = dbData.views?.find((v) => v.view.dataSourceId)?.view.dataSourceId;
    const needsRows =
      dbData.rows.length === 0 &&
      !!srcId &&
      (dbData.views ?? []).some((v) => v.rowOrder.length > 0);
    if (needsRows && srcId) {
      const union = [...new Set((dbData.views ?? []).flatMap((v) => v.rowOrder))];
      const resolved = filterRowsToOrder(await sourceRows(srcId), union);
      if (ctx.cfg.render.rowMedia) {
        await Promise.all(
          resolved.map((row) => localizeRowCoverIcon(row, ctx.assets, ctx.log, refreshRowPage)),
        );
      }
      dbData.rows = resolved as DbData["rows"];
      if (!dbData.dataSource) dbData.dataSource = await schemaCache(srcId);
      linkedResolved++;
    } else if (!capturedViews) {
      // Nothing to do: already had views and isn't an unresolved stub.
      continue;
    }

    const rawData = {
      database: dbData.database,
      rows: dbData.rows,
      ...(dbData.dataSource ? { dataSource: dbData.dataSource } : {}),
      ...(dbData.views ? { views: dbData.views } : {}),
    };
    await writeRawJson(ctx.paths.raw, RAW_DATABASES, { id, title: obj.title }, rawData, {
      pretty: ctx.cfg.io.prettyRawJson,
    });
    // Re-render the standalone DB page — overwrites the cloned HTML.
    await renderDatabase(renderCtx, {
      id,
      title: obj.title,
      database: dbData.database,
      rows: dbData.rows,
      ...(dbData.dataSource ? { dataSource: dbData.dataSource } : {}),
      ...(dbData.views ? { views: dbData.views } : {}),
    });
  }
  if (views > 0 || linkedResolved > 0) {
    ctx.log.info(
      { views, linkedResolved },
      "incremental: backfilled primary views into cloned databases",
    );
  }
}

async function localizeRequiredAttachments(raw: unknown, ctx: PhaseContext): Promise<void> {
  for (const requirement of attachmentRequirements(raw)) {
    if (requirement.target.local_path) continue;
    const record = await ctx.assets.collect(requirement.url);
    requirement.target.local_path = record.localPath;
  }
}

// --- Phase: fetch + render databases (phase 1) ------------------------------
// Pages can inline a child_database block as a live-style table view, so we
// process databases first and stash rows in `dbDataById` for the page phase.
async function fetchAndRenderDatabases(
  ctx: PhaseContext,
  notion: RateLimitedNotion,
  renderCtx: RenderContext,
  toFetch: DiscoveredObject[],
  opts: ExportOptions,
): Promise<ExportCounts> {
  // Shared schema cache so multiple databases that point at the same
  // `data_source_id` (e.g. an inline view + its source DB) share a single
  // API call. Limited to this phase's lifetime — rerender/repair read the
  // schema from raw JSON, not via the network.
  const dataSourceSchema = createDataSourceSchemaCache(notion, ctx.log);
  // All-views resolver (Views API). No cache needed — each DB is exported
  // once. rerender/repair read `views` from raw JSON, never the network.
  const allViews = (databaseId: string) => fetchAllViews(notion, databaseId, ctx.log);
  return exportAllJson({
    notion,
    objects: toFetch.filter((o) => o.object === "database"),
    log: ctx.log,
    concurrency: ctx.cfg.io.pageConcurrency,
    onProgress: opts.onProgress,
    dataSourceSchema,
    allViews,
    onPage: async () => {
      /* phase 1: databases only */
    },
    onDatabase: async (d: ExportedDatabase) => {
      // Download icon (mutates d.database in place so raw JSON keeps local_path).
      await resolveIconForPage(d.database, ctx.assets, ctx.log);
      // Pre-download row cover/icon images so inline gallery cards on the
      // parent page can render them without expired Notion S3 URLs. Row
      // media downloads can dominate runtime on media-heavy DBs — skip
      // entirely when the operator opted out via EXPORT_ROW_MEDIA=false.
      if (ctx.cfg.render.rowMedia) {
        const refreshRowPage = async (pageId: string) => {
          try {
            return await notion.run((c) => c.pages.retrieve({ page_id: pageId }));
          } catch (err) {
            ctx.log.debug(
              { pageId, err: (err as Error).message },
              "row media: page refresh failed",
            );
            return null;
          }
        };
        await Promise.all(
          d.rows.map((row) => localizeRowCoverIcon(row, ctx.assets, ctx.log, refreshRowPage)),
        );
      }
      // Honour the acquisition opt-out, while sealing still refuses missing required bytes.
      const attachmentRows = ctx.cfg.render.rowMedia
        ? d.rows
        : d.rows.map((row) => ({ ...(row as Record<string, unknown>), icon: null, cover: null }));
      await localizeRequiredAttachments({ database: d.database, rows: attachmentRows }, ctx);
      // Register in dbDataById AFTER the rows have local_path so any sibling
      // page rendering off this map sees the localized references. Forward
      // the data-source schema too so the renderer can read option order
      // without a second on-disk lookup.
      ctx.dbDataById.set(d.id, {
        database: d.database,
        rows: d.rows as DbData["rows"],
        title: d.title,
        ...(d.dataSource ? { dataSource: d.dataSource } : {}),
        ...(d.views ? { views: d.views } : {}),
      } as DbData);
      // Inline the schema + all views into the database raw JSON. Simpler for
      // rerender/repair (no second lookup table) at the cost of duplicating
      // the schema across databases that share a data source. The renderer
      // reads `parsed.dataSource` / `parsed.views` directly.
      const rawAbs = await writeRawJson(
        ctx.paths.raw,
        RAW_DATABASES,
        d,
        {
          database: d.database,
          rows: d.rows,
          ...(d.dataSource ? { dataSource: d.dataSource } : {}),
          ...(d.views ? { views: d.views } : {}),
        },
        { pretty: ctx.cfg.io.prettyRawJson },
      );
      const raw: RawDatabaseInput = {
        id: d.id,
        title: d.title,
        database: d.database,
        rows: d.rows,
        ...(d.dataSource ? { dataSource: d.dataSource } : {}),
        ...(d.views ? { views: d.views } : {}),
      };
      const rendered = await renderDatabase(renderCtx, raw);
      if (!rendered) return;
      const obj = ctx.byId.get(d.id);
      ctx.manifestEntries.push({
        id: d.id,
        kind: "database",
        title: d.title,
        rawAbs,
        lastEditedTime: obj?.lastEditedTime,
        parentId: obj?.parent.id,
      });
      const htmlRel = relUrl(ctx.paths.html, rendered.htmlAbs);
      ctx.sitemap.push({
        id: d.id,
        title: d.title,
        href: htmlRel,
        kind: "database",
        parentId: obj?.parent.id,
        icon: sitemapIconFromObj(d.database),
      });
      ctx.searchDocs.push({
        id: d.id,
        title: d.title,
        body: plainText(rendered.md),
        href: htmlRel,
        kind: "database",
      });
    },
  });
}

// --- Phase: fetch + render pages (phase 2) ----------------------------------
async function fetchAndRenderPages(
  ctx: PhaseContext,
  notion: RateLimitedNotion,
  renderCtx: RenderContext,
  toFetch: DiscoveredObject[],
  blocksCache: Map<string, NotionBlock[]>,
  opts: ExportOptions,
): Promise<ExportCounts> {
  return exportAllJson({
    notion,
    objects: toFetch.filter((o) => o.object === "page"),
    log: ctx.log,
    concurrency: ctx.cfg.io.pageConcurrency,
    onProgress: opts.onProgress,
    blocksCache,
    onPage: async (p: ExportedPage) => {
      await rewriteBlocksWithAssets(p.blocks, ctx.assets, ctx.log, async (blockId) => {
        try {
          return (await notion.run((c) =>
            c.blocks.retrieve({ block_id: blockId }),
          )) as unknown as NotionBlock;
        } catch (err) {
          ctx.log.debug({ blockId, err: (err as Error).message }, "block asset refresh failed");
          return null;
        }
      });

      // Download page icon + cover (mutates p.page so raw JSON keeps local_path)
      const refreshPage = async (pageId: string) => {
        try {
          return await notion.run((c) => c.pages.retrieve({ page_id: pageId }));
        } catch (err) {
          ctx.log.debug({ pageId, err: (err as Error).message }, "page asset refresh failed");
          return null;
        }
      };
      await resolveIconForPage(p.page, ctx.assets, ctx.log, refreshPage);
      await resolveCoverForPage(p.page, ctx.assets, ctx.log, refreshPage);

      // Scan this page's rich_text + properties for `:slug:` custom emoji
      // mentions and accumulate into the shared `customEmojiByName` map.
      // The pipeline's `enrichTitle` reads the same Map ref, so cross-page
      // link titles rendered later in this run resolve correctly. The
      // sidebar/titleHtml patch in `finalizeExport` covers anything rendered
      // before the page that introduced the emoji landed.
      const rawPageLike: RawPageLike = { page: p.page, blocks: p.blocks };
      await fetchCustomEmojis([rawPageLike], ctx.assets, ctx.log, ctx.customEmojiByName);

      // Fetch page-level comments. Failures (e.g. integration lacking the
      // "read comments" capability) are non-fatal — we still export the page,
      // just without its comments section. Once we observe a
      // `restricted_resource` error (the integration lacks the capability),
      // we set `commentsDisabled` and skip the call for every subsequent page
      // — the result would be the same 403 each time.
      let comments: NotionComment[] = [];
      if (!ctx.commentsDisabled) {
        try {
          comments = await fetchPageComments(notion, p.id);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "restricted_resource") {
            ctx.commentsDisabled = true;
            ctx.log.info(
              { code: "restricted_resource" },
              "comments capability missing on the Notion integration; skipping for remaining pages",
            );
          } else {
            ctx.log.warn(
              { id: p.id, err: (err as Error).message },
              "failed to fetch page comments; continuing without",
            );
          }
        }
      }

      await localizeRequiredAttachments({ page: p.page, blocks: p.blocks, comments }, ctx);
      const self = ctx.pageIndex.get(p.id);
      const fromDir = self ? path.dirname(self.mdAbsPath) : ctx.paths.markdown;
      const children = (ctx.childrenMap.get(p.id) ?? [])
        .map((c) => {
          const target = ctx.pageIndex.get(c.id);
          if (!target) return null;
          // Resolve the child's icon to a fromDir-relative reference.
          const ti = ctx.pageIcons.get(c.id);
          let icon: { kind: "emoji" | "image"; value: string } | undefined;
          if (ti?.kind === "emoji") {
            icon = { kind: "emoji", value: ti.value };
          } else if (ti?.kind === "image") {
            const abs = path.resolve(ctx.paths.root, ti.localPath);
            icon = { kind: "image", value: relUrl(fromDir, abs) };
          }
          return {
            href: relUrl(fromDir, target.mdAbsPath),
            title: target.title,
            kind: target.kind,
            ...(icon ? { icon } : {}),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const rawAbs = await writeRawJson(
        ctx.paths.raw,
        RAW_PAGES,
        p,
        { page: p.page, blocks: p.blocks, comments },
        { pretty: ctx.cfg.io.prettyRawJson },
      );
      const raw: RawPageInput = {
        id: p.id,
        title: p.title,
        page: p.page,
        blocks: p.blocks,
        comments,
      };
      const rendered = await renderPage(renderCtx, raw, {
        children,
        formatProp,
        notionUrlFallback: notionUrlFor(p.id),
      });
      if (!rendered) return;
      const obj = ctx.byId.get(p.id);
      ctx.manifestEntries.push({
        id: p.id,
        kind: "page",
        title: p.title,
        rawAbs,
        lastEditedTime: obj?.lastEditedTime,
        parentId: obj?.parent.id,
      });
      const htmlRel = relUrl(ctx.paths.html, rendered.htmlAbs);
      ctx.sitemap.push({
        id: p.id,
        title: p.title,
        href: htmlRel,
        kind: "page",
        parentId: obj?.parent.id,
        icon: sitemapIconFromObj(p.page),
      });
      ctx.searchDocs.push({
        id: p.id,
        title: p.title,
        body: plainText(rendered.md),
        href: htmlRel,
        kind: "page",
      });
    },
    onDatabase: async () => {
      /* phase 2: pages only — databases were handled in phase 1 */
    },
  });
}

// --- Phase: finalize --------------------------------------------------------
// Write stylesheet, search index, client assets, sitemap, sidebar, manifest.
async function finalizeExport(
  ctx: PhaseContext,
  exportTimestamp: string,
  archiveIcon: string,
  prevExport: { root: string; manifest: Manifest } | null,
  counts: ExportCounts,
  retention: number,
  outDir: string,
): Promise<{ manifest: Awaited<ReturnType<typeof writeManifest>>; failedAssetsCount: number }> {
  // Patch sitemap titleHtml from the (now complete) customEmojiByName map.
  // Without this, sidebar/index entries for pages whose `:slug:` shortcode
  // wasn't seen until *after* their sitemap entry was pushed would render
  // literal `:slug:` text instead of `<img class="custom-emoji">`.
  // Paths are root-relative; `injectSidebars` rewrites them per-page depth.
  if (ctx.customEmojiByName.size > 0) {
    for (const entry of ctx.sitemap) {
      const enriched = enrichSitemapTitleHtml(entry.title, ctx.customEmojiByName);
      if (enriched !== null) entry.titleHtml = enriched;
    }
  }
  const allAssets = [...ctx.assets.records(), ...ctx.carriedAssets];
  const failedAssets = ctx.assets.failures();
  const manifest = await finalizeSite({
    htmlDir: ctx.paths.html,
    rawDir: ctx.paths.raw,
    sitemap: ctx.sitemap,
    searchDocs: ctx.searchDocs,
    timestamp: exportTimestamp,
    archiveTitle: ctx.cfg.render.exportTitle,
    archiveIcon,
    persistManifest: () =>
      writeManifest({
        exportRoot: ctx.paths.root,
        manifestPath: ctx.paths.manifest,
        version: VERSION,
        timestamp: exportTimestamp,
        entries: ctx.manifestEntries,
        assets: allAssets,
        failedAssets,
        skipped: ctx.skipIds.size,
        basedOn: prevExport ? path.basename(prevExport.root) : undefined,
      }),
  });

  // A readable manifest is not a verified backup. Only mark the current
  // snapshot usable after its source inventory, raw JSON, and asset hashes
  // pass verification, and only then permit retention to run.
  const previousVerified = await findPreviousSourceInventory(outDir, path.basename(ctx.paths.root));
  await markSnapshotVerified(ctx.paths.root, ctx.objects, counts.errors, previousVerified);

  ctx.log.info(
    {
      pages: manifest.counts.pages,
      databases: manifest.counts.databases,
      assets: manifest.counts.assets,
      failedAssets: failedAssets.length,
      errors: counts.errors,
      skipped: ctx.skipIds.size,
      basedOn: manifest.basedOn,
    },
    "export complete",
  );
  if (failedAssets.length > 0) {
    // Strip query+fragment from each sample URL — raw Notion S3 URLs carry
    // X-Amz-Signature + X-Amz-Security-Token in the query, and warn-level logs
    // typically land in shareable run output, so strip secrets here too.
    ctx.log.warn(
      {
        count: failedAssets.length,
        sample: failedAssets.slice(0, 3).map((f) => safeUrlForLog(f.url)),
      },
      "some assets failed; see manifest.failedAssets for the full list",
    );
  }
  if (retention > 0) {
    await applyRetention(outDir, retention, ctx.log);
  }
  return { manifest, failedAssetsCount: failedAssets.length };
}

// Expansion walks every page's full block tree (~15 API calls per page) just
// to find child_page/child_database blocks. For a page whose lastEditedTime
// matches the previous export, its raw JSON already holds that exact tree —
// the same equality the incremental skip set trusts — so read it from disk.
async function previousBlocksReader(
  outDir: string,
): Promise<((obj: DiscoveredObject) => Promise<NotionBlock[] | null>) | undefined> {
  const prev = await findVerifiedPreviousExport(outDir);
  if (!prev) return undefined;
  const entries = new Map(prev.manifest.entries.map((e) => [e.id, e]));
  return async (obj) => {
    const e = entries.get(obj.id);
    if (e?.kind !== "page" || !obj.lastEditedTime || e.lastEditedTime !== obj.lastEditedTime) {
      return null;
    }
    const raw = JSON.parse(
      await fsp.readFile(await assertWithinRootAsync(prev.root, e.rawPath), "utf8"),
    ) as { blocks?: unknown };
    return Array.isArray(raw.blocks) ? (raw.blocks as NotionBlock[]) : null;
  };
}

// --- Phase: discover incremental skip candidates ----------------------------
// Build the skip set by diffing this crawl's `lastEditedTime` values against
// the previous export's manifest. Returns the previous export reference (or
// null), so the caller can wire it into the clone phase + manifest.
async function discoverIncrementalCandidates(
  log: Logger,
  outDir: string,
  paths: ExportPaths,
  objects: DiscoveredObject[],
  skipIds: Set<string>,
): Promise<{ root: string; manifest: Manifest } | null> {
  const prevExport = await findVerifiedPreviousExport(outDir, path.basename(paths.root));
  if (!prevExport) {
    log.info("incremental: no previous export found, falling through to full");
    return null;
  }
  log.info({ basedOn: path.basename(prevExport.root) }, "incremental: using previous export");
  const prevByid = new Map(prevExport.manifest.entries.map((e) => [e.id, e]));
  for (const o of objects) {
    if (!o.lastEditedTime) continue;
    const prev = prevByid.get(o.id);
    if (prev && prev.lastEditedTime === o.lastEditedTime) {
      skipIds.add(o.id);
    }
  }
  log.info({ skip: skipIds.size, total: objects.length }, "incremental: skip candidates");
  return prevExport;
}

export async function runExport(
  cfg: Config,
  log: Logger,
  opts: ExportOptions,
): Promise<ExportResult> {
  const token = requireToken(cfg);
  const notion = new RateLimitedNotion({
    token,
    log,
    minTime: cfg.notion.minTime,
    maxConcurrent: cfg.notion.maxConcurrent,
    maxRetries: cfg.notion.maxRetries,
  });
  const outDir = opts.outDir ?? cfg.io.outDir;
  const retention = opts.retention ?? cfg.io.retention;

  log.info("crawling workspace");
  // Notion's search endpoint only returns pages the integration has direct
  // access to. Walk block trees so we also pick up subpages (child_page blocks)
  // — and reuse those fetched blocks when running the page export pass below.
  const blocksCache = new Map<string, NotionBlock[]>();
  const objects = await crawlAll(notion, {
    expandChildPages: cfg.crawl.expandChildPages,
    concurrency: cfg.crawl.concurrency,
    blocksCache,
    reuseBlocks: opts.incremental ? await previousBlocksReader(outDir) : undefined,
    log,
    onDiscoveryProgress: opts.onProgress
      ? (s) =>
          opts.onProgress?.({
            kind: "crawl",
            visited: s.visited,
            queued: s.queued,
            total: s.total,
          } as ProgressEvent)
      : undefined,
  });
  log.info({ count: objects.length }, "discovered objects");

  if (opts.dryRun) {
    for (const o of objects) {
      process.stdout.write(`${o.object}\t${o.id}\t${o.title}\n`);
    }
    return {
      dryRun: true,
      objects,
      pages: objects.filter((o) => o.object === "page").length,
      databases: objects.filter((o) => o.object === "database").length,
      assets: 0,
      errors: 0,
      skipped: 0,
    };
  }

  let paths = buildPaths(outDir);
  let resumed = false;
  if (opts.resume) {
    const partial = await findPartialExport(outDir);
    if (partial) {
      paths = buildPaths(outDir, path.basename(partial));
      resumed = true;
      log.info({ root: paths.root }, "resume: continuing partial export");
    } else {
      log.info("resume: no partial export found, starting fresh");
    }
  }
  await fsp.mkdir(paths.root, { recursive: true });
  if (!resumed) log.info({ root: paths.root }, "export root created");

  const skipIds = new Set<string>();
  const prevExport = opts.incremental
    ? await discoverIncrementalCandidates(log, outDir, paths, objects, skipIds)
    : null;

  const hierarchy = buildHierarchy(objects);
  const pageIndex = buildPageIndex(objects, hierarchy, paths.markdown);
  const childrenMap = buildChildrenMap(objects);
  const byId = new Map(objects.map((o) => [o.id, o] as const));
  const exportTimestamp = new Date().toISOString();
  const assets = createAssetCollector({
    assetsDir: paths.assets,
    exportRoot: paths.root,
    log,
    concurrency: cfg.io.assetConcurrency,
    onDownloaded: opts.onAsset,
  });

  // If EXPORT_ICON is a URL, download it once so the sidebar shows the
  // workspace icon offline. Result is either a local `assets/<hash>.png`
  // path, the raw URL fallback, or the original glyph.
  const archiveIcon =
    (await resolveArchiveIcon(cfg.render.exportIcon, (u) => assets.collect(u))) ??
    cfg.render.exportIcon;

  const phaseCtx: PhaseContext = {
    cfg,
    log,
    paths,
    objects,
    byId,
    hierarchy,
    pageIndex,
    childrenMap,
    pageIcons: new Map(),
    assets,
    skipIds,
    manifestEntries: [],
    sitemap: [],
    searchDocs: [],
    carriedAssets: [],
    dbDataById: new Map(),
    customEmojiByName: new Map(),
    commentsDisabled: false,
  };

  await prefetchPageIcons(phaseCtx, notion);
  if (resumed) await rehydrateResume(phaseCtx);
  if (prevExport && skipIds.size > 0) await cloneIncremental(phaseCtx, prevExport);
  await preloadSkippedDatabases(phaseCtx);

  const renderCtx: RenderContext = {
    paths,
    pageIndex,
    dbDataById: phaseCtx.dbDataById,
    // Shared map ref — accumulated by `onPage` as new pages bring in emojis.
    // Cross-page link titles rendered later in the run see earlier additions;
    // sitemap titleHtml is patched in `finalizeExport` from the complete map.
    customEmojiByName: phaseCtx.customEmojiByName,
    archiveIcon,
    archiveTitle: cfg.render.exportTitle,
    cfg,
    assets,
    log,
    exportTimestamp,
    ancestorIds: (id) => ancestorIds(id, byId),
    pageIcons: phaseCtx.pageIcons,
  };

  // Backfill views into unchanged DBs cloned from a pre-Views-API export, so
  // a normal incremental run captures them without a costly `--force`.
  if (prevExport && skipIds.size > 0) {
    await backfillSkippedDatabaseViews(phaseCtx, notion, renderCtx);
  }

  const toFetch = objects.filter((o) => !skipIds.has(o.id));
  const dbCounts = await fetchAndRenderDatabases(phaseCtx, notion, renderCtx, toFetch, opts);
  const pageCounts = await fetchAndRenderPages(
    phaseCtx,
    notion,
    renderCtx,
    toFetch,
    blocksCache,
    opts,
  );
  const counts: ExportCounts = {
    pages: pageCounts.pages,
    databases: dbCounts.databases,
    errors: dbCounts.errors + pageCounts.errors,
  };

  const { manifest } = await finalizeExport(
    phaseCtx,
    exportTimestamp,
    archiveIcon,
    prevExport,
    counts,
    retention,
    outDir,
  );

  return {
    dryRun: false,
    objects,
    pages: manifest.counts.pages,
    databases: manifest.counts.databases,
    assets: manifest.counts.assets,
    errors: counts.errors,
    skipped: skipIds.size,
    basedOn: manifest.basedOn,
    exportRoot: paths.root,
  };
}
