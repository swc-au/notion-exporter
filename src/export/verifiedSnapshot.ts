import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertWithinRootAsync, readFileWithinRootAsync } from "../util/fs.js";
import { collectLocalAssetPaths, validateLocalAssetPath } from "./assetReferences.js";
import { attachmentRequirements } from "./attachmentRequirements.js";
import { MANIFEST_SCHEMA_VERSION, type Manifest, readManifest } from "./manifest.js";
import { assertRequiredSources } from "./requiredSources.js";

export const VERIFICATION_FILE = "verification.json";
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const SHA_RE = /^[a-f0-9]{64}$/;

export interface ExpectedSource {
  id: string;
  object: "page" | "database";
}

interface VerificationMarker {
  version: 1;
  status: "verified";
  verifiedAt: string;
  manifestSha256: string;
  entryCount: number;
  assetCount: number;
  /** Original manifest bytes retain historical coverage across maintenance. */
  sealedManifest?: string;
}

function fail(detail: string): never {
  throw new Error(`Snapshot verification failed: ${detail}`);
}

/**
 * Hash a file without reading its whole contents into memory. Every path
 * comes from an operator-editable manifest, so validate containment and
 * refuse a symlink at the leaf before reading it.
 */
async function digestFile(
  root: string,
  relative: string,
): Promise<{ sha256: string; bytes: number }> {
  const absolute = await assertWithinRootAsync(root, relative);
  const handle = await fsp.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`not a regular file: ${relative}`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function validateExpectedInventory(manifest: Manifest, expected: readonly ExpectedSource[]): void {
  if (expected.length === 0) fail("expected source inventory is empty");
  const identifiers = new Map<string, ExpectedSource["object"]>();
  for (const obj of expected) {
    if (!obj.id || (obj.object !== "page" && obj.object !== "database")) {
      fail("invalid expected source inventory");
    }
    if (identifiers.has(obj.id)) fail(`duplicate source ID in crawl: ${obj.id}`);
    identifiers.set(obj.id, obj.object);
  }
  if (manifest.entries.length !== expected.length) {
    fail("manifest entry count does not match the source inventory");
  }
  for (const item of manifest.entries) {
    const kind = identifiers.get(item.id);
    if (!kind) fail(`unexpected exported source: ${item.id}`);
    if (kind !== item.kind) fail(`source kind mismatch for ${item.id}`);
  }
}

/**
 * Validate the snapshot *before* declaring it usable. Checks independent
 * source coverage when a crawl inventory is supplied, plus the actual byte
 * length and SHA-256 of every raw JSON and downloaded asset.
 *
 * This is an archive-integrity check, not a guarantee that Notion's crawl
 * discovered all roots shared with the integration. External root coverage
 * remains a separate deployment acceptance gate.
 */
export async function verifySnapshot(
  root: string,
  expected?: readonly ExpectedSource[],
): Promise<Manifest> {
  const manifest = await readManifest(path.join(root, "manifest.json"));
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail("missing or unsupported manifest");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("empty or malformed exported source inventory");
  }
  if (!Array.isArray(manifest.assets) || !manifest.counts) fail("malformed manifest");
  if (Array.isArray(manifest.failedAssets) && manifest.failedAssets.length > 0) {
    fail("one or more asset downloads failed");
  }
  if (manifest.counts.failedAssets !== undefined && manifest.counts.failedAssets !== 0) {
    fail("manifest records failed assets");
  }
  if (
    !validCount(manifest.counts.pages) ||
    !validCount(manifest.counts.databases) ||
    !validCount(manifest.counts.assets)
  ) {
    fail("invalid manifest counts");
  }
  if (
    manifest.entries.filter((e) => e.kind === "page").length !== manifest.counts.pages ||
    manifest.entries.filter((e) => e.kind === "database").length !== manifest.counts.databases ||
    manifest.assets.length !== manifest.counts.assets
  ) {
    fail("manifest counts disagree with its inventory");
  }
  if (expected) validateExpectedInventory(manifest, expected);
  if (manifest.requiredSources !== undefined) {
    assertRequiredSources(
      manifest.requiredSources,
      manifest.entries.map((e) => ({ id: e.id, object: e.kind })),
    );
  }

  const assetPaths = new Map<string, { sha256: string; bytes: number }>();
  for (const asset of manifest.assets) {
    const localPath = validateLocalAssetPath(asset.localPath);
    const previous = assetPaths.get(localPath);
    if (previous && (previous.sha256 !== asset.sha256 || previous.bytes !== asset.bytes)) {
      fail(`conflicting asset records: ${localPath}`);
    }
    assetPaths.set(localPath, asset);
  }
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      (entry.kind !== "page" && entry.kind !== "database") ||
      ids.has(entry.id)
    ) {
      fail("invalid or duplicate manifest source ID");
    }
    ids.add(entry.id);
    const prefix = entry.kind === "page" ? "raw/pages/" : "raw/databases/";
    if (
      typeof entry.rawPath !== "string" ||
      !entry.rawPath.replaceAll("\\", "/").startsWith(prefix) ||
      !SHA_RE.test(entry.sha256) ||
      !validCount(entry.bytes)
    ) {
      fail(`invalid raw file metadata for ${entry.id}`);
    }
    const actual = await digestFile(root, entry.rawPath);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      fail(`raw JSON checksum mismatch for ${entry.id}`);
    }
    const rawText = await readFileWithinRootAsync(root, entry.rawPath);
    if (crypto.createHash("sha256").update(rawText).digest("hex") !== actual.sha256) {
      fail(`raw JSON changed while checking references for ${entry.id}`);
    }
    const raw = JSON.parse(rawText);
    for (const attachment of attachmentRequirements(raw)) {
      if (!attachment.target.local_path)
        fail(`required attachment has no local path for ${entry.id}`);
    }
    for (const localPath of collectLocalAssetPaths(raw)) {
      if (!assetPaths.has(localPath)) {
        fail(`required asset missing from manifest for ${entry.id}: ${localPath}`);
      }
    }
  }
  for (const asset of manifest.assets) {
    if (
      typeof asset.localPath !== "string" ||
      !asset.localPath.replaceAll("\\", "/").startsWith("assets/") ||
      !SHA_RE.test(asset.sha256) ||
      !validCount(asset.bytes)
    ) {
      fail("invalid asset metadata");
    }
    const actual = await digestFile(root, asset.localPath);
    if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) {
      fail(`asset checksum mismatch: ${asset.localPath}`);
    }
  }
  return manifest;
}

