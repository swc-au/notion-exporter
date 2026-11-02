import fsp from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import { isVerifiedSnapshot } from "./verifiedSnapshot.js";

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/**
 * Keep the newest N *verified* snapshots. A failed, partial or pre-verification
 * export has no trusted marker: never delete it automatically. In particular,
 * no successful retention run may prune the last verified snapshot just
 * because a newer export directory exists.
 */
export async function applyRetention(outDir: string, keep: number, log: Logger): Promise<string[]> {
  if (keep <= 0) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stamped = entries
    .filter((e) => e.isDirectory() && STAMP_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const verified: string[] = [];
  for (const stamp of stamped) {
    if (await isVerifiedSnapshot(path.join(outDir, stamp))) verified.push(stamp);
  }
  const toDelete = verified.slice(0, Math.max(0, verified.length - keep));
  const deleted: string[] = [];
  for (const stamp of toDelete) {
    const abs = path.join(outDir, stamp);
    // Recheck at the point of deletion: do not prune if the archive changed
    // since the inventory was assembled.
    if (!(await isVerifiedSnapshot(abs))) {
      log.warn({ preserved: abs }, "retention skipped changed or invalid snapshot");
      continue;
    }
    await fsp.rm(abs, { recursive: true, force: false });
    deleted.push(stamp);
    log.info({ removed: abs }, "retention pruned verified export");
  }
  return deleted;
}
