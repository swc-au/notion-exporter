// Block dispatch — walks a Notion `block_tree` and emits the body of a page.
// Each block type has a renderer; unknown types fall through to a comment +
// childText recursion. `collectPageMeta` is the single-pass DFS that gathers
// heading slugs + nested child_page/child_database ids before the renderer
// walks the tree.

import type { NotionBlock } from "../../notion/blocks.js";
import { UNTITLED_DB, UNTITLED_PAGE } from "../paths.js";
import { renderInlineDatabase } from "./database.js";
import { renderKatex, rt } from "./richtext.js";
import type {
  HeadingEntry,
  MarkdownOptions,
  PageLink,
  RenderCtx,
  ResolveLink,
  RichText,
} from "./types.js";
import {
  basenameFromUrl,
  escapeHtmlText,
  headingLevel,
  indent,
  mdCell,
  mdUrl,
  plainTextOf,
  quotePrefix,
  resolveFileSrc,
  safeLinkUrl,
  slugifyHeading,
} from "./util.js";

// Block types whose children get rendered inline in the same document by
// blockTo. Anything not in this set (child_page, child_database, table) has
// children that don't appear as document-level headings, so collectHeadings
// must skip them to keep cursor-index parity with the renderer.
const INLINE_CHILD_TYPES = new Set<string>([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "column_list",
  "column",
  "synced_block",
]);

// Recurse into children of unknown block types too — collectHeadings has no
// idea what an unknown block does, but blockTo's default case emits
// `childText()` which still recurses into children. If a heading lives under
// an unknown block, we want its id pre-collected so cursor parity holds.
function shouldCollectChildrenFor(type: string): boolean {
  return INLINE_CHILD_TYPES.has(type) || isUnknownBlockType(type);
}

// Anything we don't have an explicit case for — `blockTo` falls through to
// `default` and recurses via `childText()`. Keep this list narrow (Notion has
// a small finite set of public block types) so we don't blindly recurse into
// table rows etc.
function isUnknownBlockType(type: string): boolean {
  return !KNOWN_BLOCK_TYPES.has(type);
}

const KNOWN_BLOCK_TYPES = new Set<string>([
  ...INLINE_CHILD_TYPES,
  "code",
  "divider",
  "image",
  "file",
  "pdf",
  "video",
  "audio",
  "bookmark",
  "equation",
  "child_page",
  "child_database",
  "link_to_page",
  "table",
  "table_row",
  "embed",
  "link_preview",
  "table_of_contents",
  "breadcrumb",
]);

interface PageMetaCollection {
  headings: HeadingEntry[];
  childPageIds: Set<string>;
  childDbIds: Set<string>;
}

/**
 * Single-pass DFS over a page's block tree that emits everything
 * `pageToMarkdown` needs to peek at before rendering:
 *
 *  - `headings`     — pre-slugged in document order; the renderer's
 *                     `headingCursor` walks the same array, so order parity
 *                     with `blockTo()` is load-bearing here. We mirror the
 *                     same `shouldCollectChildrenFor` gate for heading
 *                     collection so an unknown-block-nested heading still
 *                     gets pre-assigned a slug.
 *  - `childPageIds` / `childDbIds`
 *                   — every nested `child_page` / `child_database` block id
 *                     (regardless of parent type) so the caller can drop
 *                     `unrendered` chrome links that already appear in the
 *                     body. Walks the full tree on purpose: the old
 *                     standalone `walk()` did the same.
 *
 * Replaces two separate recursions (`collectHeadings` + the inline `walk()`)
 * with one. Cuts block-tree traversals per page from 2 → 1.
 */
