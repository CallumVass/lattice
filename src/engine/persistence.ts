import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineInstance } from "../schema/index.js";

const STATE_DIR = ".lattice/state";

function statePath(projectDir: string, instanceId: string): string {
  return join(projectDir, STATE_DIR, `${instanceId}.json`);
}

export async function saveInstance(projectDir: string, instance: PipelineInstance): Promise<void> {
  const dir = join(projectDir, STATE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(projectDir, instance.id), JSON.stringify(instance, null, 2));
}

export async function loadInstance(projectDir: string, instanceId: string): Promise<PipelineInstance | undefined> {
  try {
    const raw = await readFile(statePath(projectDir, instanceId), "utf-8");
    return JSON.parse(raw) as PipelineInstance;
  } catch {
    return undefined;
  }
}

export async function findActiveInstance(projectDir: string): Promise<PipelineInstance | undefined> {
  const dir = join(projectDir, STATE_DIR);

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }

  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf-8");
    const instance = JSON.parse(raw) as PipelineInstance;
    if (instance.status === "running" || instance.status === "paused") {
      return instance;
    }
  }

  return undefined;
}
