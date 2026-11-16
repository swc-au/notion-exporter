// Shared rendering pipeline used by every command that produces markdown +
// html from raw Notion JSON.
//
// `runExport`, `runRerender`, and `runRepair` each independently fetch (or
// load from disk) a different shape of input — but the act of turning a
// raw page/database into markdown + html on disk is identical. This module
// owns that single per-page render so the three command files cannot drift.
//
// The duplication previously caused a regression: `repair.ts` silently
// passed only 4 of the 10 `MarkdownOptions` fields, dropping breadcrumbs,
// children, properties, etc. on repaired pages. With one renderer in one
// place, that class of bug is eliminated by construction.

import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { NotionBlock } from "../notion/blocks.js";
import { collectChildDbIds } from "../notion/blocks.js";
import type { NotionComment } from "../notion/comments.js";
import type { DataSourceSchema } from "../notion/dataSourceSchema.js";
import { rebuildCoverMeta, rebuildIconMeta } from "../notion/meta.js";
import type { ViewWithOrder } from "../notion/views.js";
import { assertWithinRoot } from "../util/fs.js";
import type { AssetCollector } from "./assets.js";
import { writeHtml } from "./html.js";
import { escapeHtmlText as attrEsc } from "./htmlEscape.js";
import { buildMarkdownOptions } from "./markdown/types.js";
import { mdUrl, safeLinkUrl } from "./markdown/util.js";
import {
  type ChildDatabaseData,
  databaseToMarkdown,
  HTML_EMITTING_PROP_TYPES,
  mdLinksToAnchors,
  type PageChrome,
  type PageHeader,
  type PageLink,
  pageToMarkdown,
  type RenderServices,
  writeMarkdown,
} from "./markdown.js";
import { type ExportPaths, relUrl, UNTITLED_DB } from "./paths.js";
import { enrichTitleHtml } from "./titleHtml.js";

/** A document on disk — the renderer's input lookup table for cross-page links. */
export interface DocRef {
  id: string;
  title: string;
  kind: "page" | "database";
  /** Absolute path to the markdown file under `paths.markdown`. */
  mdAbsPath: string;
  /** Markdown-root-relative subdirectory the file lives in (mirrors the
   * hierarchy). May be empty for top-level pages. */
  subdir?: string;
  parentId?: string;
}

/** A database loaded into memory so child_database blocks on parent pages
 * can render inline gallery/table views. */
export interface DbData {
  database: unknown;
  rows: Array<{
    id?: string;
    icon?: {
      type?: string;
      emoji?: string;
      file?: { local_path?: string };
      external?: { local_path?: string };
    } | null;
    cover?: {
      file?: { local_path?: string };
      external?: { local_path?: string };
    } | null;
    [k: string]: unknown;
  }>;
  /** Optional pre-resolved title (falls back to `database.title[].plain_text`). */
  title?: string;
  /** Notion's canonical data-source schema. Persisted in raw DB JSON during
   * the crawl (and rehydrated during incremental/resume), so the renderer
   * can use the workspace's option order. `undefined` for older exports;
   * the renderer falls back to legacy heuristics. */
  dataSource?: DataSourceSchema;
  /** All views (Views API), in tab order — config + per-view filtered/sorted
   * row order. Drives the tabbed multi-view renderer. `undefined` for older
   * exports (renderer falls back to heuristics). */
  views?: ViewWithOrder[];
}

/** A breadcrumb chain produced by walking parent ids backward from a page. */
export type AncestorChain = (id: string) => string[];

export interface RenderContext {
  paths: ExportPaths;
  pageIndex: Map<string, DocRef>;
  dbDataById: Map<string, DbData>;
  /** `:name:` → root-relative `assets/<hash>.<ext>`. Used to inline custom
   * emojis into titles. */
  customEmojiByName: Map<string, string>;
  /** Resolved workspace icon (emoji glyph, root-relative asset path, or URL). */
  archiveIcon: string;
  archiveTitle: string;
  cfg: Config;
  assets: AssetCollector;
  log: Logger;
  exportTimestamp: string;
  /** Walk parent chain → ordered list of ancestor ids (excluding self).
   * Each command knows its own parent-resolution strategy. */
  ancestorIds: AncestorChain;
  /** Optional: pre-resolved per-page icon, used by `runExport` when it has
   * already downloaded the icon during the crawl phase. Falls back to
   * `rebuildIconMeta` when absent. */
  pageIcons?: Map<string, { kind: "emoji"; value: string } | { kind: "image"; localPath: string }>;
}

/** A loaded raw page — either from a freshly-fetched `ExportedPage` or a
 * `raw/pages/*.json` read off disk. */