export function collectPageMeta(
  blocks: NotionBlock[],
  resolveLink: ResolveLink | undefined,
): PageMetaCollection {
  const headings: HeadingEntry[] = [];
  const childPageIds = new Set<string>();
  const childDbIds = new Set<string>();
  const seen = new Map<string, number>();
  function visit(bs: NotionBlock[]): void {
    for (const b of bs) {
      if (b.type === "child_page") childPageIds.add(b.id);
      else if (b.type === "child_database") childDbIds.add(b.id);
      const level = headingLevel(b.type);
      if (level) {
        const data = (b[b.type] ?? {}) as Record<string, unknown>;
        const text = plainTextOf((data.rich_text as RichText) ?? []);
        const base = slugifyHeading(text) || `section-${headings.length + 1}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const id = n === 1 ? base : `${base}-${n - 1}`;
        headings.push({ level, text: rt((data.rich_text as RichText) ?? [], resolveLink), id });
      }
      if (b.children?.length) {
        // Heading-slug collection must mirror what `blockTo()` actually emits
        // as document-level headings (so `headingCursor` stays in sync), but
        // child_page/child_database id collection wants the full tree — a
        // nested child_page under a `table` should still suppress duplicate
        // chrome entries. Hence: always recurse for id collection; the
        // heading branch inside this recursion is naturally gated by the
        // same `shouldCollectChildrenFor` rule the old code applied,
        // because non-inline-child types don't emit headings into the body
        // anyway (and we mirror that here by skipping them).
        if (shouldCollectChildrenFor(b.type)) {
          visit(b.children);
        } else {
          collectChildIds(b.children, childPageIds, childDbIds);
        }
      }
    }
  }
  visit(blocks);
  return { headings, childPageIds, childDbIds };
}

// Sub-walk used by `collectPageMeta` when descending into a block whose
// children are NOT rendered as document-level body (table rows, child_page
// subtrees, etc.). Skips heading collection in that subtree (parity with the
// old `collectHeadings` gate) but still records nested child_page /
// child_database ids so chrome-section dedup works.
function collectChildIds(blocks: NotionBlock[], pages: Set<string>, dbs: Set<string>): void {
  for (const b of blocks) {
    if (b.type === "child_page") pages.add(b.id);
    else if (b.type === "child_database") dbs.add(b.id);
    if (b.children?.length) collectChildIds(b.children, pages, dbs);
  }
}

export function renderToc(headings: HeadingEntry[] | undefined): string {
  if (!headings || headings.length === 0) return "";
  // Spread of `headings.map(...)` would crash on engine-dependent argument
  // limits for very large heading sets (>10k); use an explicit loop instead.
  let minLevel: number = Infinity;
  for (const h of headings) if (h.level < minLevel) minLevel = h.level;
  const items = headings
    .map((h) => {
      const indent = "  ".repeat(h.level - minLevel);
      return `${indent}- [${h.text}](#${h.id})`;
    })
    .join("\n");
  return `<nav class="toc" aria-label="Table of contents">\n\n${items}\n\n</nav>`;
}

function pageLinkIconHtml(icon: PageLink["icon"], fallback: "page" | "database"): string {
  if (icon?.kind === "emoji") {
    // SECURITY: emoji value lands in element-body — escape it so a tampered
    // raw JSON (`<script>` as the icon "emoji") can't break out of the
    // `<span>`. Normal emoji glyphs pass through unchanged.
    return `<span class="page-link-icon">${escapeHtmlText(icon.value)}</span>`;
  }
  if (icon?.kind === "image") {
    return `<img class="page-link-icon" src="${mdUrl(icon.value)}" alt="" loading="lazy">`;
  }
  const fb = fallback === "database" ? "🗂" : "📄";
  return `<span class="page-link-icon page-link-fallback">${fb}</span>`;
}

export function renderPageLink(link: PageLink, kind: "page" | "database"): string {
  const iconHtml = pageLinkIconHtml(link.icon, kind);
  const titleInner = link.titleHtml ?? escapeHtmlText(link.title);
  return `<a class="page-link" href="${mdUrl(link.href)}">${iconHtml}<span class="page-link-title">${titleInner}</span></a>`;
}

function renderChildPage(
  block: NotionBlock,
  data: Record<string, unknown>,
  resolveLink: MarkdownOptions["resolveLink"],
): string {
  const title = (data.title as string) ?? UNTITLED_PAGE;
  const link = resolveLink?.(block.id);
  if (link) return renderPageLink(link, "page");
  // Unresolved: emit a flat link-styled card without an href.
  return `<a class="page-link" aria-disabled="true">${pageLinkIconHtml(undefined, "page")}<span class="page-link-title">${escapeHtmlText(title)}</span></a>`;
}

function renderChildDb(
  block: NotionBlock,
  data: Record<string, unknown>,
  resolveLink: MarkdownOptions["resolveLink"],
): string {
  const title = (data.title as string) ?? UNTITLED_DB;
  const link = resolveLink?.(block.id);
  if (link) return renderPageLink(link, "database");
  return `<a class="page-link" aria-disabled="true">${pageLinkIconHtml(undefined, "database")}<span class="page-link-title">${escapeHtmlText(title)}</span></a>`;
}

function renderLinkToPage(
  data: Record<string, unknown>,
  resolveLink: MarkdownOptions["resolveLink"],
): string {
  const targetId = (data.page_id as string) ?? (data.database_id as string) ?? "";
  const link = targetId ? resolveLink?.(targetId) : null;
  if (link) return renderPageLink(link, link.kind);
  return targetId ? `→ [${targetId}](https://notion.so/${targetId.replace(/-/g, "")})` : "→ (link)";
}

// Extract a YouTube video id from any of the common URL shapes:
//   youtu.be/<id>
//   www.youtube.com/watch?v=<id>
//   www.youtube.com/embed/<id>
//   www.youtube.com/shorts/<id>
// Returns null when the host matches but no id can be located (so the caller
// falls through to the generic link card).
function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return id || null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/);
    return m?.[1] ?? null;
  }
  return null;
}

