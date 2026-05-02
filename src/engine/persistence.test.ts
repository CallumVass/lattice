import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PipelineInstance } from "../schema/index.js";
import { findActiveInstance, saveInstance } from "./persistence.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-persist-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function makeInstance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "run-1",
    pipelineName: "implement",
    goal: "implement feature #42",
    status: "running",
    currentStageIndex: 0,
    stages: [{ id: "plan", agent: "planner", status: "pending" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("persistence", () => {
  it("finds active running instance", async () => {
    await saveInstance(projectDir, makeInstance({ id: "completed-1", status: "completed" }));
    await saveInstance(projectDir, makeInstance({ id: "active-1", status: "running" }));

    const active = await findActiveInstance(projectDir);
    expect(active?.id).toBe("active-1");
  });

  it("finds active paused instance", async () => {
    await saveInstance(projectDir, makeInstance({ id: "paused-1", status: "paused" }));

    const active = await findActiveInstance(projectDir);
    expect(active?.id).toBe("paused-1");
  });

  it("returns undefined when no active instances", async () => {
    await saveInstance(projectDir, makeInstance({ id: "done-1", status: "completed" }));

    const active = await findActiveInstance(projectDir);
    expect(active).toBeUndefined();
  });

  it("returns undefined for missing state directory", async () => {
    const active = await findActiveInstance(projectDir);
    expect(active).toBeUndefined();
  });

  it("skips corrupt state files and returns the newest valid active instance", async () => {
    await saveInstance(projectDir, makeInstance({ id: "older", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await saveInstance(projectDir, makeInstance({ id: "newer", updatedAt: "2026-01-02T00:00:00.000Z" }));
    await writeFile(join(projectDir, ".lattice", "state", "broken.json"), "not json");

    const active = await findActiveInstance(projectDir);

    expect(active?.id).toBe("newer");
  });

  it("recovers dispatching stages as stuck pauses", async () => {
    await saveInstance(
      projectDir,
      makeInstance({
        stages: [{ id: "plan", agent: "planner", status: "dispatching", dispatchId: "dispatch-1" }],
      }),
    );

    const active = await findActiveInstance(projectDir);

    expect(active?.status).toBe("paused");
    expect(active?.pause).toMatchObject({ kind: "stuck", stageId: "plan" });
    expect(active?.stages[0]?.status).toBe("pending");
  });

  it("adds .lattice to .gitignore on first write", async () => {
    await saveInstance(projectDir, makeInstance());

    await expect(readFile(join(projectDir, ".gitignore"), "utf-8")).resolves.toContain(".lattice/");
  });
});