export interface RawPageInput {
  id: string;
  title: string;
  page: unknown;
  blocks: NotionBlock[];
  /** Page-level Notion comments. Absent on older raw JSON; renderer treats
   * missing/empty as "no comments". */
  comments?: NotionComment[];
}

export interface RawDatabaseInput {
  id: string;
  title: string;
  database: unknown;
  rows: unknown[];
  /** Canonical option order for status/select/multi_select columns.
   * Threaded into `databaseToMarkdown` via `ChildDatabaseData.dataSource` so
   * standalone DB pages render kanban columns + filter chips in workspace
   * order. `undefined` for older raw JSON. */
  dataSource?: DataSourceSchema;
  /** All views (Views API) for a standalone DB page, threaded into
   * `databaseToMarkdown` via `ChildDatabaseData`. `undefined` for older raw. */
  views?: ViewWithOrder[];
}

/** What the renderer wrote on disk for one page. Callers use this to build
 * sitemap/manifest entries. */
export interface RenderedDoc {
  htmlAbs: string;
  mdAbs: string;
  md: string;
}

/** Replace `:name:` patterns in a plain-text title with inline `<img>` for
 * any custom emoji available in the context.
 *
 * SECURITY: `local` comes from `customEmojiByName`, which is populated
 * either by the asset collector (sha-named, safe) OR from raw-JSON-disk
 * `custom_emoji.local_path` (operator-untrusted on a tampered raw tree).
 * `path.relative` will preserve a quote-bearing string verbatim, so the
 * shared helper's `urlEsc` is what keeps a quote-bearing local_path from
 * escaping the `src="…"` attribute. The whole title is also attr-escaped
 * before the shortcode swap — see `enrichTitleHtml`. */
function enrichTitle(title: string, fromDir: string, ctx: RenderContext): string {
  return enrichTitleHtml(title, ctx.customEmojiByName, (local) =>
    relUrl(fromDir, assertWithinRoot(ctx.paths.root, local)),
  );
}

function iconForLink(
  ctx: RenderContext,
  targetId: string,
  fromDir: string,
): { kind: "emoji" | "image"; value: string } | undefined {
  // Prefer the pre-resolved map (export-time).
  const pre = ctx.pageIcons?.get(targetId);
  if (pre) {
    if (pre.kind === "emoji") return { kind: "emoji", value: pre.value };
    const abs = path.resolve(ctx.paths.root, pre.localPath);
    return { kind: "image", value: relUrl(fromDir, abs) };
  }
  // Fall back to walking raw page/db in dbDataById/page (rerender path
  // supplies this via the raw page index, but for export we don't need it
  // because pageIcons is always populated).
  const rawDb = ctx.dbDataById.get(targetId);
  if (rawDb?.database) {
    const m = rebuildIconMeta(rawDb.database, ctx.paths.root, fromDir);
    if (m) return m;
  }
  return undefined;
}

/** Build the per-page `resolveLink` closure. */
function makeResolveLink(
  ctx: RenderContext,
  fromDir: string,
  rawPageById?: Map<string, RawPageInput>,
) {
  return (id: string) => {
    const target = ctx.pageIndex.get(id);
    if (!target) return null;
    let icon = iconForLink(ctx, id, fromDir);
    if (!icon && rawPageById) {
      const raw = rawPageById.get(id);
      if (raw?.page) {
        const m = rebuildIconMeta(raw.page, ctx.paths.root, fromDir);
        if (m) icon = m;
      }
    }
    return {
      href: relUrl(fromDir, target.mdAbsPath),
      title: target.title,
      titleHtml: enrichTitle(target.title, fromDir, ctx),
      kind: target.kind,
      ...(icon ? { icon } : {}),
    };
  };
}

/** Walk the block tree once and collect every `child_database` block id
 * whose ancestor chain crosses a `column_list`. The markdown renderer uses
 * the resulting set to flip its compact-card-list short-circuit for small
 * inline DBs that would otherwise produce a wall of mini-tables inside a
 * multi-column row. Exported so the walk itself can be unit-tested apart
 * from the renderer. */
export function collectChildDbsInColumnList(
  blocks: NotionBlock[],
  out: Set<string> = new Set(),
  insideColumnList = false,
): Set<string> {
  for (const b of blocks) {
    const nestedInside = insideColumnList || b.type === "column_list";
    if (nestedInside && b.type === "child_database") out.add(b.id);
    if (b.children?.length) collectChildDbsInColumnList(b.children, out, nestedInside);
  }
  return out;
}

