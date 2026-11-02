import { expect, it } from "vitest";
import { assertRequiredSources, parseRequiredSources } from "../src/export/requiredSources.js";

it.each([
  null,
  {},
  [],
  [{ id: "", object: "page" }],
  [{ id: " p ", object: "page" }],
  [{ id: "p", object: "data_source" }],
  [{ id: "p", object: "page", unexpected: true }],
])("rejects invalid required inventory %j", (value) => {
  expect(() => parseRequiredSources(value)).toThrow();
});
it("allows additional discovered content but rejects missing and wrong-kind roots", () => {
  const required = [{ id: "p", object: "page" }] as const;
  expect(() =>
    assertRequiredSources(required, [
      { id: "p", object: "page" },
      { id: "d", object: "database" },
    ]),
  ).not.toThrow();
  expect(() => assertRequiredSources(required, [])).toThrow(/missing/);
  expect(() => assertRequiredSources(required, [{ id: "p", object: "database" }])).toThrow(
    /wrong kind/,
  );
});

it("enforces persisted policy independently of the crawl and preserves retained history", async () => {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { writeManifest } = await import("../src/export/manifest.js");
  const { markSnapshotVerified, isVerifiedSnapshot } = await import(
    "../src/export/verifiedSnapshot.js"
  );
  const { applyRetention } = await import("../src/export/retention.js");
  const { createLogger } = await import("../src/logger.js");
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "coverage-retained-"));
  const expected = [{ id: "p", object: "page" }] as const;
  async function make(stamp: string, required: unknown) {
    const root = path.join(out, stamp);
    const raw = path.join(root, "raw/pages/p.json");
    await fsp.mkdir(path.dirname(raw), { recursive: true });
    await fsp.writeFile(raw, JSON.stringify({ page: { id: "p" }, blocks: [] }));
    const manifest = await writeManifest({
      exportRoot: root,
      manifestPath: path.join(root, "manifest.json"),
      version: "test",
      timestamp: stamp,
      entries: [{ id: "p", kind: "page", title: "P", rawAbs: raw }],
      assets: [],
    });
    await fsp.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ ...manifest, requiredSources: required }),
    );
    return root;
  }
  try {
    const good = await make("2026-01-01T00-00-00Z", expected);
    await markSnapshotVerified(good, expected, 0);
    for (const [i, policy] of [[{ id: "absent", object: "page" }], [], null].entries()) {
      const bad = await make(`2026-02-0${i + 1}T00-00-00Z`, policy);
      await expect(markSnapshotVerified(bad, expected, 0)).rejects.toThrow();
      expect(await isVerifiedSnapshot(bad)).toBe(false);
    }
    expect(await applyRetention(out, 1, createLogger("error"))).toEqual([]);
    expect(await isVerifiedSnapshot(good)).toBe(true);
  } finally {
    await fsp.rm(out, { recursive: true, force: true });
  }
});
