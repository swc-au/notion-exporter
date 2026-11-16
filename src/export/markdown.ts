// Public surface for the markdown renderer.
//
// The renderer is split into a `markdown/` directory along concern lines:
//   - `markdown/util.ts`       leaf primitives (safeLinkUrl, mdCell, STATUS_RANK)
//   - `markdown/richtext.ts`   rt, applyStyles, mdLinksToAnchors, KaTeX cache
//   - `markdown/properties.ts` formatProp, renderPropertyValue, property table
//   - `markdown/database.ts`   renderInlineDatabase, kanban/gallery/table/compact,
//                              renderFilterStrip, rankColumn
//   - `markdown/blocks.ts`     RENDERERS dispatch, per-block renderers,
//                              collectPageMeta, renderPageLink, renderToc
//   - `markdown/types.ts`      MarkdownOptions / PageHeader / RenderServices /
//                              PageChrome / ChildDatabaseData
//
// This file is a barrel re-exporting the public API so `import { … } from
// "…/export/markdown.js"` keeps resolving exactly as before. Only
// `pageToMarkdown`, `databaseToMarkdown`, and `writeMarkdown` are defined
// here — everything else delegates.

import fsp from "node:fs/promises";
import path from "node:path";
import type { ExportedDatabase, ExportedPage } from "./json.js";
import { blockTo, collectPageMeta, renderPageLink } from "./markdown/blocks.js";
import { renderInlineDatabase } from "./markdown/database.js";
import { renderPropertyTable } from "./markdown/properties.js";
import { rt } from "./markdown/richtext.js";
import type {
  ChildDatabaseData,
  MarkdownOptions,
  PageMeta,
  RenderCtx,
  ResolveLink,
  RichText,
} from "./markdown/types.js";
import { escapeHtmlText, formatDate, mdUrl, safeLinkUrl } from "./markdown/util.js";
import { safeSegment, UNTITLED_DB, UNTITLED_PAGE } from "./paths.js";

export { blockTo, collectPageMeta, renderPageLink, renderToc } from "./markdown/blocks.js";
export { renderInlineDatabase } from "./markdown/database.js";
export {
  formatProp,
  HTML_EMITTING_PROP_TYPES,
  renderPropertyTable,
  renderPropertyValue,
  renderSelectChip,
  rowTitle,
} from "./markdown/properties.js";
export { applyStyles, mdLinksToAnchors, renderKatex, rt } from "./markdown/richtext.js";
// Re-export everything external callers consume. The shapes are unchanged
// from the pre-split surface — `commands/{export,rerender,repair}.ts`,
// `pipeline.ts`, and the test suite all import via this module.
export type {
  ChildDatabaseData,
  ChildDbHints,
  ChildDbHrefs,
  ChildDbPayload,
  HeadingEntry,
  MarkdownOptions,
  PageChrome,
  PageHeader,
  PageLink,
  PageMeta,
  RenderCtx,
  RenderServices,
  ResolveLink,
  RichText,
  RichTextItem,
} from "./markdown/types.js";
export {
  basenameFromUrl,
  escapeHtmlText,
  formatDate,
  headingLevel,
  indent,
  mdCell,
  mdUrl,
  plainTextOf,
  quotePrefix,
  resolveFileSrc,
  STATUS_RANK,
  safeLinkUrl,
  slugifyHeading,
  statusRankOf,
} from "./markdown/util.js";

// ---------- public render functions ----------

function renderIconPrefix(icon: PageMeta["icon"]): string {
  if (!icon) return "";
  if (icon.kind === "emoji") return `${icon.value} `;
  // SECURITY: a tampered raw JSON could plant a `javascript:`/`data:` scheme
  // into `icon.value`. Mirror the `mdUrl(safeLinkUrl(...))` gate used by
  // every other URL-bearing emit.
  return `<img class="page-icon" src="${mdUrl(safeLinkUrl(icon.value))}" alt=""> `;
}

