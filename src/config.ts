import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

/**
 * Environment variable → grouped Config field mapping.
 *
 * The env var names below are the public operator contract and are stable.
 * Internally we expose a grouped `Config` for readability — `loadConfig`
 * reshapes the parsed flat env into purpose-buckets via `.transform`.
 *
 *   NOTION_TOKEN          → cfg.token                       (top-level — secret)
 *   OUT_DIR               → cfg.io.outDir
 *   RETENTION             → cfg.io.retention
 *   ASSET_CONCURRENCY     → cfg.io.assetConcurrency
 *   PAGE_CONCURRENCY      → cfg.io.pageConcurrency
 *   PRETTY_RAW_JSON       → cfg.io.prettyRawJson
 *   NOTION_MIN_TIME       → cfg.notion.minTime
 *   NOTION_MAX_CONCURRENT → cfg.notion.maxConcurrent
 *   NOTION_MAX_RETRIES    → cfg.notion.maxRetries
 *   CRAWL_CONCURRENCY     → cfg.crawl.concurrency
 *   EXPAND_CHILD_PAGES    → cfg.crawl.expandChildPages
 *   EXPORT_TITLE          → cfg.render.exportTitle
 *   EXPORT_ICON           → cfg.render.exportIcon
 *   EXPORT_ROW_MEDIA      → cfg.render.rowMedia
 *   STYLE_BACK_LINKS      → cfg.render.backLinks
 *   EXPORT_DB_VIEW        → cfg.render.dbView
 *   LOG_LEVEL             → cfg.log.level
 */
const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "string" ? v !== "false" && v !== "0" : v));

const schema = z.object({
  NOTION_TOKEN: z.string().min(1).optional(),
  REQUIRED_SOURCES_FILE: z.string().min(1).optional(),
  OUT_DIR: z.string().default("./exports"),
  RETENTION: z.coerce.number().int().min(0).default(0),
  ASSET_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(16),
  PAGE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  EXPORT_TITLE: z.string().default("Your Notion archive"),
  /** Single emoji glyph (or path to an image file relative to html/) shown as
   * the workspace icon in the sidebar header. Default 📚. */
  EXPORT_ICON: z.string().default("📚"),
  /** Notion API rate-limiter knobs. The defaults aim for safe steady-state
   * throughput; bump cautiously if you see no 429 retries in your logs. */
  NOTION_MIN_TIME: z.coerce.number().int().min(0).default(150),
  NOTION_MAX_CONCURRENT: z.coerce.number().int().min(1).default(4),
  NOTION_MAX_RETRIES: z.coerce.number().int().min(0).default(8),
  /** Crawl expansion fan-out — how many pages to walk in parallel when
   * discovering subpages via block traversal. Higher = faster discovery on
   * shallow workspaces, but eats more of the Notion limiter budget. */
  CRAWL_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  /** When false, skip downloading per-row cover/icon images on databases —
   * the inline gallery still renders cards with placeholders. Huge speed-up
   * for media-heavy workspaces where you only want the textual backup. */
  EXPORT_ROW_MEDIA: boolFromEnv.default(true),
  /** Pretty-print raw JSON (true, default) or write compact (false) for
   * smaller files / faster I/O on huge workspaces. */
  PRETTY_RAW_JSON: boolFromEnv.default(true),
  /** When false, skip the block-tree walk that discovers subpages not
   * returned by Notion's `search`. Misses nested content; only set when you
   * know `search` already returns everything you need. */
  EXPAND_CHILD_PAGES: boolFromEnv.default(true),
  /** Opt-in styling for "↩️ Zurück zu …" / "↩️ Back to …" links the user
   * places immediately below an H1. Wraps them in a pill-styled `back-link`
   * paragraph so they read as a deliberate navigation affordance. Off by
   * default — it's a personal convention. */
  STYLE_BACK_LINKS: boolFromEnv.default(false),
  /** Inline-DB render mode. `auto` (default) lets the renderer pick: a kanban
   * board when the schema/rows look kanban-shaped (single status/select column
   * with 2-12 buckets, ≥6 rows, ≥80% populated), else the existing
   * gallery/table view. Force `table` to disable kanban detection globally;
   * force `kanban` to render every DB as a board (groups fall back to a
   * single "No status" column when no grouping property exists). */
  EXPORT_DB_VIEW: z.enum(["auto", "table", "kanban"]).default("auto"),
});

export type LogLevel = z.infer<typeof schema>["LOG_LEVEL"];

export interface Config {
  /** NOTION_TOKEN — kept top-level because it's the lone secret and is
   * passed around independently via {@link requireToken}. */
  token: string | undefined;
  io: {
    requiredSourcesFile?: string;
    outDir: string;
    retention: number;
    assetConcurrency: number;
    pageConcurrency: number;
    prettyRawJson: boolean;
  };
  notion: {
    minTime: number;
    maxConcurrent: number;
    maxRetries: number;
  };
  crawl: {
    concurrency: number;
    expandChildPages: boolean;
  };
  render: {
    exportTitle: string;
    exportIcon: string;
    rowMedia: boolean;
    backLinks: boolean;
    dbView: "auto" | "table" | "kanban";
  };
  log: {
    level: LogLevel;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = schema.parse(env);
  return {
    token: raw.NOTION_TOKEN,
    io: {
      requiredSourcesFile: raw.REQUIRED_SOURCES_FILE,
      outDir: raw.OUT_DIR,
      retention: raw.RETENTION,
      assetConcurrency: raw.ASSET_CONCURRENCY,
      pageConcurrency: raw.PAGE_CONCURRENCY,
      prettyRawJson: raw.PRETTY_RAW_JSON,
    },
    notion: {
      minTime: raw.NOTION_MIN_TIME,
      maxConcurrent: raw.NOTION_MAX_CONCURRENT,
      maxRetries: raw.NOTION_MAX_RETRIES,
    },
    crawl: {
      concurrency: raw.CRAWL_CONCURRENCY,
      expandChildPages: raw.EXPAND_CHILD_PAGES,
    },
    render: {
      exportTitle: raw.EXPORT_TITLE,
      exportIcon: raw.EXPORT_ICON,
      rowMedia: raw.EXPORT_ROW_MEDIA,
      backLinks: raw.STYLE_BACK_LINKS,
      dbView: raw.EXPORT_DB_VIEW,
    },
    log: {
      level: raw.LOG_LEVEL,
    },
  };
}

export function requireToken(cfg: Config): string {
  if (!cfg.token) {
    throw new Error("NOTION_TOKEN missing. Set it in .env or environment. See .env.example.");
  }
  return cfg.token;
}
