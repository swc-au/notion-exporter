import fsp from "node:fs/promises";
import { z } from "zod";
import type { Manifest } from "./manifest.js";
import { parseRequiredSources, type RequiredSource } from "./requiredSources.js";

const schema = z
  .object({
    version: z.literal(1),
    baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
    missing: z.unknown(),
    requiredSources: z.unknown(),
  })
  .strict();

export interface DeletionApproval {
  version: 1;
  baselineSha256: string;
  missing: RequiredSource[];
  requiredSources: RequiredSource[];
}

export async function readDeletionApproval(file: string): Promise<DeletionApproval> {
  const approval = schema.parse(JSON.parse(await fsp.readFile(file, "utf8")));
  return {
    ...approval,
    missing: parseRequiredSources(approval.missing),
    requiredSources:
      Array.isArray(approval.requiredSources) && approval.requiredSources.length === 0
        ? []
        : parseRequiredSources(approval.requiredSources),
  };
}

function sameSources(left: readonly RequiredSource[], right: readonly RequiredSource[]): boolean {
  const byId = new Map(right.map(({ id, object }) => [id, object]));
  return left.length === right.length && left.every(({ id, object }) => byId.get(id) === object);
}

export function reconcileDeletion(
  approval: DeletionApproval,
  baseline: { manifest: Manifest; sha256: string } | undefined,
  current: readonly RequiredSource[],
  required: readonly RequiredSource[],
): Manifest {
  if (!baseline || baseline.sha256 !== approval.baselineSha256)
    throw new Error("Deletion approval does not match the latest sealed baseline.");
  if (!sameSources(approval.requiredSources, required))
    throw new Error("Deletion approval does not match the current required-source policy.");
  const byId = new Map(current.map(({ id, object }) => [id, object]));
  const missing: RequiredSource[] = [];
  for (const { id, kind } of baseline.manifest.entries) {
    const actual = byId.get(id);
    if (actual === undefined) missing.push({ id, object: kind });
    else if (actual !== kind)
      throw new Error("Source kind changed during deletion reconciliation.");
  }
  if (!sameSources(approval.missing, missing))
    throw new Error("Deletion approval does not match the exact missing sources.");
  const retired = new Set(missing.map(({ id }) => id));
  return {
    ...baseline.manifest,
    entries: baseline.manifest.entries.filter(({ id }) => !retired.has(id)),
  };
}