function vimeoId(u: URL): string | null {
  if (!u.hostname.endsWith("vimeo.com")) return null;
  const m = u.pathname.match(/^\/(\d+)/);
  return m?.[1] ?? null;
}

function loomId(u: URL): string | null {
  if (!u.hostname.endsWith("loom.com")) return null;
  const m =
    u.pathname.match(/^\/share\/([0-9a-f]+)/i) ?? u.pathname.match(/^\/embed\/([0-9a-f]+)/i);
  return m?.[1] ?? null;
}

// `caption` MUST come from `rt()` — never bypass; raw text would XSS via
// `security-v2.md` L2 path. The string is interpolated verbatim into the
// `<figcaption>` body.
function iframeFigure(cls: string, src: string, title: string, caption?: string): string {
  const safeSrc = mdUrl(src);
  const titleAttr = escapeHtmlText(title);
  const figcap = caption ? `<figcaption>${caption}</figcaption>` : "";
  return `<figure class="embed ${cls}"><iframe loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${titleAttr}" src="${safeSrc}"></iframe>${figcap}</figure>`;
}

// Per-URL parse + provider-resolution cache for `renderEmbedCard`. URL parsing
// and the youtube/vimeo/loom regex chain are pure functions of `rawUrl`, but
// the same embed URL appears on every page of a doc-site export (footer,
// sidebar, navigation embeds, etc.) — exports easily push >1000 calls. Cache
// the *resolved provider shape* (not the rendered HTML) so we can re-format
// with the page-specific `caption` on a hit. Module-scope, capped at 1000
// entries; eviction is crude clear-when-full (exports are batch jobs).
type EmbedShape =
  | { kind: "iframe"; cls: string; src: string; title: string }
  | { kind: "link"; safe: string; host: string; url: string };
const embedShapeCache = new Map<string, EmbedShape>();

