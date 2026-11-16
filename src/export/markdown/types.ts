// Shared types used across the split markdown renderer modules.
// Re-exported from `src/export/markdown.ts` for external consumers.

import type { Logger } from "../../logger.js";
import type { NotionComment } from "../../notion/comments.js";
import type { DataSourceSchema } from "../../notion/dataSourceSchema.js";
import type { ViewWithOrder } from "../../notion/views.js";

export interface MentionRef {
  type?: "page" | "database" | "user" | "date" | "link_preview" | "custom_emoji";
  page?: { id?: string };
  database?: { id?: string };
  user?: { id?: string; name?: string };
  date?: { start?: string; end?: string };
  link_preview?: { url?: string };
  custom_emoji?: { id?: string; name?: string; url?: string };
}

export interface RichTextItem {
  type?: "text" | "mention" | "equation";
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    /** Notion color names: `default`, color, or `<color>_background`. */
    color?: string;
  };
  mention?: MentionRef;
  equation?: { expression?: string };
  text?: { content?: string; link?: { url?: string } | null };
}

export type RichText = RichTextItem[];

export interface PageLink {
  href: string;
  title: string;
  kind: "page" | "database";
  /** Optional target-page icon. Emoji char OR relative URL to image asset. */
  icon?: { kind: "emoji" | "image"; value: string };
  /** Already-HTML-safe rendering of the title (e.g. with `:name:` custom
   * emojis replaced by `<img>`). When set, the renderer uses this verbatim
   * instead of HTML-escaping `title`. */
  titleHtml?: string;
}

export interface PageMeta {
  /** Emoji glyph, or relative URL (image) to render before the title. */
  icon?: { kind: "emoji" | "image"; value: string };
  /** Cover image (relative or absolute URL) shown as banner above title. */
  coverSrc?: string;
  /** Crumb trail rendered above the title (root → … → parent). */
  breadcrumbs?: PageLink[];
  /** ISO timestamp of the page's last_edited_time in Notion. */
  lastEditedTime?: string;
  /** ISO timestamp of this export run. */
  exportedAt?: string;
  /** Canonical Notion URL for the source page. */
  notionUrl?: string;
}

/**
 * `ChildDatabaseData` is split into three concern-specific sub-interfaces so
 * renderers that only need one concern can narrow their parameter types and
 * so a new field has an obvious destination group.
 *
 * Mirrors the same split MarkdownOptions has
 * (PageHeader / RenderServices / PageChrome). The exported `ChildDatabaseData`
 * remains the union — callsites that build the full bag stay unchanged.
 */
export interface ChildDbPayload {
  title: string;
  database: unknown;
  rows: unknown[];
}

export interface ChildDbHrefs {
  /** Relative href to the standalone database page (used for the "open full view" link). */
  href?: string;
  /** Row-id → relative href for the row's own page. */
  rowHrefs?: Map<string, string>;
  /** Row-id → relative cover/icon image href, pre-resolved by the caller. */
  rowCovers?: Map<string, string>;
  rowIcons?: Map<string, string>;
}

export interface ChildDbHints {
  /** Notion's canonical data-source schema (option order) for this database.
   * When present, the renderer uses the schema's option arrays as the
   * primary sort for kanban columns and filter chips. Falls back to the
   * legacy STATUS_RANK + first-occurrence heuristic when undefined (older
   * exports written before the data-source phase shipped). */
  dataSource?: DataSourceSchema;
  /** All of the database's views (Views API), in tab order. Each carries the
   * view config (layout, group-by, date prop, visible-column order) and its
   * filtered/sorted `rowOrder`. When present, drives the tabbed multi-view
   * renderer — view config is tier-0 over every heuristic. `undefined`/empty
   * for older exports or databases without a resolvable view. */
  views?: ViewWithOrder[];
  /** True when this child_database block lives inside a `column_list`
   * ancestor. The renderer uses this (plus a row-count + cover gate) to
   * emit a compact card-list instead of the full table chrome, which is
   * visually too noisy when several mini-DBs share a single row. Caller
   * walks the block tree once to set the flag; renderer logic short-circuits
   * before kanban/gallery detection. */
  inColumnList?: boolean;
  /** True when this entry was originally a Notion "linked view of database"
   * block (empty stub with `data_sources: []`) and was aliased to a
   * non-empty source DB on the same page. The Notion API does not expose
   * the source DB id or the view's filters, so the renderer surfaces the
   * source DB's full row set with a note explaining the limitation. */
  linkedSource?: boolean;
}

