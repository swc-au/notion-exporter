import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function acquireWriterLock(outDir: string) {
  const lockPath = path.join(outDir, ".export.lock");
  const handle = await fsp.open(lockPath, "wx");
  const owner = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  return {
    write: (details: Record<string, unknown>) =>
      handle.writeFile(JSON.stringify({ version: 2, ...owner, ...details })),
    async release() {
      await handle.close();
      await fsp.unlink(lockPath);
    },
  };
}
