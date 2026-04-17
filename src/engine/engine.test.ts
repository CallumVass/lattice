import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import type { LatticeConfig } from "../schema/index.js";
import type { EngineConfig } from "./engine.js";
import { advancePipeline, buildStageAction, checkStageCompletion, markStageRunning, startPipeline } from "./engine.js";
import { flattenPipeline } from "./flattener.js";
import type { PipelineRegistry } from "./loader.js";

let projectDir: string;

function engineConfig(config: LatticeConfig = {}): EngineConfig {
  return { projectDir, latticeConfig: config };
}

function registryOf(...defs: ReturnType<typeof pipeline>[]): PipelineRegistry {
  const reg: PipelineRegistry = new Map();
  for (const d of defs) {
    reg.set(d.name, d);
  }
  return reg;
}

async function writeSignal(stageId: string, status: string, reason?: string) {
  const dir = join(projectDir, ".lattice", "signals");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${stageId}.json`), JSON.stringify({ status, reason }));
}

/** Simulate: start pipeline → build action → mark running */
async function startAndRun(flat: ReturnType<typeof flattenPipeline>, goal: string, config: EngineConfig) {
  const { instance } = await startPipeline(flat, goal, config);
  const action = buildStageAction(instance, flat);
  expect(action).toBeDefined();
  await markStageRunning(instance, config);
  if (!action) throw new Error("Expected action");
  return { instance, action };
}

/** Simulate: check completion → advance if complete */
async function checkAndAdvance(
  instance: Parameters<typeof checkStageCompletion>[0],
  flat: Parameters<typeof checkStageCompletion>[1],
  config: Parameters<typeof checkStageCompletion>[2],
) {
  const completion = await checkStageCompletion(instance, flat, config);
  if (!completion.complete) return { instance };
  return advancePipeline(instance, flat, config, completion);
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-engine-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("startPipeline + buildStageAction", () => {
  it("creates instance with first stage pending", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startPipeline(flat, "Review PR #5", engineConfig());

    expect(instance.status).toBe("running");
    expect(instance.stages[0]?.status).toBe("pending");
  });

  it("builds subtask action for fork:false stage", () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));
    const instance = {
      id: "test",
      pipelineName: "review",
      goal: "test",
      status: "running" as const,
      currentStageIndex: 0,
      stages: [{ id: "code-review", agent: "code-reviewer", status: "pending" as const }],
      createdAt: "",
      updatedAt: "",
    };

    const action = buildStageAction(instance, flat);
    expect(action?.type).toBe("subtask");
    expect(action?.agent).toBe("code-reviewer");
  });

  it("builds inject action for fork:true stage", () => {
    const p = pipeline("impl", {
      stages: [stage("impl", { agent: "implementor", completion: "tool_signal", fork: true })],
    });
    const flat = flattenPipeline(p, registryOf(p));
    const instance = {
      id: "test",
      pipelineName: "impl",
      goal: "test",
      status: "running" as const,
      currentStageIndex: 0,
      stages: [{ id: "impl", agent: "implementor", status: "pending" as const }],
      createdAt: "",
      updatedAt: "",
    };

    const action = buildStageAction(instance, flat);
    expect(action?.type).toBe("inject");
  });

  it("skips stages marked in config", async () => {
    const p = pipeline("implement", {
      stages: [
        stage("plan", { agent: "planner", completion: "tool_signal" }),
        stage("refactor", { agent: "refactorer", completion: "idle" }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));
    const config: LatticeConfig = {
      pipelines: { implement: { stages: { refactor: { skip: true } } } },
    };

    const result = await startPipeline(flat, "impl", engineConfig(config));
    expect(result.instance.stages[1]?.status).toBe("skipped");
  });

  it("completes immediately when all stages skipped", async () => {
    const p = pipeline("noop", {
      stages: [stage("only", { agent: "planner", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));
    const config: LatticeConfig = {
      pipelines: { noop: { stages: { only: { skip: true } } } },
    };

    const result = await startPipeline(flat, "noop", engineConfig(config));
    expect(result.instance.status).toBe("completed");
  });
});

describe("checkStageCompletion", () => {
  it("returns incomplete when no signal", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    const result = await checkStageCompletion(instance, flat, engineConfig());

    expect(result.complete).toBe(false);
  });

  it("returns complete when signal file exists", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "approve", "LGTM");
    const result = await checkStageCompletion(instance, flat, engineConfig());

    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("approve");
  });

  it("idle completion always returns complete", async () => {
    const p = pipeline("simple", {
      stages: [stage("refactor", { agent: "refactorer", completion: "idle" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "refactor", engineConfig());
    const result = await checkStageCompletion(instance, flat, engineConfig());

    expect(result.complete).toBe(true);
  });
});

describe("advancePipeline", () => {
  it("advances to next stage", async () => {
    const p = pipeline("review", {
      stages: [
        stage("code-review", { agent: "code-reviewer", completion: "tool_signal" }),
        stage("review-judge", { agent: "review-judge", completion: "tool_signal", fork: true }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review PR", engineConfig());
    await writeSignal("code-review", "approve");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.stages[0]?.status).toBe("completed");
    expect(result.instance.stages[0]?.verdict).toBe("approve");
    expect(result.instance.stages[1]?.status).toBe("pending");
  });

  it("pauses on rejection", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "reject", "Found 2 issues");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("paused");
    expect(result.instance.stages[0]?.verdict).toBe("reject");
    expect(result.pauseReason).toContain("reject");
  });

  it("pauses on blocked", async () => {
    const p = pipeline("impl", {
      stages: [stage("build", { agent: "implementor", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "build", engineConfig());
    await writeSignal("build", "blocked", "Missing dependency");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("paused");
    expect(result.instance.stages[0]?.verdict).toBe("blocked");
  });

  it("pauses at an approval gate and surfaces a gateReason", async () => {
    const p = pipeline("impl", {
      stages: [
        stage("plan", { agent: "planner", completion: "tool_signal", pauseAfter: true }),
        stage("build", { agent: "implementor", completion: "tool_signal" }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "build", engineConfig());
    await writeSignal("plan", "complete");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("paused");
    expect(result.instance.stages[0]?.status).toBe("completed");
    expect(result.instance.currentStageIndex).toBe(1);
    expect(result.gateReason).toContain("approval");
    expect(result.pauseReason).toBeUndefined();
  });

  it("completes pipeline after last stage", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "approve");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("completed");
  });
});
