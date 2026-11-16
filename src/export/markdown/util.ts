// Leaf utilities used across the split markdown renderer modules.
//
// Re-exports `escapeHtmlText` + `mdUrl` from the shared `../htmlEscape.ts` so
// the sibling files have a single import surface for HTML/URL primitives.

export { escapeHtmlText, mdUrl } from "../htmlEscape.js";

// Reject dangerous URL schemes (javascript:, vbscript:, data:, file:, …) so a
// workspace member can't plant clickable XSS via Notion rich_text href fields.
// Returns `"#"` for anything outside the allow-list; otherwise returns the
// (entity-decoded) trimmed input.
//
// Decoding is intentionally minimal — common bypasses for `:` only — rather
// than a full HTML entity decoder, which would itself be a foot-gun.
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel", "notion"]);
export function safeLinkUrl(href: string | undefined | null): string {
  if (!href) return "#";
  // Decode HTML-entity variants of `:` first. Attackers use these to smuggle a
  // dangerous scheme past a naive prefix check.
  const decoded = href
    .replace(/&#x3[aA];?/g, ":")
    .replace(/&#58;?/g, ":")
    .replace(/&colon;/gi, ":");
  const trimmed = decoded.trim();
  if (!trimmed) return "#";
  // Relative paths emitted on Windows carry "\" separators (path.relative).
  // Normalize them to "/" so the same local image/link src works in a browser.
  // Applied only to the relative-path returns below — backslashes never appear
  // in the allowed absolute schemes, and scheme detection runs on `trimmed`
  // first, so this can't be used to smuggle a scheme past the checks.
  const rel = (p: string) => p.replace(/\\/g, "/");
  // No-scheme prefixes: fragment, root-relative, explicit relative.
  if (trimmed.startsWith("#")) return trimmed;
  if (trimmed.startsWith("/")) return rel(trimmed);
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return rel(trimmed);
  const colonIdx = trimmed.indexOf(":");
  // No colon at all → plain relative path (e.g. `foo.html`).
  if (colonIdx === -1) return rel(trimmed);
  // If a path/query separator appears before the first colon, the colon is
  // inside a path/query and the value is relative (e.g. `foo/bar:baz`).
  const slashOrQueryIdx = trimmed.search(/[/?]/);
  if (slashOrQueryIdx !== -1 && slashOrQueryIdx < colonIdx) return rel(trimmed);
  const scheme = trimmed.slice(0, colonIdx).toLowerCase();
  // Schemes are `[a-z][a-z0-9+\-.]*` per RFC 3986; anything else is
  // suspicious (entity-encoded, percent-encoded, whitespace, etc.) and gets
  // rejected outright.
  if (!/^[a-z][a-z0-9+\-.]*$/.test(scheme)) return "#";
  if (ALLOWED_SCHEMES.has(scheme)) return trimmed;
  return "#";
}

// Canonical workflow rank for common status names (case-insensitive). Notion's
// API doesn't expose the database's option order via the existing fetch path,
// so we approximate the user's mental model: backlog → wip → done. German
// variants included since the user's workspace uses them. Unknown names fall
// back to first-occurrence (rank Infinity → stable insertion order).
export const STATUS_RANK: Record<string, number> = {
  // 0: not yet started
  backlog: 0,
  idea: 0,
  ideen: 0,
  todo: 0,
  "to do": 0,
  "to-do": 0,
  open: 0,
  "not started": 0,
  "nicht begonnen": 0,
  neu: 0,
  // 1: waiting / blocked
  blocked: 1,
  waiting: 1,
  "waiting for feedback": 1,
  "warte auf feedback": 1,
  pending: 1,
  review: 1,
  // 2: actively in progress
  doing: 2,
  active: 2,
  "in progress": 2,
  "in bearbeitung": 2,
  "in arbeit": 2,
  // 3: complete
  done: 3,
  complete: 3,
  completed: 3,
  closed: 3,
  erledigt: 3,
  fertig: 3,
  // 4: archived / cancelled (after done)
  archived: 4,
  archiviert: 4,
  cancelled: 4,
  canceled: 4,
  abgebrochen: 4,
};

export function statusRankOf(name: string): number {
  return STATUS_RANK[name.toLowerCase()] ?? Number.POSITIVE_INFINITY;
}

// Escape pipe-meaningful characters in a GFM table cell. Literal `|` must be
// backslash-escaped or it terminates the cell; embedded newlines (`\n`/`\r\n`)
// break the row entirely — collapse them to a single space so the cell stays
// on its own line.
//
// Tag-aware: `rt()` emits inline `<a href="…">title</a>` for page mentions,
// and a `|` inside the anchor body would otherwise be backslash-escaped,
// surfacing as visible `\|` in the rendered cell. We walk
// char-by-char and skip pipe-escaping (a) inside an HTML tag's `<…>`
// brackets — URLs in `href=…` are already percent-encoded by `mdUrl(...)`
// but a stray `|` in a tag attribute would still be wrong to escape — and
// (b) inside the body of an inline `<a>` element (the only renderer-emitted
// tag whose body can carry a literal `|` from operator-supplied text:
// `rt()` HTML-escapes everything else first, so `<code>`/`<strong>` bodies
// won't contain a raw `|`-bearing run that needs special handling). Newlines
// are still collapsed everywhere (including inside tags) so a multi-line
// attribute value can't bleed into the next row.
export function mdCell(value: string): string {
  let out = "";
  let i = 0;
  // Depth counter for nested `<a>` opens; Notion-emitted cells never nest
  // anchors but the counter is robust against future renderer changes.
  let anchorDepth = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "<") {
      const end = value.indexOf(">", i);
      if (end === -1) {
        // Unterminated `<` — `rt()` always escapes `<` to `&lt;` so this is
        // pathological in practice, but defense-in-depth: still backslash-
        // escape `|` and collapse newlines in the tail so a manually-built
        // cell value cannot break the surrounding GFM table.
        out += value.slice(i).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
        break;
      }
      const tag = value.slice(i, end + 1);
      // Track anchor-body context. `<a>` / `<a …>` open; `</a>` close. Any
      // other tag is opaque pass-through.
      if (/^<a\b/i.test(tag)) anchorDepth += 1;
      else if (/^<\/a\s*>$/i.test(tag) && anchorDepth > 0) anchorDepth -= 1;
      // Collapse newlines that may live inside the tag (defensive — rt()
      // doesn't currently produce any, but a manually-built cell could).
      out += tag.replace(/\r?\n/g, " ");
      i = end + 1;
    } else if (ch === "|" && anchorDepth === 0) {
      out += "\\|";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      out += " ";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function plainTextOf(text: { plain_text?: string }[]): string {
  return text.map((t) => t.plain_text ?? "").join("");
}

export function headingLevel(type: string): 1 | 2 | 3 | 4 | null {
  if (type === "heading_1") return 1;
  if (type === "heading_2") return 2;
  if (type === "heading_3") return 3;
  if (type === "heading_4") return 4;
  return null;
}

// GitHub-style anchor slug: lowercase, strip punctuation, replace whitespace
// with `-`. Kept in sync with the heading renderer override in html.ts so
// in-page TOC links resolve.
export function slugifyHeading(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/[^\p{L}\p{N}\s-]+/gu, "") // strip punctuation/emoji, keep letters/numbers
    .trim()
    .replace(/\s+/g, "-");
}

export function quotePrefix(s: string): string {
  return s
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

export function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((line, i) => (i === 0 ? line : prefix + line))
    .join("\n");
}

export function basenameFromUrl(src: string): string {
  if (!src) return "";
  try {
    // Use URL parsing so query strings (Notion S3 signing params) get dropped.
    const u = src.startsWith("http") ? new URL(src) : null;
    const pathname = u ? u.pathname : src;
    const last = pathname.split("/").pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    const last = src.split("/").pop() ?? "";
    return last;
  }
}

export function resolveFileSrc(data: Record<string, unknown>, assetPrefix = ""): string {
  const local = (data.local_path as string | undefined)?.replace(/\\/g, "/");
  const external = (data as { external?: { url?: string } }).external?.url;
  const file = (data as { file?: { url?: string } }).file?.url;
  // local_path is a relative web src; normalize Windows "\" separators to "/"
  // (raw JSON produced on Windows stores backslashes). External/file are URLs.
  if (local) return local.startsWith("assets/") ? assetPrefix + local : local;
  return external ?? file ?? "";
}

export function formatDate(iso: string): string {
  // YYYY-MM-DD slice is portable + readable; full ISO kept in raw JSON
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? iso;
}
