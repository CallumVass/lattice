import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import type { LatticeConfig } from "../schema/index.js";
import type { EngineConfig } from "./engine.js";
import {
  advancePipeline,
  buildStageAction,
  checkStageCompletion,
  effectivePipeline,
  expandCurrentStageIfNeeded,
  markStageRunning,
  startPipeline,
} from "./engine.js";
import { flattenPipeline } from "./flattener.js";
import type { PipelineRegistry } from "./loader.js";

let projectDir: string;

function engineConfig(config: LatticeConfig = {}): EngineConfig {
  return { projectDir, latticeConfig: config };
}

function registryOf(...defs: ReturnType<typeof pipeline>[]): PipelineRegistry {
  const reg: PipelineRegistry = new Map();
  for (const d of defs) reg.set(d.name, d);
  return reg;
}

async function writeSignal(stageId: string, status: string, reason?: string) {
  const dir = join(projectDir, ".lattice", "signals");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${stageId}.json`), JSON.stringify({ status, reason }));
}

async function startAndRun(flat: ReturnType<typeof flattenPipeline>, goal: string, config: EngineConfig) {
  const { instance } = await startPipeline(flat, goal, config);
  const action = buildStageAction(instance, flat);
  expect(action).toBeDefined();
  await markStageRunning(instance, config);
  if (!action) throw new Error("Expected action");
  return { instance, action };
}

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
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startPipeline(flat, "Review PR #5", engineConfig());

    expect(instance.status).toBe("running");
    expect(instance.stages[0]?.status).toBe("pending");
  });

  it("builds subtask action for isolated context", () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
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

  it("builds inject action for shared context", () => {
    const p = pipeline("impl", {
      stages: [stage("impl", { agent: "implementor", completion: "signal", signals: ["complete"], context: "shared" })],
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
        stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] }),
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
});

describe("dynamic stage expansion", () => {
  it("expands a manifest into runtime stages when current placeholder is pending", async () => {
    await writeFile(
      join(projectDir, "manifest.json"),
      JSON.stringify({ slices: [{ index: 1, id: "Auth Setup", title: "Auth setup", file: "slices/01-auth.md" }] }),
    );
    const p = pipeline("dynamic", {
      stages: [
        {
          id: "build-slices",
          type: "stage",
          agent: "build",
          completion: "signal",
          signals: ["complete"],
          context: "isolated",
          pauseAfter: false,
          isRewindTarget: false,
          expand: {
            from: "manifest.json",
            arrayPath: "slices",
            maxItems: 4,
            template: {
              id: "build-slice-{{index}}-{{id}}",
              type: "stage",
              agent: "build",
              completion: "signal",
              signals: ["complete"],
              context: "isolated",
              prompt: "Read {{file}} for {{title}}",
            },
          },
        },
        stage("final", { agent: "build", completion: "signal", signals: ["complete"] }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));
    const { instance } = await startPipeline(flat, "ship", engineConfig());

    const expanded = await expandCurrentStageIfNeeded(instance, flat, engineConfig());

    expect(instance.stages.map((s) => s.id)).toEqual(["build-slice-1-auth-setup", "final"]);
    expect(instance.runtimeStages?.map((s) => s.id)).toEqual(["build-slice-1-auth-setup", "final"]);
    expect(expanded.stages[0]?.prompt).toBe("Read slices/01-auth.md for Auth setup");
    expect(buildStageAction(instance, effectivePipeline(instance, flat))?.stageId).toBe("build-slice-1-auth-setup");
  });

  it("refuses manifests that exceed maxItems", async () => {
    await writeFile(join(projectDir, "manifest.json"), JSON.stringify({ slices: [{ id: "a" }, { id: "b" }] }));
    const p = pipeline("dynamic", {
      stages: [
        {
          id: "build-slices",
          type: "stage",
          agent: "build",
          completion: "signal",
          signals: ["complete"],
          context: "isolated",
          pauseAfter: false,
          isRewindTarget: false,
          expand: {
            from: "manifest.json",
            arrayPath: "slices",
            maxItems: 1,
            template: {
              id: "build-{{id}}",
              type: "stage",
              agent: "build",
              completion: "signal",
              signals: ["complete"],
              context: "isolated",
            },
          },
        },
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));
    const { instance } = await startPipeline(flat, "ship", engineConfig());

    await expect(expandCurrentStageIfNeeded(instance, flat, engineConfig())).rejects.toThrow("exceeding maxItems");
  });
});

describe("checkStageCompletion", () => {
  it("returns incomplete when no signal", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    const result = await checkStageCompletion(instance, flat, engineConfig());

    expect(result.complete).toBe(false);
  });

  it("returns complete when signal file exists", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["pass"] })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "pass", "LGTM");
    const result = await checkStageCompletion(instance, flat, engineConfig());

    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("pass");
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
        stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] }),
        stage("review-judge", {
          agent: "review-judge",
          completion: "signal",
          signals: ["complete"],
          context: "shared",
        }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review PR", engineConfig());
    await writeSignal("code-review", "complete");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.stages[0]?.status).toBe("completed");
    expect(result.instance.stages[1]?.status).toBe("pending");
  });

  it("pauses on fail with explicit pause state", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["pass", "fail"] })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "fail", "Found 2 issues");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("paused");
    expect(result.instance.stages[0]?.verdict).toBe("fail");
    expect(result.pause).toMatchObject({ kind: "rejection", stageId: "code-review" });
    expect(result.instance.pause?.reason).toContain("Found 2 issues");
  });

  it("pauses on blocked", async () => {
    const p = pipeline("impl", {
      stages: [stage("build", { agent: "implementor", completion: "signal", signals: ["complete", "blocked"] })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "build", engineConfig());
    await writeSignal("build", "blocked", "Missing dependency");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("paused");
    expect(result.instance.stages[0]?.verdict).toBe("blocked");
    expect(result.pause).toMatchObject({ kind: "blocked", stageId: "build" });
  });

  it("pauses at a checkpoint and records pause metadata", async () => {
    const p = pipeline("impl", {
      stages: [
        stage("plan", { agent: "planner", completion: "signal", signals: ["complete"], pauseAfter: true }),
        stage("build", { agent: "implementor", completion: "signal", signals: ["complete"] }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "build", engineConfig());
    await writeSignal("plan", "complete");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("paused");
    expect(result.instance.stages[0]?.status).toBe("completed");
    expect(result.instance.currentStageIndex).toBe(1);
    expect(result.pause).toMatchObject({ kind: "checkpoint", stageId: "plan", nextStageId: "build" });
  });

  it("renders custom checkpoint prompt substitutions", async () => {
    const p = pipeline("impl", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "signal",
          signals: ["complete"],
          pauseAfter: { prompt: "Review `.lattice/plans/impl.md`.\n\nAgent said: {{summary}}" },
        }),
        stage("build", { agent: "implementor", completion: "signal", signals: ["complete"] }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "build feature", engineConfig());
    await writeSignal("plan", "complete", "Plan with 4 tasks written");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.pause?.prompt).toContain("Review `.lattice/plans/impl.md`.");
    expect(result.pause?.prompt).toContain("Agent said: Plan with 4 tasks written");
  });

  it("completes pipeline after last stage", async () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["pass", "fail"] })],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "pass");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.instance.status).toBe("completed");
  });
});

describe("signal set validation", () => {
  it("emits a diagnostic when the signal is outside the declared set", async () => {
    const p = pipeline("review", {
      stages: [
        stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] }),
        stage("next", { agent: "next-agent", completion: "idle", context: "shared" }),
      ],
    });
    const flat = flattenPipeline(p, registryOf(p));

    const { instance } = await startAndRun(flat, "Review", engineConfig());
    await writeSignal("code-review", "pass", "LGTM");
    const result = await checkAndAdvance(instance, flat, engineConfig());

    expect(result.diagnostics?.[0]).toContain('signalled "pass"');
    expect(result.diagnostics?.[0]).toContain("declared signals are: complete");
    expect(result.instance.stages[0]?.verdict).toBe("pass");
  });
});
