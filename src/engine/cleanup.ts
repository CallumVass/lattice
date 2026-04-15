import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function cleanSignals(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".lattice", "signals");
  try {
    const files = await readdir(dir);
    await Promise.all(files.map((f) => rm(join(dir, f), { force: true })));
  } catch {
    // directory doesn't exist, nothing to clean
  }
}

export async function cleanBlockedFile(projectDir: string): Promise<void> {
  await rm(join(projectDir, "BLOCKED.md"), { force: true });
}