function resolveEmbedShape(rawUrl: string): EmbedShape | null {
  const url = (rawUrl ?? "").trim();
  if (!url) return null;
  const cached = embedShapeCache.get(url);
  if (cached) return cached;
  const safe = safeLinkUrl(url);
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  let shape: EmbedShape;
  if (parsed && safe !== "#") {
    const yt = youtubeId(parsed);
    if (yt) {
      shape = {
        kind: "iframe",
        cls: "video-embed",
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}`,
        title: "YouTube video",
      };
    } else {
      const vm = vimeoId(parsed);
      if (vm) {
        shape = {
          kind: "iframe",
          cls: "video-embed",
          src: `https://player.vimeo.com/video/${encodeURIComponent(vm)}`,
          title: "Vimeo video",
        };
      } else {
        const lm = loomId(parsed);
        if (lm) {
          shape = {
            kind: "iframe",
            cls: "video-embed",
            src: `https://www.loom.com/embed/${encodeURIComponent(lm)}`,
            title: "Loom video",
          };
        } else {
          shape = {
            kind: "link",
            safe,
            host: parsed.hostname.replace(/^www\./, ""),
            url,
          };
        }
      }
    }
  } else {
    shape = { kind: "link", safe, host: parsed ? parsed.hostname.replace(/^www\./, "") : url, url };
  }
  if (embedShapeCache.size > 1000) embedShapeCache.clear();
  embedShapeCache.set(url, shape);
  return shape;
}

// `caption` MUST come from `rt()` — never bypass; raw text would XSS via
// `security-v2.md` L2 path. The string is interpolated verbatim into the
// `link-card-caption` span / iframe `<figcaption>` body.
function renderEmbedCard(rawUrl: string, caption?: string): string {
  const shape = resolveEmbedShape(rawUrl);
  if (!shape) return "";
  if (shape.kind === "iframe") {
    return iframeFigure(shape.cls, shape.src, shape.title, caption);
  }
  // Generic link card. We deliberately don't fetch OG metadata at export time —
  // the hostname + URL is enough to give the reader a clickable affordance.
  const captionSpan = caption ? `<span class="link-card-caption">${caption}</span>` : "";
  return `<figure class="link-card"><a href="${mdUrl(shape.safe)}" rel="noopener" target="_blank"><span class="link-card-host">${escapeHtmlText(shape.host)}</span><span class="link-card-url">${escapeHtmlText(shape.url)}</span>${captionSpan}</a></figure>`;
}

