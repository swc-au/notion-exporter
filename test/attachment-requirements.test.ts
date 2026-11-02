import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cloneIncremental, type PhaseContext, rehydrateResume } from "../src/commands/export.js";
import { loadConfig } from "../src/config.js";
import { readManifest, writeManifest } from "../src/export/manifest.js";
import { buildPaths } from "../src/export/paths.js";
import { isVerifiedSnapshot, markSnapshotVerified } from "../src/export/verifiedSnapshot.js";
import { createLogger } from "../src/logger.js";
import type { DiscoveredObject } from "../src/notion/crawl.js";

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

const id = "00000000-0000-0000-0000-000000000001";
const remote = { type: "file", file: { url: "https://synthetic.example/attachment.txt" } };
const external = {
  type: "external",
  external: { url: "https://synthetic.example/attachment.txt" },
};
const emoji = {
  type: "custom_emoji",
  custom_emoji: { id: "emoji", name: "sample", url: "https://synthetic.example/emoji.png" },
};
const cases: Array<[string, "page" | "database", unknown]> = [
  [
    "comment attachment",
    "page",
    {
      page: { id },
      blocks: [],
      comments: [
        {
          object: "comment",
          id: "comment",
          attachments: [
            {
              category: "image",
              file: { url: "https://synthetic.example/comment.png", expiry_time: "later" },
            },
          ],
        },
      ],
    },
  ],
  ["uploaded block", "page", { page: { id }, blocks: [{ id: "b", type: "file", file: remote }] }],
  [
    "external block",
    "page",
    { page: { id }, blocks: [{ id: "b", type: "image", image: external }] },
  ],
  ["page icon", "page", { page: { id, object: "page", icon: remote }, blocks: [] }],
  ["page cover", "page", { page: { id, object: "page", cover: external }, blocks: [] }],
  [
    "page file property",
    "page",
    {
      page: { id, object: "page", properties: { Files: { type: "files", files: [remote] } } },
      blocks: [],
    },
  ],
  ["database cover", "database", { database: { id, object: "database", cover: remote }, rows: [] }],
  ["database icon", "database", { database: { id, object: "database", icon: emoji }, rows: [] }],
  [
    "row media",
    "database",
    { database: { id }, rows: [{ id: "row", object: "page", icon: remote, cover: external }] },
  ],
  [
    "row file property",
    "database",
    {
      database: { id },
      rows: [{ id: "row", properties: { Files: { type: "files", files: [external] } } }],
    },
  ],
  [
    "callout icon",
    "page",
    {
      page: { id },
      blocks: [{ id: "b", type: "callout", callout: { rich_text: [], icon: external } }],
    },
  ],
  [
    "custom emoji mention",
    "page",
    {
      page: { id },
      blocks: [
        {
          id: "b",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "mention", mention: emoji }] },
        },
      ],
    },
  ],
  [
    "nested media",
    "page",
    {
      page: { id },
      blocks: [
        { id: "parent", type: "toggle", children: [{ id: "child", type: "pdf", pdf: remote }] },
      ],
    },
  ],
];
for (const [label, kind, payload] of cases)
  it(`${label}: absent local path rejects fresh, resume and incremental`, async () => {
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), "ss89-url-only-"));
    const expected = [{ id, object: kind }];
    const obj: DiscoveredObject = {
      id,
      object: kind,
      title: "Source",
      parent: { type: "workspace" },
    };
    async function seed(stamp: string) {
      const paths = buildPaths(out, stamp);
      const rawAbs = path.join(
        paths.raw,
        kind === "page" ? "pages" : "databases",
        `Source.${id}.json`,
      );
      await fsp.mkdir(path.dirname(rawAbs), { recursive: true });
      await fsp.writeFile(rawAbs, JSON.stringify(payload));
      await writeManifest({
        exportRoot: paths.root,
        manifestPath: paths.manifest,
        version: "probe",
        timestamp: stamp,
        entries: [{ id, kind, title: "Source", rawAbs }],
        assets: [],
      });
      return paths;
    }
    async function seal(ctx: PhaseContext) {
      await writeManifest({
        exportRoot: ctx.paths.root,
        manifestPath: ctx.paths.manifest,
        version: "probe",
        timestamp: "probe",
        entries: ctx.manifestEntries,
        assets: ctx.carriedAssets,
      });
      await expect(markSnapshotVerified(ctx.paths.root, expected, 0)).rejects.toThrow(
        /required attachment has no local path/,
      );
      expect(await isVerifiedSnapshot(ctx.paths.root)).toBe(false);
      expect(ctx.carriedAssets).toHaveLength(0);
    }
    try {
      const fresh = await seed("2026-01-01T00-00-00Z");
      await expect(markSnapshotVerified(fresh.root, expected, 0)).rejects.toThrow(
        /required attachment has no local path/,
      );
      expect(await isVerifiedSnapshot(fresh.root)).toBe(false);
      const resumed = await seed("2026-02-01T00-00-00Z");
      await fsp.rm(resumed.manifest);
      const resumeCtx = makePhaseCtx({ paths: resumed, byId: new Map([[id, obj]]) });
      await rehydrateResume(resumeCtx);
      expect(resumeCtx.skipIds.has(id)).toBe(true);
      await seal(resumeCtx);
      const manifest = (await readManifest(fresh.manifest))!;
      const cloneCtx = makePhaseCtx({
        paths: buildPaths(out, "2026-03-01T00-00-00Z"),
        byId: new Map([[id, obj]]),
        skipIds: new Set([id]),
      });
      await cloneIncremental(cloneCtx, { root: fresh.root, manifest });
      await seal(cloneCtx);
    } finally {
      await fsp.rm(out, { recursive: true, force: true });
    }
  });
