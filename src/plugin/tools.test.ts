import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import { flattenPipeline } from "../engine/flattener.js";
import type { FlattenedPipeline } from "../engine/index.js";
import type { PipelineRegistry } from "../engine/loader.js";
import type { PipelineInstance } from "../schema/index.js";
import type { PluginState } from "./state.js";
import {
  createLatticeAbortTool,
  createLatticeRetryTool,
  createLatticeRunTool,
  createLatticeSignalTool,
  createLatticeStatusTool,
} from "./tools.js";

let projectDir: string;

function registryOf(...defs: ReturnType<typeof pipeline>[]): PipelineRegistry {
  const registry: PipelineRegistry = new Map();
  for (const def of defs) {
    registry.set(def.name, def);
  }
  return registry;
}

function makeState(registry: PipelineRegistry, activeInstance?: PipelineInstance): PluginState {
  return {
    registry,
    flattenedCache: new Map(),
    activeInstance,
    parentSessionId: undefined,
    engineConfig: {
      projectDir,
      latticeConfig: {},
    },
  };
}

function getFlattened(registry: PipelineRegistry) {
  return (name: string): FlattenedPipeline => {
    const definition = registry.get(name);
    if (!definition) throw new Error(`Pipeline "${name}" not found`);
    return flattenPipeline(definition, registry);
  };
}

function deps(state: PluginState) {
  return {
    state,
    getFlattened: getFlattened(state.registry),
    selectSkillsForStage: vi.fn(async () => {}),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function runningInstance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "run-1",
    pipelineName: "implement",
    goal: "ship feature",
    status: "running",
    currentStageIndex: 0,
    stages: [{ id: "plan", agent: "planner", status: "running" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-tools-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("createLatticeRunTool", () => {
  it("starts a known pipeline and persists the active instance", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry);

    const result = await createLatticeRunTool(deps(state)).execute({ pipeline: "review", goal: "Review PR #12" }, {
      sessionID: "session-1",
    } as never);

    expect(result).toContain('Pipeline "review" started.');
    expect(state.parentSessionId).toBe("session-1");
    expect(state.activeInstance?.pipelineName).toBe("review");

    const persisted = await readFile(
      join(projectDir, ".lattice", "state", `${state.activeInstance?.id}.json`),
      "utf-8",
    );
    expect(JSON.parse(persisted)).toMatchObject({
      pipelineName: "review",
      goal: "Review PR #12",
      status: "running",
    });
  });

  it("rejects concurrent active pipelines", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance({ pipelineName: "review", status: "paused" }));

    const result = await createLatticeRunTool(deps(state)).execute({ pipeline: "review", goal: "Review PR #13" }, {
      sessionID: "session-1",
    } as never);

    expect(result).toBe('Pipeline "review" is paused. Use lattice_abort first.');
  });
});

describe("createLatticeStatusTool", () => {
  it("formats stage markers for multiple statuses", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        goal: "Review PR #14",
        stages: [
          { id: "plan", agent: "planner", status: "completed", summary: "done" },
          { id: "implement", agent: "implementor", status: "running" },
          { id: "refactor", agent: "refactorer", status: "skipped" },
          { id: "review", agent: "code-reviewer", status: "rejected", summary: "needs work" },
        ],
      }),
    );

    const result = await createLatticeStatusTool(deps(state)).execute({}, undefined as never);

    expect(result).toContain("Pipeline: review (running)");
    expect(result).toContain("✓ plan (planner): completed — done");
    expect(result).toContain("→ implement (implementor): running");
    expect(result).toContain("- refactor (refactorer): skipped");
    expect(result).toContain("✗ review (code-reviewer): rejected — needs work");
  });
});

describe("createLatticeAbortTool", () => {
  it("marks the running stage failed and cleans signals", async () => {
    const definition = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "plan_created" })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance());
    const signalsDir = join(projectDir, ".lattice", "signals");
    await mkdir(signalsDir, { recursive: true });
    await writeFile(join(signalsDir, "plan.json"), JSON.stringify({ status: "complete" }));

    const result = await createLatticeAbortTool(deps(state)).execute({}, undefined as never);

    expect(result).toBe('Pipeline "implement" aborted.');
    expect(state.activeInstance).toBeUndefined();

    const persisted = await readFile(join(projectDir, ".lattice", "state", "run-1.json"), "utf-8");
    expect(JSON.parse(persisted)).toMatchObject({
      status: "failed",
      stages: [{ id: "plan", status: "failed", summary: "Aborted by user" }],
    });

    await expect(access(join(signalsDir, "plan.json"))).rejects.toThrow();
  });
});

describe("createLatticeRetryTool", () => {
  it("rewinds to the nearest implementor stage", async () => {
    const definition = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "plan_created" })],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        currentStageIndex: 2,
        stages: [
          { id: "plan", agent: "planner", status: "completed", summary: "done" },
          {
            id: "implement",
            agent: "implementor",
            status: "completed",
            sessionId: "child-1",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            summary: "done",
          },
          {
            id: "review",
            agent: "code-reviewer",
            status: "rejected",
            summary: "needs fixes",
            verdict: "reject",
          },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({}, undefined as never);

    expect(result).toBe('Retrying from stage "implement". The stage will begin automatically.');
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.currentStageIndex).toBe(1);
    expect(state.activeInstance?.stages[1]).toMatchObject({
      id: "implement",
      status: "pending",
      sessionId: undefined,
      summary: undefined,
      verdict: undefined,
    });
    expect(state.activeInstance?.stages[2]).toMatchObject({
      id: "review",
      status: "pending",
      summary: undefined,
      verdict: undefined,
    });
  });
});

describe("createLatticeSignalTool", () => {
  it("writes a signal file for the current stage", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        stages: [{ id: "code-review", agent: "code-reviewer", status: "running" }],
      }),
    );

    const result = await createLatticeSignalTool(deps(state)).execute(
      { status: "reject", reason: "Found 2 issues" },
      undefined as never,
    );

    expect(result).toBe("Signal recorded: reject — Found 2 issues");

    const signal = await readFile(join(projectDir, ".lattice", "signals", "code-review.json"), "utf-8");
    expect(JSON.parse(signal)).toEqual({ status: "reject", reason: "Found 2 issues" });
  });
});
