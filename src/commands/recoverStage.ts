import fsp from "node:fs/promises";
import path from "node:path";
import { isVerifiedSnapshot } from "../export/verifiedSnapshot.js";
import { inspectRecovery } from "./inspectRecovery.js";

export async function recoverStage(outDir: string, writerStopped: boolean) {
  if (!writerStopped) {
    throw new Error("Confirm the original writer has stopped and you control the output root.");
  }
  const recoveryPath = path.join(outDir, ".recovery.lock");
  const recoveryLock = await fsp.open(recoveryPath, "wx");
  try {
    const attempt = await inspectRecovery(outDir);
    if (
      attempt.state !== "observed-attempt" ||
      !attempt.stage ||
      !attempt.destination ||
      !attempt.reservationMatches ||
      !attempt.stageIdentityMatches ||
      attempt.stageVerification !== "verified"
    ) {
      throw new Error("Recovery requires a verified stage and its original reservation.");
    }
    const destination = path.join(outDir, attempt.destination);
    if ((await fsp.readdir(destination)).length !== 0) {
      throw new Error("Recovery destination must be empty.");
    }
    await fsp.rename(path.join(outDir, attempt.stage), destination);
    if (!(await isVerifiedSnapshot(destination))) {
      throw new Error("Published recovery destination failed verification.");
    }
    await fsp.unlink(path.join(outDir, ".export.lock"));
    return destination;
  } finally {
    await recoveryLock.close();
    await fsp.unlink(recoveryPath);
  }
}