function buildChildDatabasesFor(
  ctx: RenderContext,
  blocks: NotionBlock[],
  fromDir: string,
): Map<string, ChildDatabaseData> {
  const out = new Map<string, ChildDatabaseData>();
  const inColumnListIds = collectChildDbsInColumnList(blocks);
  for (const dbId of collectChildDbIds(blocks)) {
    const raw = ctx.dbDataById.get(dbId);
    if (!raw?.database) continue;
    const target = ctx.pageIndex.get(dbId);
    const href = target ? relUrl(fromDir, target.mdAbsPath) : undefined;
    const rowCovers = new Map<string, string>();
    const rowIcons = new Map<string, string>();
    const rowHrefs = new Map<string, string>();
    for (const row of raw.rows ?? []) {
      if (!row.id) continue;
      const coverLocal = row.cover?.file?.local_path ?? row.cover?.external?.local_path;
      if (coverLocal) {
        rowCovers.set(row.id, relUrl(fromDir, assertWithinRoot(ctx.paths.root, coverLocal)));
      }
      const iconLocal = row.icon?.file?.local_path ?? row.icon?.external?.local_path;
      if (iconLocal) {
        rowIcons.set(row.id, relUrl(fromDir, assertWithinRoot(ctx.paths.root, iconLocal)));
      }
      const rowTarget = ctx.pageIndex.get(row.id);
      if (rowTarget) {
        rowHrefs.set(row.id, relUrl(fromDir, rowTarget.mdAbsPath));
      }
    }
    const titleText =
      raw.title ??
      (raw.database as { title?: Array<{ plain_text?: string }> })?.title
        ?.map((t) => t.plain_text ?? "")
        .join("") ??
      "";
    out.set(dbId, {
      title: titleText || target?.title || UNTITLED_DB,
      database: raw.database,
      rows: raw.rows ?? [],
      ...(href ? { href } : {}),
      rowCovers,
      rowIcons,
      rowHrefs,
      ...(raw.dataSource ? { dataSource: raw.dataSource } : {}),
      ...(raw.views ? { views: raw.views } : {}),
      ...(inColumnListIds.has(dbId) ? { inColumnList: true } : {}),
    });
  }
  resolveLinkedDbStubs(out);
  return out;
}

/** A Notion "linked view of database" block (the "+ Linked view of database"
 * picker) is exposed via the REST API as a `child_database` block whose
 * retrieve returns an empty stub: `data_sources: []`, no `properties`, no
 * rows. The API does not expose the source DB id or the view's filters /
 * sort, so the stub is otherwise un-resolvable.
 *
 * Heuristic: when the page contains a linked-stub AND exactly one non-empty
 * DB, alias every stub to that source. Operators see the source DB's full
 * row set (filters from the linked view are not recoverable). When the
 * heuristic can't pick unambiguously, the stub stays empty.
 */
function resolveLinkedDbStubs(out: Map<string, ChildDatabaseData>): void {
  const stubs: string[] = [];
  const sources: string[] = [];
  for (const [id, entry] of out) {
    if (isLinkedDbStub(entry)) stubs.push(id);
    else sources.push(id);
  }
  if (stubs.length === 0 || sources.length !== 1) return;
  const [sourceId] = sources;
  if (!sourceId) return;
  const source = out.get(sourceId);
  if (!source) return;
  for (const stubId of stubs) {
    const stub = out.get(stubId);
    if (!stub) continue;
    // Preserve the stub's title ("Ansicht: Flur") so operators can still
    // distinguish each linked view; everything else (database, rows,
    // dataSource, hrefs) comes from the source.
    out.set(stubId, { ...source, title: stub.title, linkedSource: true });
  }
}

function isLinkedDbStub(entry: ChildDatabaseData): boolean {
  const db = entry.database as
    | { data_sources?: unknown[]; properties?: Record<string, unknown> }
    | null
    | undefined;
  const ds = db?.data_sources;
  if (!Array.isArray(ds) || ds.length > 0) return false;
  if ((entry.rows?.length ?? 0) > 0) return false;
  return Object.keys(db?.properties ?? {}).length === 0;
}

// v7-tech-debt MED-1: `attrEsc` was a 4th near-identical copy of the shared
// escape primitive — consolidated into `./htmlEscape.ts`. Imported above as
// a local alias (`attrEsc`) so call sites stay readable.

// `HTML_EMITTING_PROP_TYPES` lives in `markdown.ts` next to `formatProp` so
// the two cannot drift; imported above.

