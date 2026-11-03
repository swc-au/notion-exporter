import { findPreviousSourceBaseline, verifySnapshot } from "../export/verifiedSnapshot.js";

export async function inspectSourceLoss(outDir: string, candidateRoot: string) {
  const baseline = await findPreviousSourceBaseline(outDir);
  if (!baseline) throw new Error("No sealed historical source inventory found.");
  const candidate = await verifySnapshot(candidateRoot);
  const current = new Map(candidate.entries.map(({ id, kind }) => [id, kind]));
  const missing: { id: string; kind: string }[] = [];
  const kindChanges: { id: string; previous: string; current: string }[] = [];
  for (const { id, kind } of baseline.manifest.entries) {
    const currentKind = current.get(id);
    if (!currentKind) missing.push({ id, kind });
    else if (currentKind !== kind) kindChanges.push({ id, previous: kind, current: currentKind });
  }
  return {
    baselineSha256: baseline.sha256,
    baselineTimestamp: baseline.manifest.timestamp,
    candidateTimestamp: candidate.timestamp,
    baselineCount: baseline.manifest.entries.length,
    candidateCount: candidate.entries.length,
    requiredSources: candidate.requiredSources ?? [],
    missing,
    kindChanges,
  };
}