/**
 * A changing Notion permission boundary can make a crawl internally complete
 * but smaller than the last good archive. Require deliberate reconciliation
 * before trusting such a snapshot. Legitimate deletions should be accepted
 * through an explicit future operator workflow, never inferred from absence.
 */
export function assertNoSourceLoss(expected: readonly ExpectedSource[], previous?: Manifest): void {
  if (!previous) return;
  const current = new Set(expected.map((item) => item.id));
  const missing = previous.entries.filter((entry) => !current.has(entry.id));
  if (missing.length > 0) {
    fail(
      `previous verified inventory lost ${missing.length} source IDs (first: ${missing[0]?.id}); investigate access or deletions before pruning`,
    );
  }
}

/**
 * Explicitly seal an export only after every source file is verified and
 * the live crawl inventory and export success counts agree. A failed attempt
 * leaves its output on disk for diagnosis but cannot become a retention target.
 */
export async function markSnapshotVerified(
  root: string,
  expected: readonly ExpectedSource[],
  exportErrors: number,
  previous?: Manifest,
): Promise<void> {
  if (exportErrors !== 0) fail(`export reported ${exportErrors} object errors`);
  assertNoSourceLoss(expected, previous);
  const manifest = await verifySnapshot(root, expected);
  const { sha256 } = await digestFile(root, "manifest.json");
  const sealedManifest = await fsp.readFile(path.join(root, "manifest.json"), "utf8");
  if (crypto.createHash("sha256").update(sealedManifest).digest("hex") !== sha256) {
    fail("manifest changed while sealing");
  }
  const marker: VerificationMarker = {
    version: 1,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    manifestSha256: sha256,
    entryCount: manifest.entries.length,
    assetCount: manifest.assets.length,
    sealedManifest,
  };
  const temp = path.join(root, `.verification-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(marker, null, 2), { flag: "wx" });
    await fsp.rename(temp, path.join(root, VERIFICATION_FILE));
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

/** Historical coverage is separate from eligibility for reuse or pruning. */
export async function findPreviousSourceInventory(
  outDir: string,
  excludeStamp?: string,
): Promise<Manifest | undefined> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const stamps = entries
    .filter((e) => e.isDirectory() && STAMP_RE.test(e.name) && e.name !== excludeStamp)
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const stamp of stamps) {
    const root = path.join(outDir, stamp);
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(root, VERIFICATION_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const marker = JSON.parse(raw) as Partial<VerificationMarker>;
    if (
      marker.version !== 1 ||
      marker.status !== "verified" ||
      !SHA_RE.test(marker.manifestSha256 ?? "")
    ) {
      fail(`invalid historical verification marker: ${stamp}`);
    }
    if (marker.sealedManifest === undefined) {
      // Older markers have no independent history. Never silently discard one.
      if (!(await isVerifiedSnapshot(root)))
        fail(`cannot recover historical source inventory: ${stamp}`);
      const manifest = await readManifest(path.join(root, "manifest.json"));
      if (!manifest) fail(`missing historical manifest: ${stamp}`);
      return manifest;
    }
    if (
      typeof marker.sealedManifest !== "string" ||
      crypto.createHash("sha256").update(marker.sealedManifest).digest("hex") !==
        marker.manifestSha256
    ) {
      fail(`historical manifest checksum mismatch: ${stamp}`);
    }
    const manifest = JSON.parse(marker.sealedManifest) as Manifest;
    if (
      manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length === 0 ||
      manifest.entries.length !== marker.entryCount
    ) {
      fail(`invalid historical source inventory: ${stamp}`);
    }
    validateExpectedInventory(
      manifest,
      manifest.entries.map((e) => ({ id: e.id, object: e.kind })),
    );
    return manifest;
  }
  return undefined;
}

/** A maintenance command may renew only a snapshot verified before it started. */
export async function verifiedMaintenanceInventory(root: string): Promise<Manifest | undefined> {
  try {
    await fsp.lstat(path.join(root, VERIFICATION_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (!(await isVerifiedSnapshot(root))) fail("refusing maintenance of an invalid sealed snapshot");
  return verifySnapshot(root);
}

/** Invalid, unverified and legacy exports are never safe to prune or reuse. */
export async function isVerifiedSnapshot(root: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(path.join(root, VERIFICATION_FILE), "utf8");
    const marker = JSON.parse(raw) as Partial<VerificationMarker>;
    if (
      marker.version !== 1 ||
      marker.status !== "verified" ||
      !SHA_RE.test(marker.manifestSha256 ?? "")
    ) {
      return false;
    }
    const { sha256 } = await digestFile(root, "manifest.json");
    if (sha256 !== marker.manifestSha256) return false;
    const manifest = await verifySnapshot(root);
    return (
      manifest.entries.length === marker.entryCount && manifest.assets.length === marker.assetCount
    );
  } catch {
    return false;
  }
}

/**
 * Select only a verified previous export for incremental reuse; a readable
 * manifest is not evidence that the previous export finished successfully.
 */
export async function findVerifiedPreviousExport(
  outDir: string,
  excludeStamp?: string,
): Promise<{ root: string; manifest: Manifest } | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const stamps = entries
    .filter(
      (entry) => entry.isDirectory() && STAMP_RE.test(entry.name) && entry.name !== excludeStamp,
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stamp of stamps) {
    const root = path.join(outDir, stamp);
    if (!(await isVerifiedSnapshot(root))) continue;
    const manifest = await readManifest(path.join(root, "manifest.json"));
    if (manifest) return { root, manifest };
  }
  return null;
}
