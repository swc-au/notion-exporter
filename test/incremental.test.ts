import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findPartialExport,
  findPreviousExport,
  readManifest,
  writeManifest,
} from "../src/export/manifest.js";
import { cloneFile } from "../src/util/fsclone.js";

async function tmpDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("manifest read + findPreviousExport", () => {
  it("returns null if no exports present", async () => {
    const tmp = await tmpDir("ne-prev-empty-");
    expect(await findPreviousExport(tmp)).toBeNull();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns most recent stamped dir with a manifest", async () => {
    const tmp = await tmpDir("ne-prev-find-");
    const old = path.join(tmp, "2026-01-01T00-00-00Z");
    const newer = path.join(tmp, "2026-05-29T00-00-00Z");
    await fsp.mkdir(old);
    await fsp.mkdir(newer);
    await fsp.writeFile(
      path.join(old, "manifest.json"),
      JSON.stringify({
        tool: { name: "x", version: "0" },
        timestamp: "old",
        counts: { pages: 0, databases: 0, assets: 0 },
        entries: [],
        assets: [],
      }),
    );
    await fsp.writeFile(
      path.join(newer, "manifest.json"),
      JSON.stringify({
        tool: { name: "x", version: "0" },
        timestamp: "new",
        counts: { pages: 0, databases: 0, assets: 0 },
        entries: [],
        assets: [],
      }),
    );
    const found = await findPreviousExport(tmp);
    expect(found?.root).toBe(newer);
    expect(found?.manifest.timestamp).toBe("new");
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("excludeStamp skips current run", async () => {
    const tmp = await tmpDir("ne-prev-excl-");
    const d = path.join(tmp, "2026-05-29T00-00-00Z");
    await fsp.mkdir(d);
    await fsp.writeFile(
      path.join(d, "manifest.json"),
      JSON.stringify({
        tool: { name: "x", version: "0" },
        timestamp: "t",
        counts: { pages: 0, databases: 0, assets: 0 },
        entries: [],
        assets: [],
      }),
    );
    const found = await findPreviousExport(tmp, "2026-05-29T00-00-00Z");
    expect(found).toBeNull();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("readManifest returns null on missing or invalid file", async () => {
    const tmp = await tmpDir("ne-read-");
    expect(await readManifest(path.join(tmp, "nope.json"))).toBeNull();
    await fsp.writeFile(path.join(tmp, "bad.json"), "{not json");
    expect(await readManifest(path.join(tmp, "bad.json"))).toBeNull();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("writeManifest emits lastEditedTime + basedOn + skipped", async () => {
    const tmp = await tmpDir("ne-wman-");
    const raw = path.join(tmp, "raw", "pages", "x.json");
    await fsp.mkdir(path.dirname(raw), { recursive: true });
    await fsp.writeFile(raw, "{}");
    const m = await writeManifest({
      exportRoot: tmp,
      manifestPath: path.join(tmp, "manifest.json"),
      version: "0.1.0",
      timestamp: "t",
      entries: [
        { id: "p1", kind: "page", title: "A", rawAbs: raw, lastEditedTime: "2026-05-01T00:00:00Z" },
      ],
      assets: [],
      skipped: 5,
      basedOn: "prev-stamp",
    });
    expect(m.entries[0]!.lastEditedTime).toBe("2026-05-01T00:00:00Z");
    expect(m.counts.skipped).toBe(5);
    expect(m.basedOn).toBe("prev-stamp");
    await fsp.rm(tmp, { recursive: true, force: true });
  });
});

describe("findPartialExport", () => {
  it("returns the newest manifest-less stamped dir", async () => {
    const tmp = await tmpDir("ne-partial-");
    const complete = path.join(tmp, "2026-05-29T00-00-00Z");
    const partial = path.join(tmp, "2026-05-30T00-00-00Z");
    await fsp.mkdir(complete);
    await fsp.mkdir(partial);
    await fsp.mkdir(path.join(partial, "raw"));
    await fsp.writeFile(
      path.join(complete, "manifest.json"),
      JSON.stringify({
        tool: { name: "x", version: "0" },
        timestamp: "old",
        counts: { pages: 0, databases: 0, assets: 0 },
        entries: [],
        assets: [],
      }),
    );
    const found = await findPartialExport(tmp);
    expect(found).toBe(partial);
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns null when every stamped dir has a manifest", async () => {
    const tmp = await tmpDir("ne-no-partial-");
    const d = path.join(tmp, "2026-05-29T00-00-00Z");
    await fsp.mkdir(d);
    await fsp.writeFile(
      path.join(d, "manifest.json"),
      JSON.stringify({
        tool: { name: "x", version: "0" },
        timestamp: "t",
        counts: { pages: 0, databases: 0, assets: 0 },
        entries: [],
        assets: [],
      }),
    );
    expect(await findPartialExport(tmp)).toBeNull();
    await fsp.rm(tmp, { recursive: true, force: true });
  });
});

describe("cloneFile", () => {
  it("hardlinks (or copies) existing file", async () => {
    const tmp = await tmpDir("ne-clone-");
    const src = path.join(tmp, "src.txt");
    const dst = path.join(tmp, "out", "dst.txt");
    await fsp.writeFile(src, "hello");
    const ok = await cloneFile(src, dst);
    expect(ok).toBe(true);
    const content = await fsp.readFile(dst, "utf8");
    expect(content).toBe("hello");
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns false for missing source", async () => {
    const tmp = await tmpDir("ne-clone-miss-");
    const ok = await cloneFile(path.join(tmp, "nope"), path.join(tmp, "out"));
    expect(ok).toBe(false);
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("idempotent if destination already exists", async () => {
    const tmp = await tmpDir("ne-clone-idemp-");
    const src = path.join(tmp, "src.txt");
    const dst = path.join(tmp, "dst.txt");
    await fsp.writeFile(src, "hello");
    expect(await cloneFile(src, dst)).toBe(true);
    expect(await cloneFile(src, dst)).toBe(true);
    await fsp.rm(tmp, { recursive: true, force: true });
  });
});
