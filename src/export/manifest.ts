import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AssetFailure, AssetRecord } from "./assets.js";
import type { DeletionApproval } from "./deletionApproval.js";
import type { RequiredSource } from "./requiredSources.js";

/**
 * Manifest schema version. Bump when the on-disk shape changes in a way
 * that older consumers (rerender/repair) can't transparently handle.
 *
 * History:
 *   v2 (current) — adds `parentId` on entries. Older readers ignore the
 *                   field; sitemap reconstruction degrades to re-crawl.
 *   v1           — introduced `schemaVersion`.
 *   v0 (implicit, no `schemaVersion`) — pre-versioning exports.
 */
export const MANIFEST_SCHEMA_VERSION = 2;

export interface ManifestEntry {
  id: string;
  kind: "page" | "database";
  title: string;
  rawPath: string; // relative to export root
  sha256: string;
  bytes: number;
  lastEditedTime?: string;
  /** Resolved hierarchy parent id (after block_id walks). Persisted so
   * `rerender` can rebuild the sitemap tree without re-crawling. */
  parentId?: string;
}

export interface Manifest {
  requiredSources?: RequiredSource[];
  deletionApproval?: DeletionApproval;
  /** Shape version of this manifest. See {@link MANIFEST_SCHEMA_VERSION}. */
  schemaVersion: number;
  tool: { name: string; version: string };
  timestamp: string;
  counts: {
    pages: number;
    databases: number;
    assets: number;
    skipped?: number;
    failedAssets?: number;
  };
  basedOn?: string; // previous export timestamp this incremental run reused
  entries: ManifestEntry[];
  assets: AssetRecord[];
  failedAssets?: AssetFailure[];
}

/** Minimal logger surface — pino-compatible but trimmed so callers can pass
 * any object with these methods. */
interface ManifestLogger {
  info: (obj: unknown, msg?: string) => void;
}

/**
 * Read + version-check a manifest from disk.
 *
 * Returns `null` if the file is missing or unparseable (preserves prior
 * behavior used by `findPreviousExport` / `findPartialExport`).
 *
 * Throws if the on-disk `schemaVersion` is newer than this tool supports —
 * silently degrading would risk corrupting an export written by a newer
 * version of notion-exporter.
 *
 * When the manifest predates the `schemaVersion` field (v0), the parse
 * succeeds and — if a logger is supplied — emits a single info log so
 * operators know a best-effort fallback is in play.
 */
export async function readManifest(
  absPath: string,
  opts: { log?: ManifestLogger } = {},
): Promise<Manifest | null> {
  let parsed: Partial<Manifest> & Record<string, unknown>;
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const onDiskVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
  if (onDiskVersion > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `manifest at ${absPath} uses schemaVersion ${onDiskVersion}, this tool supports ${MANIFEST_SCHEMA_VERSION}. Upgrade notion-exporter.`,
    );
  }
  if (onDiskVersion < MANIFEST_SCHEMA_VERSION) {
    opts.log?.info(
      { path: absPath, found: onDiskVersion, expected: MANIFEST_SCHEMA_VERSION },
      "manifest predates current schema; reading with best-effort fallback",
    );
  }
  // Stamp the in-memory copy so downstream code sees a fully-shaped object.
  return { ...(parsed as Manifest), schemaVersion: onDiskVersion };
}

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export async function findPreviousExport(
  outDir: string,
  excludeStamp?: string,
): Promise<{ root: string; manifest: Manifest } | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(outDir);
  } catch {
    return null;
  }
  const stamped = entries
    .filter((e) => STAMP_RE.test(e) && e !== excludeStamp)
    .sort()
    .reverse();
  for (const stamp of stamped) {
    const root = path.join(outDir, stamp);
    const manifest = await readManifest(path.join(root, "manifest.json"));
    if (manifest) return { root, manifest };
  }
  return null;
}

/**
 * Walk `outDir`, sort the stamped sub-directories in reverse-chronological
 * order, and return the path of the newest one that has a readable
 * `manifest.json`. Returns `null` when no valid export is found.
 *
 * Used by `rerender` and `repair` to default-target the most recent export.
 */
export async function findLatestExport(outDir: string): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && STAMP_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      await fsp.access(path.join(outDir, name, "manifest.json"));
      return path.join(outDir, name);
    } catch {}
  }
  return null;
}

export async function findPartialExport(
  outDir: string,
  excludeStamp?: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(outDir);
  } catch {
    return null;
  }
  const stamped = entries
    .filter((e) => STAMP_RE.test(e) && e !== excludeStamp)
    .sort()
    .reverse();
  for (const stamp of stamped) {
    const root = path.join(outDir, stamp);
    const manifest = await readManifest(path.join(root, "manifest.json"));
    // Fresh publication reserves an empty timestamp directory. It contains
    // no resumable work and must never fall through to legacy in-place resume.
    if (!manifest && (await fsp.readdir(root)).length > 0) return root;
  }
  return null;
}

export async function fileSha256(absPath: string): Promise<{ sha256: string; bytes: number }> {
  const data = await fsp.readFile(absPath);
  return {
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
}

export interface ManifestInput {
  id: string;
  kind: "page" | "database";
  title: string;
  rawAbs: string;
  lastEditedTime?: string;
  parentId?: string;
}

export async function writeManifest(opts: {
  exportRoot: string;
  manifestPath: string;
  version: string;
  timestamp: string;
  entries: ManifestInput[];
  assets: AssetRecord[];
  failedAssets?: AssetFailure[];
  skipped?: number;
  basedOn?: string;
  requiredSources?: RequiredSource[];
  deletionApproval?: DeletionApproval;
}): Promise<Manifest> {
  const entries: ManifestEntry[] = [];
  for (const e of opts.entries) {
    const { sha256, bytes } = await fileSha256(e.rawAbs);
    entries.push({
      id: e.id,
      kind: e.kind,
      title: e.title,
      rawPath: path.relative(opts.exportRoot, e.rawAbs),
      sha256,
      bytes,
      ...(e.lastEditedTime ? { lastEditedTime: e.lastEditedTime } : {}),
      ...(e.parentId ? { parentId: e.parentId } : {}),
    });
  }
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: { name: "notion-exporter", version: opts.version },
    timestamp: opts.timestamp,
    counts: {
      pages: entries.filter((e) => e.kind === "page").length,
      databases: entries.filter((e) => e.kind === "database").length,
      assets: opts.assets.length,
      ...(opts.skipped !== undefined ? { skipped: opts.skipped } : {}),
      ...(opts.failedAssets && opts.failedAssets.length > 0
        ? { failedAssets: opts.failedAssets.length }
        : {}),
    },
    ...(opts.basedOn ? { basedOn: opts.basedOn } : {}),
    ...(opts.requiredSources ? { requiredSources: opts.requiredSources } : {}),
    ...(opts.deletionApproval ? { deletionApproval: opts.deletionApproval } : {}),
    entries,
    assets: opts.assets,
    ...(opts.failedAssets && opts.failedAssets.length > 0
      ? { failedAssets: opts.failedAssets }
      : {}),
  };
  await fsp.writeFile(opts.manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
