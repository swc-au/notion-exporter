import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isVerifiedSnapshot } from "../export/verifiedSnapshot.js";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function inspectDirectory(root: string, name: string) {
  const target = path.join(root, name);
  try {
    const info = await fsp.lstat(target, { bigint: true });
    if (!info.isDirectory()) return { state: "unexpected-type" };
    return {
      state: "directory",
      device: info.dev.toString(),
      inode: info.ino.toString(),
    };
  } catch (error) {
    if (missing(error)) return { state: "missing" };
    throw error;
  }
}

async function inspectVerification(outDir: string, name: string) {
  const root = path.join(outDir, name);
  const marker = await fsp.lstat(path.join(root, "verification.json")).catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  return marker?.isFile() && (await isVerifiedSnapshot(root)) ? "verified" : "unverified";
}

export async function inspectRecovery(outDir: string) {
  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    handle = await fsp.open(
      path.join(outDir, ".export.lock"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) return { state: "no-lock" };
    throw error;
  }

  let record: Record<string, unknown>;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) return { state: "unrecognized-lock" };
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > 4096) return { state: "unrecognized-lock" };
    try {
      const parsed: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { state: "unrecognized-lock" };
      record = parsed as Record<string, unknown>;
    } catch {
      return { state: "unrecognized-lock" };
    }
  } finally {
    await handle.close();
  }

  const { stage, destination, reservation } = record;
  if (
    record.version !== 2 ||
    typeof stage !== "string" ||
    !/^\.staging-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(stage) ||
    typeof destination !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(destination) ||
    !reservation ||
    typeof reservation !== "object" ||
    !("device" in reservation) ||
    typeof reservation.device !== "string" ||
    !("inode" in reservation) ||
    typeof reservation.inode !== "string"
  )
    return { state: "unrecognized-lock" };

  const [stageInfo, destinationInfo] = await Promise.all([
    inspectDirectory(outDir, stage),
    inspectDirectory(outDir, destination),
  ]);
  const stageVerification =
    stageInfo.state === "directory" ? await inspectVerification(outDir, stage) : "unavailable";
  const destinationVerification =
    stageInfo.state === "missing" && destinationInfo.state === "directory"
      ? await inspectVerification(outDir, destination)
      : "unavailable";
  return {
    state: "observed-attempt",
    stage,
    destination,
    stageInfo,
    stageVerification,
    destinationInfo,
    destinationVerification,
    reservationMatches:
      destinationInfo.state === "directory" &&
      destinationInfo.device === reservation.device &&
      destinationInfo.inode === reservation.inode,
  };
}