function renderTable(block: NotionBlock, resolveLink?: ResolveLink): string {
  const children = block.children ?? [];
  if (!children.length) return "";
  const hasHeader = (block[block.type] as { has_column_header?: boolean })?.has_column_header;
  const rows = children.map((row) => {
    const cells = ((row[row.type] as { cells?: RichText[] }).cells ?? []).map((c) =>
      rt(c, resolveLink),
    );
    return cells;
  });
  const colCount = rows[0]?.length ?? 0;
  if (colCount === 0) return "";
  // When `has_column_header` is true, the GFM-style table with a header row
  // and separator round-trips through marked. When it's false, emit raw
  // <table><tbody> HTML so we don't render a visually empty <thead>.
  if (hasHeader) {
    const mdRows = rows.map((cells) => `| ${cells.map(mdCell).join(" | ")} |`);
    const sep = `|${" --- |".repeat(colCount)}`;
    return [mdRows[0], sep, ...mdRows.slice(1)].join("\n");
  }
  const bodyHtml = rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="notion-table"><tbody>${bodyHtml}</tbody></table>`;
}

// Per-block-type renderer state. Built once per blockTo() call so individual
// renderers don't re-derive padding / resolveLink / block color on every
// dispatch.
interface BlockRenderState {
  block: NotionBlock;
  depth: number;
  ctx: RenderCtx;
  data: Record<string, unknown>;
  pad: string;
  resolveLink: ResolveLink | undefined;
  text: RichText | undefined;
  toggleable: boolean;
  blockColor: string;
  hasBlockColor: boolean;
  childText: () => string;
  wrapBlockColor: (inner: string) => string;
}

type BlockRenderer = (s: BlockRenderState) => string;

function consumeHeadingId(ctx: RenderCtx): string {
  // collectHeadings walked the same block tree in document order; consume
  // from the same array so each heading instance gets its pre-assigned slug
  // (including the disambiguation suffix when titles repeat).
  if (!ctx.headings || !ctx.headingCursor) return "";
  const found = ctx.headings[ctx.headingCursor.i];
  ctx.headingCursor.i += 1;
  return found?.id ?? "";
}

function renderHeadingBlock(s: BlockRenderState, level: 1 | 2 | 3 | 4): string {
  const head = rt(s.text, s.resolveLink);
  // Consume this heading's slug BEFORE rendering its children, so children's
  // own headings (rendered via recursive blockTo calls) read the cursor
  // positions that come after this one.
  const id = consumeHeadingId(s.ctx);
  const tag = `h${level}`;
  const idAttr = id ? ` id="${id}"` : "";
  // Headings in markdown don't visually nest: emit children as sibling
  // top-level blocks separated by blank lines. Indenting them with the
  // heading's pad (as list children get) breaks parsing — e.g. raw HTML
  // blocks greedily absorb the next bullet list when no blank line follows.
  const headingChildren = s.block.children?.length
    ? `\n\n${s.block.children.map((c) => blockTo(c, 0, s.ctx)).join("\n\n")}`
    : "";
  if (s.toggleable) {
    const summary = `<${tag}${idAttr}>${head}</${tag}>`;
    return `<details class="toggle-heading"><summary>${summary}</summary>${headingChildren}\n\n</details>`;
  }
  return `<${tag}${idAttr}>${head}</${tag}>${headingChildren}`;
}

// List item color is applied to the bullet text via a wrapping span so the
// surrounding `- ` / `1. ` marker still parses as a markdown list.
function listItemContent(s: BlockRenderState): string {
  const txt = rt(s.text, s.resolveLink);
  return s.hasBlockColor ? `<span class="b-${s.blockColor}">${txt}</span>` : txt;
}

// Returns the {src, fileName, captionHtml, linkText, hasLocalAsset} bundle
// shared by the file/pdf renderers. Split out so the pdf renderer can reuse
// it while emitting an additional `<iframe>` preview.
function fileBlockParts(s: BlockRenderState): {
  src: string;
  fileName: string;
  linkText: string;
  hasLocalAsset: boolean;
} {
  // Pick the most descriptive label available, in order:
  //   1. the user's caption (rich_text)
  //   2. the block's `name` field (file blocks have this)
  //   3. the basename of the original remote URL (preserves filename even
  //      when src is a content-hashed local path like assets/abc123.pdf)
  //   4. the basename of the source itself
  //   5. the block type as a last resort
  const src = resolveFileSrc(s.data, s.ctx.assetPrefix);
  const f = s.data as {
    name?: string;
    file?: { url?: string };
    external?: { url?: string };
    local_path?: string;
  };
  const origUrl = f.file?.url ?? f.external?.url ?? "";
  const fileName = f.name || basenameFromUrl(origUrl) || basenameFromUrl(src);
  // rt() emits already-safe HTML; the fallbacks are operator-untrusted
  // strings and must be escaped before going into the anchor body.
  const captionHtml = rt(s.data.caption as RichText, s.resolveLink);
  const linkText = captionHtml || escapeHtmlText(fileName || s.block.type);
  return { src, fileName, linkText, hasLocalAsset: Boolean(f.local_path) };
}

function renderFileBlock(s: BlockRenderState): string {
  const { src, linkText } = fileBlockParts(s);
  // Emit HTML directly so safeLinkUrl gates the href — bypassing marked's
  // looser scheme handling. A Notion file/pdf block with
  // `external.url = "javascript:..."` would otherwise render as a live XSS.
  return `<a href="${mdUrl(safeLinkUrl(src))}">${linkText}</a>`;
}

function renderPdfBlock(s: BlockRenderState): string {
  const { src, fileName, linkText, hasLocalAsset } = fileBlockParts(s);
  const safeSrc = safeLinkUrl(src);
  const href = mdUrl(safeSrc);
  // Only embed a preview when the asset has been downloaded locally
  // (relative `assets/<hash>.pdf` path). External URLs may follow redirect
  // chains, expire, or point at non-PDF resources, so we degrade to the link
  // form. safeLinkUrl already neutralises dangerous schemes (returns "#") —
  // refuse to embed in that case as additional defense in depth.
  // SECURITY: only attempt the embed if the resolved src actually ends in
  // `.pdf`. The asset collector picks the extension
  // from the remote URL path, so a Notion "PDF block" pointing at
  // `…/foo.html` would get saved as `assets/<hash>.html`; embedding that
  // as a PDF would be XSS. Skip embed in that case, fall back to a plain
  // link.
  // Defense in depth (F3): use `<object type="application/pdf">` instead
  // of `<iframe>`. Browsers refuse to render an `<object>` whose response
  // MIME doesn't match the declared `type`, so if the asset collector
  // ever ships a `.pdf`-named file whose actual Content-Type is HTML, the
  // browser shows the nested `<a>` fallback rather than rendering the
  // HTML in-place.
  const looksLikePdf = /\.pdf(?:[?#]|$)/i.test(safeSrc);
  if (!hasLocalAsset || safeSrc === "#" || !looksLikePdf) {
    return `<a href="${href}">${linkText}</a>`;
  }
  const titleAttr = escapeHtmlText(fileName || "PDF");
  return `<figure class="pdf-preview"><object type="application/pdf" data="${href}" title="${titleAttr}"><a href="${href}">${linkText}</a></object><figcaption><a href="${href}">${linkText}</a></figcaption></figure>`;
}

function renderEmbedOrLinkPreview(s: BlockRenderState): string {
  const url = (s.data.url as string) ?? "";
  if (!url) return "";
  const caption = rt(s.data.caption as RichText, s.resolveLink);
  return renderEmbedCard(url, caption);
}

const RENDERERS: Record<string, BlockRenderer> = {
  paragraph: (s) => s.wrapBlockColor(`${rt(s.text, s.resolveLink)}${s.childText()}`),
  heading_1: (s) => renderHeadingBlock(s, 1),
  heading_2: (s) => renderHeadingBlock(s, 2),
  heading_3: (s) => renderHeadingBlock(s, 3),
  heading_4: (s) => renderHeadingBlock(s, 4),
  bulleted_list_item: (s) => `- ${listItemContent(s)}${s.childText()}`,
  numbered_list_item: (s) => `1. ${listItemContent(s)}${s.childText()}`,
  to_do: (s) => {
    const checked = (s.data.checked as boolean) ? "x" : " ";
    return `- [${checked}] ${listItemContent(s)}${s.childText()}`;
  },
  toggle: (s) => {
    const cls = s.hasBlockColor ? ` class="b-${s.blockColor}"` : "";
    return `<details${cls}><summary>${rt(s.text, s.resolveLink)}</summary>\n\n${s.childText()}\n</details>`;
  },
  quote: (s) => {
    // Blockquote children must continue with `> ` on every line — markdown
    // treats 4-space-indented text as a code block, which is what our generic
    // `childText()` pad would otherwise produce.
    const head = rt(s.text, s.resolveLink);
    const childMd = s.block.children?.length
      ? `\n${s.block.children.map((c) => quotePrefix(blockTo(c, s.depth, s.ctx))).join("\n>\n")}`
      : "";
    return s.wrapBlockColor(`> ${head}${childMd}`);
  },
  callout: (s) => {
    const color = String(s.data.color ?? "default").replace(/[^a-z_]/g, "");
    const iconData = s.data.icon as { type?: string; emoji?: string } | null | undefined;
    const iconHtml =
      iconData?.type === "emoji" && iconData.emoji
        ? // SECURITY: callout emoji lands in `<span>` body — escape so a
          // tampered raw JSON can't smuggle markup through `iconData.emoji`.
          `<span class="callout-icon">${escapeHtmlText(iconData.emoji)}</span>`
        : "";
    // "Cover card" heuristic: Notion users build clickable cards as a callout
    // holding a cover `image` + a `child_page` link. The image block carries no
    // href of its own, so on its own the cover isn't clickable. When a callout
    // contains both, link the cover to that subpage to match the card's intent.
    const cardPage = (s.block.children ?? []).find((c) => c.type === "child_page");
    const cardLink = cardPage ? s.resolveLink?.(cardPage.id) : null;
    // Render direct children at depth 0 so their content isn't indented by
    // this block's pad (which would break list parsing inside the callout).
    const inner = (s.block.children ?? [])
      .map((c) => {
        if (c.type === "image" && cardLink?.href) {
          const img = c.image as Record<string, unknown> & { caption?: RichText };
          const alt = rt(img.caption as RichText, s.resolveLink);
          const src = safeLinkUrl(resolveFileSrc(img, s.ctx.assetPrefix));
          // `[![alt](src)](href)` → marked emits `<a href><img></a>`.
          return `[![${alt}](${mdUrl(src)})](${mdUrl(safeLinkUrl(cardLink.href))})`;
        }
        return blockTo(c, 0, s.ctx);
      })
      .join("\n\n");
    const head = rt(s.text, s.resolveLink);
    const bodyMd = inner ? (head ? `${head}\n\n${inner}` : inner) : head;
    return `<div class="callout c-${color}">${iconHtml}<div class="callout-body">\n\n${bodyMd}\n\n</div></div>`;
  },
  // Code blocks render verbatim — `rt()` would emit `<strong>` etc. for
  // annotated rich_text which would then appear as literal tags inside the
  // rendered <pre><code> rather than as formatting.
  //
  // SECURITY: the fence is one backtick longer than the longest run in the
  // content, so a code block holding ``` cannot close early and hand the rest
  // to marked as raw HTML. The language is cut to an info-string-safe charset.
  code: (s) => {
    const text = plainTextOf(s.text ?? []);
    const longest = (text.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    const lang = String(s.data.language ?? "").replace(/[^\w+#.-]/g, "");
    return `${fence}${lang}\n${text}\n${fence}`;
  },
  divider: () => "---",
  image: (s) =>
    `![${rt(s.data.caption as RichText, s.resolveLink)}](${mdUrl(safeLinkUrl(resolveFileSrc(s.data, s.ctx.assetPrefix)))})`,
  audio: (s) => {
    // Render an inline <audio> player. Caption is optional; when present it
    // sits under the player inside the same <figure>. `safeLinkUrl` defense-in-
    // depth gates `data:`/custom-scheme srcs even though browsers don't execute
    // `javascript:` here. `preload="metadata"` keeps duration UI working
    // without eagerly fetching the full file.
    const src = safeLinkUrl(resolveFileSrc(s.data, s.ctx.assetPrefix));
    const caption = rt(s.data.caption as RichText, s.resolveLink);
    const figcap = caption ? `<figcaption>${caption}</figcaption>` : "";
    return `<figure class="media audio"><audio controls preload="metadata" src="${mdUrl(src)}"></audio>${figcap}</figure>`;
  },
  video: (s) => {
    const src = safeLinkUrl(resolveFileSrc(s.data, s.ctx.assetPrefix));
    const caption = rt(s.data.caption as RichText, s.resolveLink);
    const figcap = caption ? `<figcaption>${caption}</figcaption>` : "";
    return `<figure class="media video"><video controls preload="metadata" src="${mdUrl(src)}"></video>${figcap}</figure>`;
  },
  file: renderFileBlock,
  pdf: renderPdfBlock,
  bookmark: (s) => {
    const url = (s.data.url as string) ?? "";
    const caption = rt(s.data.caption as RichText, s.resolveLink);
    return renderEmbedCard(url, caption);
  },
  equation: (s) => {
    const expr = (s.data.expression as string) ?? "";
    const html = renderKatex(expr, true);
    if (html) return `<div class="katex-block">${html}</div>`;
    // KaTeX couldn't parse it — preserve the raw LaTeX so the reader can at
    // least copy/paste it elsewhere instead of seeing a blank page.
    return `<pre class="katex-failed">$$${escapeHtmlText(expr)}$$</pre>`;
  },
  column_list: (s) => {
    if (!s.block.children?.length) return "";
    const cols = s.block.children.map((c) => blockTo(c, 0, s.ctx)).join("\n");
    return `<div class="columns">\n\n${cols}\n\n</div>`;
  },
  column: (s) => {
    if (!s.block.children?.length) return "";
    const inner = s.block.children.map((c) => blockTo(c, 0, s.ctx)).join("\n\n");
    // Notion stores per-column width via `width_ratio` (0..1). When present,
    // we preserve the proportion via inline flex-grow; otherwise columns share
    // width equally. Round to 4 decimal places — Notion frequently returns
    // floats like `0.5000000000000001` that would otherwise leak the full
    // 16-digit mantissa into the rendered DOM.
    const ratio = s.data.width_ratio as number | undefined;
    const style =
      typeof ratio === "number" && ratio > 0 ? ` style="flex:${Number(ratio.toFixed(4))};"` : "";
    return `<div class="column"${style}>\n\n${inner}\n\n</div>`;
  },
  child_page: (s) => renderChildPage(s.block, s.data, s.resolveLink),
  child_database: (s) => {
    const inline = s.ctx.childDatabases?.get(s.block.id);
    if (inline) return renderInlineDatabase(inline, s.resolveLink, s.ctx.dbView);
    return renderChildDb(s.block, s.data, s.resolveLink);
  },
  link_to_page: (s) => renderLinkToPage(s.data, s.resolveLink),
  synced_block: (s) =>
    s.block.children?.length
      ? s.block.children.map((c) => blockTo(c, s.depth, s.ctx)).join("\n\n")
      : "",
  table: (s) => renderTable(s.block, s.resolveLink),
  table_row: (s) => {
    const cells = ((s.data.cells as RichText[]) ?? []).map((c) => rt(c, s.resolveLink));
    return `| ${cells.map(mdCell).join(" | ")} |`;
  },
  embed: renderEmbedOrLinkPreview,
  link_preview: renderEmbedOrLinkPreview,
  table_of_contents: (s) => renderToc(s.ctx.headings),
  breadcrumb: () => "",
};

// Build the per-block state passed into renderers. Notion blocks carry an
// optional `color` (foreground or `_background`) that tints the whole block —
// renderers wrap their output in a marked-friendly `<div class="b-<color>">`
// HTML block when set; the surrounding blank lines let marked parse the inner
// content as markdown.
function makeBlockState(block: NotionBlock, depth: number, ctx: RenderCtx): BlockRenderState {
  const data = (block[block.type] ?? {}) as Record<string, unknown>;
  const pad = "  ".repeat(depth + 1);
  const blockColor = String((data as { color?: string }).color ?? "default").replace(
    /[^a-z_]/g,
    "",
  );
  const hasBlockColor = blockColor !== "" && blockColor !== "default";
  return {
    block,
    depth,
    ctx,
    data,
    pad,
    resolveLink: ctx.resolveLink,
    text: (data.rich_text as RichText) ?? undefined,
    toggleable: (data as { is_toggleable?: boolean }).is_toggleable === true,
    blockColor,
    hasBlockColor,
    // Computed lazily because each call advances the heading cursor — eager
    // pre-compute caused list/heading children to be rendered twice for block
    // types (callout, column, heading) that have their own iteration logic.
    childText: () =>
      block.children?.length
        ? `\n${block.children
            .map((c) => `${pad}${indent(blockTo(c, depth + 1, ctx), pad)}`)
            .join("\n")}`
        : "",
    wrapBlockColor: (inner: string): string =>
      hasBlockColor ? `<div class="b-${blockColor}">\n\n${inner}\n\n</div>` : inner,
  };
}

export function blockTo(block: NotionBlock, depth: number, ctx: RenderCtx): string {
  const state = makeBlockState(block, depth, ctx);
  const renderer = RENDERERS[block.type];
  if (renderer) return renderer(state);
  return `<!-- unsupported block: ${block.type} -->${state.childText()}`;
}