export interface ChildDatabaseData extends ChildDbPayload, ChildDbHrefs, ChildDbHints {}

/**
 * Per-page header data — what appears around the title (icon, cover,
 * breadcrumbs, footer timestamps, canonical URL) plus the optional
 * pre-rendered HTML title.
 *
 * Extends {@link PageMeta} (icon/cover/breadcrumbs/timestamps) and adds
 * `titleHtml` for cases where the caller has pre-rendered the title with
 * inline custom-emoji `<img>` tags.
 */
export interface PageHeader extends PageMeta {
  /** Pre-rendered HTML title (e.g. with `:name:` custom emojis swapped for
   * inline images). When set, the heading uses this verbatim instead of the
   * plain `page.title`. */
  titleHtml?: string;
}

/**
 * Resolve a Notion page/database id to a link relative to the current file.
 * Returns `null` when the id isn't in the page index (workspace-level page,
 * missing target, etc.).
 */
export type ResolveLink = (id: string) => PageLink | null;

/**
 * Rendering-time services — closures and lookup tables the renderer calls
 * back into while walking blocks. Distinct from `PageHeader` (passive
 * per-page data) and `PageChrome` (caller-prepared markup data).
 */
export interface RenderServices {
  /** Relative prefix from the document directory to the snapshot root. */
  assetPrefix?: string;
  /** Resolve a Notion page/database id to a link relative to the current file. Return null if unknown. */
  resolveLink?: ResolveLink;
  /** Inline data for child_database blocks; rendered as a live-style table. */
  childDatabases?: Map<string, ChildDatabaseData>;
  /** Inline-DB render mode. Default `auto` lets the renderer apply the
   * kanban heuristic. `table` forces table/gallery view; `kanban` forces a
   * kanban board even when the heuristic fails (an unparented "No status"
   * column collects rows that lack a grouping value). */
  dbView?: "auto" | "table" | "kanban";
  /** Optional logger — surfaces parse warnings emitted by
   * `parseDbConfig` (malformed JSON fences, bad-shape keys, …) so the
   * operator sees them. */
  log?: Logger;
}

/**
 * Chrome data rendered above or below the page body but outside the
 * block tree itself — child page list, DB-row property table.
 */
export interface PageChrome {
  /** Children to list under a "## Children" section. */
  children?: PageLink[];
  /** Pre-formatted property rows (key/value) to render above body. Used for DB-row pages. */
  properties?: Array<{ name: string; value: string }>;
  /** Page-level Notion comments rendered at the bottom of the page.
   * Missing/empty array → no section is emitted. */
  comments?: NotionComment[];
}

/**
 * Aggregate options accepted by {@link pageToMarkdown} and
 * {@link databaseToMarkdown}. See {@link PageHeader} / {@link RenderServices} /
 * {@link PageChrome} for the per-concern fields.
 */
export interface MarkdownOptions extends PageHeader, RenderServices, PageChrome {}

/**
 * Compose the three per-concern groups into a single {@link MarkdownOptions}.
 * Making the composition explicit (rather than an inline spread at each
 * callsite) keeps the three-group split visible and gives any future field
 * added to a group an obvious flow into every caller. `chrome` is optional —
 * standalone DB pages pass nothing (or `{}`).
 */
export function buildMarkdownOptions(
  header: PageHeader,
  services: RenderServices,
  chrome?: Partial<PageChrome>,
): MarkdownOptions {
  return { ...header, ...services, ...(chrome ?? {}) };
}

export interface HeadingEntry {
  level: 1 | 2 | 3 | 4;
  text: string;
  id: string;
}

export interface RenderCtx {
  assetPrefix?: string;
  resolveLink?: ResolveLink;
  headings?: HeadingEntry[];
  childDatabases?: Map<string, ChildDatabaseData>;
  /** Mutable cursor into `headings` consumed as blockTo emits heading blocks. */
  headingCursor?: { i: number };
  /** Forwarded from MarkdownOptions; pinned per page so block-level renderers
   * picking up an inline child_database know which view mode to honour. */
  dbView?: "auto" | "table" | "kanban";
  /** Forwarded from MarkdownOptions for db-config fence parse warnings. */
  log?: Logger;
}

export type DatabaseRow = {
  id: string;
  properties?: Record<string, unknown>;
};