function renderFooter(opts: MarkdownOptions): string {
  const bits: string[] = [];
  if (opts.lastEditedTime) bits.push(`Last edited ${formatDate(opts.lastEditedTime)}`);
  if (opts.exportedAt) bits.push(`Exported ${formatDate(opts.exportedAt)}`);
  // `rel="noopener"` mitigates tab-nabbing when the user opens the original
  // Notion page in a new tab. `target="_blank"` matches the index hero's
  // "Open in Notion" affordance so both anchors behave the same way.
  if (opts.notionUrl)
    bits.push(
      `<a href="${safeLinkUrl(opts.notionUrl)}" rel="noopener" target="_blank">Open in Notion ↗</a>`,
    );
  if (bits.length === 0) return "";
  return `\n\n<footer class="page-footer">${bits.join(" · ")}</footer>`;
}

function renderComment(
  c: import("../notion/comments.js").NotionComment,
  resolveLink: ResolveLink | undefined,
): string {
  const author = c.created_by?.name ?? "Unknown";
  const authorSafe = escapeHtmlText(author);
  const initial = escapeHtmlText(author.slice(0, 1).toUpperCase() || "?");
  const created = c.created_time ?? "";
  // Show a stable absolute timestamp (YYYY-MM-DD) and the full ISO as a
  // tooltip — a relative time would require runtime JS we don't ship.
  const dateLabel = created ? formatDate(created) : "";
  const timeAttr = created
    ? ` datetime="${escapeHtmlText(created)}" title="${escapeHtmlText(created)}"`
    : "";
  const timeHtml = dateLabel
    ? `<time class="comment-time"${timeAttr}>${escapeHtmlText(dateLabel)}</time>`
    : "";
  const body = rt((c.rich_text as RichText | undefined) ?? [], resolveLink);
  // Comments use the same rich_text shape as paragraphs; `rt()` already turns
  // newlines into `<br>` and produces HTML-safe output.
  const bodyHtml = body || "<em>(empty)</em>";
  return `<li class="comment"><header class="comment-head"><span class="comment-avatar" aria-hidden="true">${initial}</span><span class="comment-author">${authorSafe}</span>${timeHtml}</header><div class="comment-body">${bodyHtml}</div></li>`;
}

// Page-level Notion comments. Caller hands us the trimmed `NotionComment[]`
// loaded from raw JSON; we render each as a card with author, timestamp, and
// the comment's rich text body. Returns "" for missing/empty arrays so older
// raw JSON (which has no `comments` key) round-trips unchanged.
function renderCommentsSection(
  comments: import("../notion/comments.js").NotionComment[] | undefined,
  resolveLink: ResolveLink | undefined,
): string {
  if (!comments || comments.length === 0) return "";
  const items = comments
    .map((c) => renderComment(c, resolveLink))
    .filter(Boolean)
    .join("");
  if (!items) return "";
  return `\n\n<section class="page-comments"><h2 class="page-comments-title">Comments</h2><ul class="comments">${items}</ul></section>`;
}

