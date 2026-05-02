import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type PipelineInstance, pipelineInstanceSchema } from "../schema/index.js";

const STATE_DIR = ".lattice/state";

function statePath(projectDir: string, instanceId: string): string {
  return join(projectDir, STATE_DIR, `${instanceId}.json`);
}

export async function saveInstance(projectDir: string, instance: PipelineInstance): Promise<void> {
  const dir = join(projectDir, STATE_DIR);
  await mkdir(dir, { recursive: true });
  await ensureLatticeGitignored(projectDir);
  const target = statePath(projectDir, instance.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(instance, null, 2));
  await rename(temp, target);
}

async function ensureLatticeGitignored(projectDir: string): Promise<void> {
  const path = join(projectDir, ".gitignore");
  let contents = "";
  try {
    contents = await readFile(path, "utf-8");
  } catch {
    await writeFile(path, ".lattice/\n");
    return;
  }

  if (contents.split(/\r?\n/).some((line) => line.trim() === ".lattice" || line.trim() === ".lattice/")) {
    return;
  }

  const prefix = contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`;
  await writeFile(path, `${prefix}.lattice/\n`);
}

async function recoverDispatchingInstance(projectDir: string, instance: PipelineInstance): Promise<PipelineInstance> {
  const stage = instance.stages[instance.currentStageIndex];
  if (!stage || stage.status !== "dispatching") return instance;

  stage.status = "pending";
  stage.summary = undefined;
  const pause = {
    kind: "stuck" as const,
    stageId: stage.id,
    reason: `Stage "${stage.id}" was interrupted while dispatching and can be restarted with /lattice retry.`,
  };
  instance.status = "paused";
  instance.pause = pause;
  instance.updatedAt = new Date().toISOString();
  await saveInstance(projectDir, instance);
  return instance;
}

export async function findActiveInstance(projectDir: string): Promise<PipelineInstance | undefined> {
  const dir = join(projectDir, STATE_DIR);

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }

  const active: PipelineInstance[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, file), "utf-8"));
    } catch {
      continue;
    }

    const instance = pipelineInstanceSchema.safeParse(parsed);
    if (!instance.success) continue;
    if (instance.data.status === "running" || instance.data.status === "paused") {
      active.push(await recoverDispatchingInstance(projectDir, instance.data));
    }
  }

  active.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return active[0];
}
