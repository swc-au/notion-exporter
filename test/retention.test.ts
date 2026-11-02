import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileSha256, writeManifest } from "../src/export/manifest.js";
import { applyRetention } from "../src/export/retention.js";
import {
  findVerifiedPreviousExport,
  isVerifiedSnapshot,
  markSnapshotVerified,
  verifySnapshot,
} from "../src/export/verifiedSnapshot.js";
import { createLogger } from "../src/logger.js";

const SOURCE = { id: "page-one", object: "page" } as const;

async function fixture(
  outDir: string,
  stamp: string,
  opts: { verify?: boolean; withAsset?: boolean; failedAsset?: boolean } = {},
) {
  const root = path.join(outDir, stamp);
  const raw = path.join(root, "raw", "pages", "Page.page-one.json");
  await fsp.mkdir(path.dirname(raw), { recursive: true });
  await fsp.writeFile(raw, JSON.stringify({ page: { id: SOURCE.id }, blocks: [] }));
  const assets = [];
  if (opts.withAsset) {
    const abs = path.join(root, "assets", "example.txt");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, "image bytes");
    const digest = await fileSha256(abs);
    assets.push({
      originalUrl: "https://notion.example/file",
      localPath: "assets/example.txt",
      bytes: digest.bytes,
      sha256: digest.sha256,
    });
  }
  const manifestPath = path.join(root, "manifest.json");
  await writeManifest({
    exportRoot: root,
    manifestPath,
    version: "0.1.0",
    timestamp: stamp,
    entries: [{ id: SOURCE.id, kind: "page", title: "Page", rawAbs: raw }],
    assets,
    ...(opts.failedAsset
      ? { failedAssets: [{ url: "https://notion.example/fail", message: "network" }] }
      : {}),
  });
  if (opts.verify) await markSnapshotVerified(root, [SOURCE], 0);
  return { root, raw, manifestPath };
}

describe("verified snapshot retention", () => {
  it("prunes only the oldest fully verified snapshots and preserves legacy directories", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-ret-"));
    try {
      const stamps = [
        "2026-01-01T00-00-00Z",
        "2026-02-01T00-00-00Z",
        "2026-03-01T00-00-00Z",
        "2026-04-01T00-00-00Z",
      ];
      for (const stamp of stamps) await fixture(tmp, stamp, { verify: true });
      const legacy = "2025-12-01T00-00-00Z";
      await fixture(tmp, legacy);
      await fsp.mkdir(path.join(tmp, "not-a-stamp"));
      const deleted = await applyRetention(tmp, 2, createLogger("error"));
      expect(deleted).toEqual(stamps.slice(0, 2));
      const left = await fsp.readdir(tmp);
      expect(left.sort()).toEqual(
        [...stamps.slice(2), legacy, "not-a-stamp"].sort(),
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the last verified good when a newer snapshot has failed assets", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-part-"));
    try {
      const good = await fixture(tmp, "2026-01-01T00-00-00Z", { verify: true });
      const failed = await fixture(tmp, "2026-02-01T00-00-00Z", { failedAsset: true });
      await expect(markSnapshotVerified(failed.root, [SOURCE], 0)).rejects.toThrow(
        /asset downloads failed/,
      );
      expect(await applyRetention(tmp, 1, createLogger("error"))).toEqual([]);
      expect(await isVerifiedSnapshot(good.root)).toBe(true);
      expect(await isVerifiedSnapshot(failed.root)).toBe(false);
      const latest = await findVerifiedPreviousExport(tmp);
      expect(latest?.root).toBe(good.root);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an export with object failures without writing a verified marker", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-errors-"));
    try {
      const { root } = await fixture(tmp, "2026-01-01T00-00-00Z");
      await expect(markSnapshotVerified(root, [SOURCE], 1)).rejects.toThrow(
        /export reported 1 object errors/,
      );
      expect(await isVerifiedSnapshot(root)).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a missing source from the independent crawl inventory", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-scope-"));
    try {
      const { root } = await fixture(tmp, "2026-01-01T00-00-00Z");
      await expect(
        markSnapshotVerified(root, [SOURCE, { id: "missing-page", object: "page" }], 0),
      ).rejects.toThrow(/manifest entry count does not match/);
      expect(await isVerifiedSnapshot(root)).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a corrupted raw source and does not reuse the broken snapshot", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-corrupt-"));
    try {
      const { root, raw } = await fixture(tmp, "2026-01-01T00-00-00Z", { verify: true });
      await fsp.writeFile(raw, "corrupted");
      await expect(verifySnapshot(root)).rejects.toThrow(/checksum mismatch/);
      expect(await isVerifiedSnapshot(root)).toBe(false);
      expect(await findVerifiedPreviousExport(tmp)).toBeNull();
      expect(await applyRetention(tmp, 1, createLogger("error"))).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing or modified asset bytes on a previously verified snapshot", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-asset-"));
    try {
      const { root } = await fixture(tmp, "2026-01-01T00-00-00Z", {
        verify: true,
        withAsset: true,
      });
      expect(await isVerifiedSnapshot(root)).toBe(true);
      await fsp.writeFile(path.join(root, "assets", "example.txt"), "tampered");
      expect(await isVerifiedSnapshot(root)).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a modified manifest even when raw file bytes still match", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-manifest-"));
    try {
      const { root, manifestPath } = await fixture(tmp, "2026-01-01T00-00-00Z", {
        verify: true,
      });
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      manifest.tool.version = "tampered";
      await fsp.writeFile(manifestPath, JSON.stringify(manifest));
      expect(await isVerifiedSnapshot(root)).toBe(false);
      expect(await applyRetention(tmp, 1, createLogger("error"))).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps unverified legacy directories even if they outnumber retention", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-legacy-"));
    try {
      for (const stamp of ["2026-01-01T00-00-00Z", "2026-02-01T00-00-00Z"]) {
        await fixture(tmp, stamp);
      }
      expect(await applyRetention(tmp, 1, createLogger("error"))).toEqual([]);
      expect((await fsp.readdir(tmp)).length).toBe(2);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does nothing for keep=0 or when fewer verified snapshots than keep", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-verified-noop-"));
    try {
      await fixture(tmp, "2026-01-01T00-00-00Z", { verify: true });
      expect(await applyRetention(tmp, 0, createLogger("error"))).toEqual([]);
      expect(await applyRetention(tmp, 5, createLogger("error"))).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
