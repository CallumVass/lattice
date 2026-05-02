import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function cleanSignals(projectDir: string, instanceId?: string): Promise<void> {
  const root = join(projectDir, ".lattice", "signals");
  if (!instanceId) {
    await rm(root, { recursive: true, force: true });
    return;
  }

  await rm(join(root, instanceId), { recursive: true, force: true });
  try {
    const files = await readdir(root);
    await Promise.all(
      files.filter((file) => file.endsWith(".json")).map((file) => rm(join(root, file), { force: true })),
    );
  } catch {
    // Signals directory does not exist.
  }
}

export async function cleanBlockedFile(projectDir: string): Promise<void> {
  await rm(join(projectDir, "BLOCKED.md"), { force: true });
}