/** Format DB-row-page properties (Notion data_source_id parent). Returns an
 * empty list for regular pages whose "Name"/title is rendered as the heading.
 *
 * SECURITY: `formatProp` has a MIXED return contract — relation/rollup/title/
 * rich_text emit final HTML; everything else returns raw text. Because the
 * downstream `renderPropertyTable` interpolates the value into `<td>${value}</td>`
 * with no escape, this function must HTML-escape the raw-text branches before
 * returning. Without it, a workspace member's select option named
 * `<img src=x onerror=alert(1)>` would ship clickable XSS into every DB-row
 * page-properties table.
 *
 * MARKDOWN-LINK LEAK: for `title` / `rich_text` the formatProp
 * output goes through `rt()`, which emits `[text](url)` markdown for href
 * annotations. The page-props table inlines the value into `<td>${p.value}</td>`
 * with no marked-pass, so without the `mdLinksToAnchors` conversion users
 * see literal brackets in the cell. `relation` already emits final `<a>` HTML;
 * `rollup`'s formatProp output goes through `mdLinksToAnchors` inside the
 * renderer's `renderPropertyValue`, but the page-props path skips that helper
 * — so we re-apply it here for `rollup` too.
 */
function pagePropertiesRow(
  page: unknown,
  resolveLink: (id: string) => PageLink | null,
  formatProp: (v: unknown, resolveLink?: (id: string) => PageLink | null) => string,
): Array<{ name: string; value: string }> {
  const p = page as {
    parent?: { type?: string };
    properties?: Record<string, { type?: string }>;
  };
  if (p?.parent?.type !== "database_id" && p?.parent?.type !== "data_source_id") {
    return [];
  }
  const rows: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(p.properties ?? {})) {
    if (value?.type === "title") continue;
    const formatted = formatProp(value, resolveLink);
    if (!formatted) continue;
    const type = value?.type ?? "";
    let safeValue: string;
    if (type === "title" || type === "rich_text" || type === "rollup") {
      // Convert any `[text](url)` spans `rt()` produced for href annotations
      // into inline `<a>` anchors so the `<td>` doesn't surface literal
      // brackets. Relation HTML doesn't contain markdown link syntax so we
      // pass it through without running the regex (saves work + avoids a
      // double-process if relation HTML ever grew bracketed body text).
      safeValue = mdLinksToAnchors(formatted);
    } else if (type === "url") {
      const href = safeLinkUrl(formatted);
      const label = attrEsc(formatted);
      safeValue = href === "#" ? label : `<a href="${attrEsc(mdUrl(href))}">${label}</a>`;
    } else if (HTML_EMITTING_PROP_TYPES.has(type)) {
      safeValue = formatted;
    } else {
      safeValue = attrEsc(formatted);
    }
    rows.push({ name, value: safeValue });
  }
  return rows;
}

/** Render one page → write markdown + html, return the on-disk paths.
 *
 * Builds ALL ten `MarkdownOptions` fields every time (icon, cover,
 * breadcrumbs, lastEditedTime, exportedAt, notionUrl, titleHtml,
 * resolveLink, children, properties, childDatabases). Caller-supplied
 * options merge into the defaults — used by `runExport` to inject its
 * pre-built `children` list (DiscoveredObject-derived). */
