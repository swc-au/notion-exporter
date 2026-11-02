import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cloneIncremental, type PhaseContext, rehydrateResume } from "../src/commands/export.js";
import { loadConfig } from "../src/config.js";
import { collectLocalAssetPaths } from "../src/export/assetReferences.js";
import { fileSha256, readManifest, writeManifest } from "../src/export/manifest.js";
import { buildPaths } from "../src/export/paths.js";
import { applyRetention } from "../src/export/retention.js";
import {
  findVerifiedPreviousExport,
  isVerifiedSnapshot,
  markSnapshotVerified,
} from "../src/export/verifiedSnapshot.js";
import { createLogger } from "../src/logger.js";
import type { DiscoveredObject } from "../src/notion/crawl.js";

it("finds nested media, page/row properties and escaped JSON references without treating property names as paths", () => {
  const raw = JSON.parse(
    '{"page":{"icon":{"file":{"local_path":"assets/icon.png"}},"properties":{"local_path":{"type":"title","title":[{"plain_text":"ordinary property name"}]},"Files":{"files":[{"external":{"local_path":"assets/file.pdf"}}]}}},"blocks":[{"children":[{"image":{"local\\u005fpath":"assets\\/image.png"}}]}],"rows":[{"cover":{"external":{"local_path":"assets/row.png"}}}],"comments":[{"mention":{"custom_emoji":{"local_path":"assets/emoji.png"}}}]}',
  );
  expect([...collectLocalAssetPaths(raw)].sort()).toEqual(
    [
      "assets/icon.png",
      "assets/file.pdf",
      "assets/image.png",
      "assets/row.png",
      "assets/emoji.png",
    ].sort(),
  );
  expect(
    collectLocalAssetPaths({
      url: "https://example.com/remote.pdf",
      text: "local_path: assets/not-a-reference",
    }).size,
  ).toBe(0);
});
it.each([
  "../secret",
  "/assets/a",
  "assets/../outside",
  "assets//a",
  "assets/",
  "assets\\a",
  "https://example.com/a",
  null,
  42,
])("refuses malformed or escaping local references: %j", (value) => {
  expect(() => collectLocalAssetPaths({ file: { local_path: value } })).toThrow(
    /Invalid local asset reference/,
  );
});

async function fixture(
  out: string,
  stamp: string,
  opts: { inventory?: boolean; bytes?: boolean; kind?: "page" | "database" } = {},
) {
  const root = path.join(out, stamp);
  const kind = opts.kind ?? "page";
  const raw = path.join(
    root,
    "raw",
    kind === "page" ? "pages" : "databases",
    "Source.00000000-0000-0000-0000-000000000001.json",
  );
  await fsp.mkdir(path.dirname(raw), { recursive: true });
  const payload = { file: { local_path: "assets/document.txt" } };
  await fsp.writeFile(
    raw,
    JSON.stringify(
      kind === "page"
        ? { page: { id: "00000000-0000-0000-0000-000000000001" }, blocks: [payload] }
        : {
            database: { id: "00000000-0000-0000-0000-000000000001" },
            rows: [{ properties: { Files: { files: [payload] } } }],
          },
    ),
  );
  const asset = path.join(root, "assets/document.txt");
  await fsp.mkdir(path.dirname(asset), { recursive: true });
  await fsp.writeFile(asset, "attachment bytes");
  const digest = await fileSha256(asset);
  if (opts.bytes === false) await fsp.rm(asset);
  await writeManifest({
    exportRoot: root,
    manifestPath: path.join(root, "manifest.json"),
    version: "test",
    timestamp: stamp,
    entries: [{ id: "00000000-0000-0000-0000-000000000001", kind, title: "Source", rawAbs: raw }],
    assets:
      opts.inventory === false
        ? []
        : [
            {
              originalUrl: "https://synthetic.example/document.txt",
              localPath: "assets/document.txt",
              ...digest,
            },
          ],
  });
  return { root, expected: [{ id: "00000000-0000-0000-0000-000000000001", object: kind }] };
}
it.each(["page", "database"] as const)(
  "rejects unlisted %s attachments even when bytes exist or are missing",
  async (kind) => {
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-asset-coverage-"));
    try {
      const good = await fixture(out, "2026-01-01T00-00-00Z");
      await markSnapshotVerified(good.root, good.expected, 0);
      for (const [i, bytes] of [true, false].entries()) {
        const bad = await fixture(out, `2026-02-0${i + 1}T00-00-00Z`, {
          kind,
          inventory: false,
          bytes,
        });
        await expect(markSnapshotVerified(bad.root, bad.expected, 0)).rejects.toThrow(
          /required asset missing from manifest/,
        );
        expect(await isVerifiedSnapshot(bad.root)).toBe(false);
      }
      expect(await applyRetention(out, 1, createLogger("error"))).toEqual([]);
      expect((await findVerifiedPreviousExport(out))?.root).toBe(good.root);
    } finally {
      await fsp.rm(out, { recursive: true, force: true });
    }
  },
);
it("requires bytes for an inventoried reference, and accepts fully covered nested data", async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-asset-bytes-"));
  try {
    const missing = await fixture(out, "2026-01-01T00-00-00Z", { bytes: false });
    await expect(markSnapshotVerified(missing.root, missing.expected, 0)).rejects.toThrow();
    const good = await fixture(out, "2026-02-01T00-00-00Z", { kind: "database" });
    await markSnapshotVerified(good.root, good.expected, 0);
    expect(await isVerifiedSnapshot(good.root)).toBe(true);
  } finally {
    await fsp.rm(out, { recursive: true, force: true });
  }
});