export function pageToMarkdown(page: ExportedPage, opts: MarkdownOptions = {}): string {
  const title = page.title || UNTITLED_PAGE;
  // SECURITY: gate `coverSrc` through `safeLinkUrl` so a tampered raw JSON
  // can't plant a `javascript:` scheme into the hero `<img src>`. Matches
  // the audio/video/pdf renderers' pattern.
  const cover = opts.coverSrc
    ? `<p class="cover"><img src="${mdUrl(safeLinkUrl(opts.coverSrc))}" alt=""></p>\n\n`
    : "";
  const crumbs =
    opts.breadcrumbs && opts.breadcrumbs.length > 0
      ? `<nav class="breadcrumbs">${opts.breadcrumbs.map((c) => `<a href="${mdUrl(c.href)}" title="${escapeHtmlText(c.title)}">${c.titleHtml ?? escapeHtmlText(c.title)}</a>`).join("")}</nav>\n\n`
      : "";
  const iconPart = renderIconPrefix(opts.icon);
  // `titleHtml` is caller-prepared (e.g. with custom-emoji <img>) and trusted.
  // `title` is the raw Notion page title — escape `<>&` before emitting it.
  const heading = `# ${iconPart}${opts.titleHtml ?? escapeHtmlText(title)}`;
  const props = renderPropertyTable(opts.properties);
  // Single pass: collect heading slugs (cursor-consumed by blockTo) AND the
  // set of child_page / child_database ids the body already renders inline.
  // Two walks → one walk over `page.blocks`.
  const { headings, childPageIds, childDbIds } = collectPageMeta(page.blocks, opts.resolveLink);
  const ctx: RenderCtx = {
    assetPrefix: opts.assetPrefix,
    resolveLink: opts.resolveLink,
    headings,
    childDatabases: opts.childDatabases,
    headingCursor: { i: 0 },
    dbView: opts.dbView,
  };
  const body = page.blocks.map((b) => blockTo(b, 0, ctx)).join("\n\n");
  // Subpages that don't appear as inline `child_page` blocks (e.g. pages
  // created via the API or moved here without an embed) still belong on this
  // page so the reader can navigate to them. Skip any that the body already
  // links to via a child_page/child_database block.
  const unrendered =
    opts.children?.filter((c) => {
      const targetId = c.href.match(/([0-9a-f-]{36})\.md(?:#|$)/i)?.[1];
      if (!targetId) return true;
      return !childPageIds.has(targetId) && !childDbIds.has(targetId);
    }) ?? [];
  const childrenSection =
    unrendered.length > 0
      ? `\n\n<section class="page-children"><h2 class="page-children-title">Pages</h2><div class="page-children-list">${unrendered.map((c) => renderPageLink(c, c.kind)).join("")}</div></section>`
      : "";
  const commentsSection = renderCommentsSection(opts.comments, opts.resolveLink);
  const footer = renderFooter(opts);
  return `${cover}${heading}\n\n${crumbs}${props}${body}${childrenSection}${commentsSection}${footer}\n`;
}

export function databaseToMarkdown(db: ExportedDatabase, opts: MarkdownOptions = {}): string {
  const title = db.title || UNTITLED_DB;
  const crumbs =
    opts.breadcrumbs && opts.breadcrumbs.length > 0
      ? `<nav class="breadcrumbs">${opts.breadcrumbs.map((c) => `<a href="${mdUrl(c.href)}" title="${escapeHtmlText(c.title)}">${c.titleHtml ?? escapeHtmlText(c.title)}</a>`).join("")}</nav>\n\n`
      : "";
  // Use the same rich view as inline child_database blocks — gallery cards
  // when rows have covers, otherwise a sortable+filterable table. Standalone
  // DB pages now get the same interactivity (and same chip/color styling)
  // as inline references.
  // Populate rowHrefs so kanban / gallery / table cards on standalone DB
  // pages are clickable links to each row's page — without this they fall
  // back to a non-interactive <span>.
  const rowHrefs = new Map<string, string>();
  if (opts.resolveLink) {
    for (const r of db.rows ?? []) {
      const id = (r as { id?: string })?.id;
      if (!id) continue;
      const link = opts.resolveLink(id);
      if (link?.href) rowHrefs.set(id, link.href);
    }
  }
  const inlineData: ChildDatabaseData = {
    title,
    database: db.database,
    rows: db.rows,
    ...(rowHrefs.size > 0 ? { rowHrefs } : {}),
    ...(db.dataSource ? { dataSource: db.dataSource } : {}),
    ...(db.views ? { views: db.views } : {}),
  };
  const body = renderInlineDatabase(inlineData, opts.resolveLink, opts.dbView, opts.log);
  return `# ${escapeHtmlText(title)}\n\n${crumbs}${body}\n`;
}

export async function writeMarkdown(
  mdDir: string,
  doc: { id: string; title: string },
  content: string,
  subdir = "",
): Promise<string> {
  const filename = `${safeSegment(doc.title)}.${doc.id}.md`;
  const abs = path.join(mdDir, subdir, filename);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  return abs;
}