export async function renderPage(
  ctx: RenderContext,
  raw: RawPageInput,
  opts: {
    /** Additional `children` page links derived from the parent crawl —
     * only meaningful for `runExport`. Other commands omit this; the
     * markdown renderer will dedupe against in-body `child_page` blocks. */
    children?: Array<{
      href: string;
      title: string;
      kind: "page" | "database";
      icon?: { kind: "emoji" | "image"; value: string };
    }>;
    /** When `formatProp` is supplied, properties row is rendered for DB-row
     * pages. Required for `runExport`; other commands pass it too so the
     * row property table doesn't regress. */
    formatProp?: (v: unknown, resolveLink?: (id: string) => PageLink | null) => string;
    /** Optional raw-page index, used by `resolveLink` to look up icons on
     * pages that aren't in `ctx.pageIcons` (rerender path). */
    rawPageById?: Map<string, RawPageInput>;
    /** Notion canonical URL fallback when raw page doesn't carry `url`. */
    notionUrlFallback?: string;
  } = {},
): Promise<RenderedDoc | null> {
  const self = ctx.pageIndex.get(raw.id);
  if (!self) return null;
  const subdir = self.subdir ?? path.relative(ctx.paths.markdown, path.dirname(self.mdAbsPath));
  const fromDir = path.dirname(self.mdAbsPath);

  const iconMeta = rebuildIconMeta(raw.page, ctx.paths.root, fromDir);
  const coverMeta = rebuildCoverMeta(raw.page, ctx.paths.root, fromDir);
  const resolveLink = makeResolveLink(ctx, fromDir, opts.rawPageById);

  const childDatabases = buildChildDatabasesFor(ctx, raw.blocks, fromDir);
  const breadcrumbs = ctx
    .ancestorIds(raw.id)
    .map((aid) => resolveLink(aid))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const properties = opts.formatProp
    ? pagePropertiesRow(raw.page, resolveLink, opts.formatProp)
    : [];

  const p = raw.page as { last_edited_time?: string; url?: string } | null;
  const titleHtml = enrichTitle(self.title, fromDir, ctx);

  // Build the three MarkdownOptions groups explicitly. Spreading them
  // separately (rather than inlining all fields) makes a missing group
  // visible at the callsite — past regressions came from callers that
  // quietly omitted chrome data because everything was optional.
  const header: PageHeader = {
    icon: iconMeta ?? undefined,
    coverSrc: coverMeta ?? undefined,
    breadcrumbs,
    lastEditedTime: p?.last_edited_time ?? undefined,
    exportedAt: ctx.exportTimestamp,
    notionUrl: p?.url ?? opts.notionUrlFallback,
    titleHtml,
  };
  const services: RenderServices = {
    assetPrefix: `${relUrl(fromDir, ctx.paths.root)}/`,
    resolveLink,
    childDatabases,
    dbView: ctx.cfg.render.dbView,
  };
  const chrome: PageChrome = {
    children: opts.children ?? [],
    properties,
    comments: raw.comments ?? [],
  };

  const md = pageToMarkdown(
    { id: raw.id, title: self.title, page: raw.page, blocks: raw.blocks },
    buildMarkdownOptions(header, services, chrome),
  );
  const mdAbs = await writeMarkdown(
    ctx.paths.markdown,
    { id: raw.id, title: self.title },
    md,
    subdir,
  );
  const htmlAbs = await writeHtml(ctx.paths.html, { id: raw.id, title: self.title }, md, subdir, {
    archiveTitle: ctx.archiveTitle,
    archiveIcon: ctx.archiveIcon,
    styleBackLinks: ctx.cfg.render.backLinks,
    favicon: iconMeta ?? undefined,
    pageTitleHtml: titleHtml,
  });
  return { mdAbs, htmlAbs, md };
}

/** Render a standalone database page (the file users see when they click a
 * sidebar database link). Inline-DB rendering on a parent page is handled
 * by `renderPage` via `childDatabases`. */
export async function renderDatabase(
  ctx: RenderContext,
  raw: RawDatabaseInput,
): Promise<RenderedDoc | null> {
  const self = ctx.pageIndex.get(raw.id);
  if (!self) return null;
  const subdir = self.subdir ?? path.relative(ctx.paths.markdown, path.dirname(self.mdAbsPath));
  const fromDir = path.dirname(self.mdAbsPath);

  const iconMeta = rebuildIconMeta(raw.database, ctx.paths.root, fromDir);
  const resolveLink = makeResolveLink(ctx, fromDir);
  const breadcrumbs = ctx
    .ancestorIds(raw.id)
    .map((aid) => resolveLink(aid))
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const titleHtml = enrichTitle(self.title, fromDir, ctx);

  // Same three-group construction as renderPage — standalone DB pages don't
  // need chrome data (no children list, no property table), but we still
  // declare the empty group explicitly so a future addition has an obvious
  // place to land.
  const header: PageHeader = {
    icon: iconMeta ?? undefined,
    breadcrumbs,
    titleHtml,
  };
  const services: RenderServices = {
    resolveLink,
    dbView: ctx.cfg.render.dbView,
  };

  const md = databaseToMarkdown(
    {
      id: raw.id,
      title: self.title,
      database: raw.database,
      rows: raw.rows,
      ...(raw.dataSource ? { dataSource: raw.dataSource } : {}),
      ...(raw.views ? { views: raw.views } : {}),
    },
    buildMarkdownOptions(header, services),
  );
  const mdAbs = await writeMarkdown(
    ctx.paths.markdown,
    { id: raw.id, title: self.title },
    md,
    subdir,
  );
  const htmlAbs = await writeHtml(ctx.paths.html, { id: raw.id, title: self.title }, md, subdir, {
    archiveTitle: ctx.archiveTitle,
    archiveIcon: ctx.archiveIcon,
    styleBackLinks: ctx.cfg.render.backLinks,
    favicon: iconMeta ?? undefined,
    pageTitleHtml: titleHtml,
  });
  return { mdAbs, htmlAbs, md };
}