function makePhaseCtx(
  overrides: Partial<PhaseContext> & Pick<PhaseContext, "paths">,
): PhaseContext {
  const cfg = loadConfig({ NOTION_TOKEN: "x", OUT_DIR: "/tmp" });
  return {
    cfg,
    log: createLogger("error"),
    paths: overrides.paths,
    objects: [],
    byId: new Map(),
    hierarchy: new Map(),
    pageIndex: new Map(),
    childrenMap: new Map(),
    pageIcons: new Map(),
    assets: undefined as unknown as PhaseContext["assets"],
    skipIds: new Set(),
    manifestEntries: [],
    sitemap: [],
    searchDocs: [],
    carriedAssets: [],
    dbDataById: new Map(),
    customEmojiByName: new Map(),
    commentsDisabled: false,
    ...overrides,
  };
}

it("incremental cloning carries escaped JSON references and their asset records", async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-asset-incremental-"));
  try {
    const prev = await fixture(out, "2026-01-01T00-00-00Z");
    const manifest = (await readManifest(path.join(prev.root, "manifest.json")))!;
    const raw = path.join(prev.root, manifest.entries[0]!.rawPath);
    const text = (await fsp.readFile(raw, "utf8")).replace("local_path", "local\\u005fpath");
    await fsp.writeFile(raw, text);
    Object.assign(manifest.entries[0]!, await fileSha256(raw));
    await fsp.writeFile(path.join(prev.root, "manifest.json"), JSON.stringify(manifest));
    await markSnapshotVerified(prev.root, prev.expected, 0);
    const obj: DiscoveredObject = {
      id: prev.expected[0]!.id,
      object: "page",
      title: "Source",
      parent: { type: "workspace" },
    };
    const ctx = makePhaseCtx({
      paths: buildPaths(out, "2026-02-01T00-00-00Z"),
      byId: new Map([[obj.id, obj]]),
      skipIds: new Set([obj.id]),
    });
    await cloneIncremental(ctx, { root: prev.root, manifest });
    expect(ctx.carriedAssets).toHaveLength(1);
    expect(await fsp.readFile(path.join(ctx.paths.root, "assets/document.txt"), "utf8")).toBe(
      "attachment bytes",
    );
    await writeManifest({
      exportRoot: ctx.paths.root,
      manifestPath: ctx.paths.manifest,
      version: "test",
      timestamp: "test",
      entries: ctx.manifestEntries,
      assets: ctx.carriedAssets,
    });
    await markSnapshotVerified(ctx.paths.root, prev.expected, 0);
    expect(await isVerifiedSnapshot(ctx.paths.root)).toBe(true);
  } finally {
    await fsp.rm(out, { recursive: true, force: true });
  }
});
it("resumed raw references without carried asset records cannot be sealed", async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-asset-resume-"));
  try {
    const resumed = await fixture(out, "2026-01-01T00-00-00Z", { inventory: false });
    await fsp.rm(path.join(resumed.root, "manifest.json"));
    const obj: DiscoveredObject = {
      id: resumed.expected[0]!.id,
      object: "page",
      title: "Source",
      parent: { type: "workspace" },
    };
    const ctx = makePhaseCtx({
      paths: buildPaths(out, path.basename(resumed.root)),
      byId: new Map([[obj.id, obj]]),
    });
    await rehydrateResume(ctx);
    expect(ctx.skipIds.has(obj.id)).toBe(true);
    await writeManifest({
      exportRoot: ctx.paths.root,
      manifestPath: ctx.paths.manifest,
      version: "test",
      timestamp: "test",
      entries: ctx.manifestEntries,
      assets: ctx.carriedAssets,
    });
    await expect(markSnapshotVerified(ctx.paths.root, resumed.expected, 0)).rejects.toThrow(
      /required asset missing from manifest/,
    );
    expect(await isVerifiedSnapshot(ctx.paths.root)).toBe(false);
  } finally {
    await fsp.rm(out, { recursive: true, force: true });
  }
});
