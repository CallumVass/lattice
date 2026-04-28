import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import { type FlattenedPipeline, flattenPipeline, type PipelineRegistry } from "../engine/index.js";
import type { PipelineInstance } from "../schema/index.js";
import type { PluginState } from "./state.js";
import { createLatticeControlTool, createLatticeSignalTool } from "./tools.js";

let projectDir: string;

function registryOf(...defs: ReturnType<typeof pipeline>[]): PipelineRegistry {
  const registry: PipelineRegistry = new Map();
  for (const def of defs) registry.set(def.name, def);
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
  return async (name: string): Promise<FlattenedPipeline> => {
    const definition = registry.get(name);
    if (!definition) throw new Error(`Pipeline "${name}" not found`);
    return flattenPipeline(definition, registry);
  };
}

function deps(state: PluginState, overrides: Partial<ReturnType<typeof depsBase>> = {}) {
  return { ...depsBase(state), ...overrides };
}

function depsBase(state: PluginState) {
  return {
    state,
    getFlattened: getFlattened(state.registry),
    selectSkillsForStage: vi.fn(async () => {}),
    scheduleCurrentStage: vi.fn(async () => {}),
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

function toolContext(overrides: Record<string, unknown> = {}) {
  return { sessionID: "session-1", agent: "planner", ...overrides } as never;
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-tools-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("createLatticeControlTool", () => {
  it("starts a known pipeline and persists the active instance", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry);

    const result = await createLatticeControlTool(deps(state)).execute(
      { action: "run", pipeline: "review", goal: "Review PR #12" },
      toolContext(),
    );

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
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance({ pipelineName: "review", status: "paused" }));

    const result = await createLatticeControlTool(deps(state)).execute(
      { action: "run", pipeline: "review", goal: "Review PR #13" },
      toolContext(),
    );

    expect(result).toBe('Pipeline "review" is paused. Use `/lattice status` or `/lattice abort` first.');
  });

  it("reports unknown pipeline names", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(registry);

    const result = await createLatticeControlTool(deps(state)).execute(
      { action: "run", pipeline: "ghost", goal: "Review PR #13" },
      toolContext(),
    );

    expect(result).toContain('Unknown pipeline "ghost"');
    expect(result).toContain("Available: review");
  });

  it("formats status output with pause metadata", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        goal: "Review PR #14",
        status: "paused",
        pause: { kind: "rejection", stageId: "review", reason: "needs work" },
        stages: [
          { id: "plan", agent: "planner", status: "completed", summary: "done" },
          { id: "implement", agent: "implementor", status: "running" },
          { id: "refactor", agent: "refactorer", status: "skipped" },
          { id: "review", agent: "code-reviewer", status: "rejected", summary: "needs work" },
        ],
      }),
    );

    const result = await createLatticeControlTool(deps(state)).execute({ action: "status" }, toolContext());

    expect(result).toContain("Pipeline: review (paused)");
    expect(result).toContain("Pause: rejection at review - needs work");
    expect(result).toContain("✓ plan (planner): completed - done");
    expect(result).toContain("→ implement (implementor): running");
    expect(result).toContain("- refactor (refactorer): skipped");
    expect(result).toContain("✗ review (code-reviewer): rejected - needs work");
  });

  it("continues a checkpoint pause and stores resume context", async () => {
    const definition = pipeline("review", {
      stages: [stage("propose-comments", { agent: "pr-review-composer", completion: "signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 1,
        pause: { kind: "checkpoint", stageId: "propose-comments", nextStageId: "post-comments" },
        stages: [
          { id: "propose-comments", agent: "pr-review-composer", status: "completed", summary: "ready" },
          { id: "post-comments", agent: "pr-commenter", status: "pending" },
        ],
      }),
    );

    const scheduleCurrentStage = vi.fn(async () => {});
    const ask = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state, { scheduleCurrentStage })).execute(
      { action: "continue", response: "ship it" },
      toolContext({ ask }),
    );

    expect(result).toBe('Continuing pipeline at stage "post-comments".');
    expect(ask).not.toHaveBeenCalled();
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.pause).toBeUndefined();
    expect(state.activeInstance?.resumeContext).toBe("ship it");
    expect(scheduleCurrentStage).toHaveBeenCalledTimes(1);
  });

  it("asks before continuing a checkpoint that requires approval", async () => {
    const definition = pipeline("review", {
      stages: [stage("propose-comments", { agent: "pr-review-composer", completion: "signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 1,
        pause: {
          kind: "checkpoint",
          stageId: "propose-comments",
          nextStageId: "post-comments",
          requiresApproval: true,
        },
        stages: [
          { id: "propose-comments", agent: "pr-review-composer", status: "completed", summary: "ready" },
          { id: "post-comments", agent: "pr-commenter", status: "pending" },
        ],
      }),
    );

    const scheduleCurrentStage = vi.fn(async () => {});
    const ask = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state, { scheduleCurrentStage })).execute(
      { action: "continue", response: "ship it" },
      toolContext({ ask }),
    );

    expect(result).toBe('Continuing pipeline at stage "post-comments".');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: "lattice" }));
    expect(state.activeInstance?.status).toBe("running");
    expect(scheduleCurrentStage).toHaveBeenCalledTimes(1);
  });

  it("rewinds to an explicitly configured retry target", async () => {
    const definition = pipeline("ship-ticket", {
      stages: [
        stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] }),
        stage("implement", { agent: "implementor", completion: "signal", signals: ["complete"] }),
        stage("author", {
          agent: "ticket-author",
          completion: "signal",
          signals: ["complete"],
          isRewindTarget: true,
        }),
        stage("review", { agent: "reviewer", completion: "signal", signals: ["pass", "fail"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "ship-ticket",
        status: "paused",
        currentStageIndex: 3,
        pause: { kind: "rejection", stageId: "review", reason: "fix" },
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "implement", agent: "implementor", status: "completed" },
          { id: "author", agent: "ticket-author", status: "completed" },
          { id: "review", agent: "reviewer", status: "rejected", summary: "fix" },
        ],
      }),
    );

    const scheduleCurrentStage = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state, { scheduleCurrentStage })).execute(
      { action: "retry", response: "try again" },
      toolContext(),
    );

    expect(result).toContain('Retrying from stage "author"');
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.currentStageIndex).toBe(2);
    expect(state.activeInstance?.resumeContext).toBe("try again");
    expect(state.activeInstance?.stages[2]).toMatchObject({ id: "author", status: "pending" });
    expect(state.activeInstance?.stages[3]).toMatchObject({ id: "review", status: "pending" });
    expect(scheduleCurrentStage).toHaveBeenCalledTimes(1);
  });

  it("does not rewind to an upstream implementor without an explicit retry target", async () => {
    const definition = pipeline("ship-ticket", {
      stages: [
        stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] }),
        stage("implement", { agent: "implementor", completion: "signal", signals: ["complete"] }),
        stage("review", { agent: "reviewer", completion: "signal", signals: ["pass", "fail"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "ship-ticket",
        status: "paused",
        currentStageIndex: 2,
        pause: { kind: "rejection", stageId: "review", reason: "fix" },
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "implement", agent: "implementor", status: "completed" },
          { id: "review", agent: "reviewer", status: "rejected", summary: "fix" },
        ],
      }),
    );

    const scheduleCurrentStage = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state, { scheduleCurrentStage })).execute(
      { action: "retry", response: "try again" },
      toolContext(),
    );

    expect(result).toContain('Retrying from stage "review"');
    expect(state.activeInstance?.currentStageIndex).toBe(2);
    expect(state.activeInstance?.stages[1]).toMatchObject({ id: "implement", status: "completed" });
    expect(state.activeInstance?.stages[2]).toMatchObject({ id: "review", status: "pending" });
    expect(scheduleCurrentStage).toHaveBeenCalledTimes(1);
  });

  it("refuses to retry a checkpoint pause", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        pause: { kind: "checkpoint", stageId: "plan" },
        stages: [{ id: "plan", agent: "planner", status: "completed" }],
      }),
    );

    const result = await createLatticeControlTool(deps(state)).execute({ action: "retry" }, toolContext());

    expect(result).toBe("This pause is a checkpoint, not a failure. Use `/lattice continue [message]`.");
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("does not infer retry target from rejected stages without pause metadata", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("review", { agent: "reviewer", completion: "signal", signals: ["pass", "fail"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 0,
        stages: [{ id: "review", agent: "reviewer", status: "rejected", summary: "needs work" }],
      }),
    );

    const scheduleCurrentStage = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state, { scheduleCurrentStage })).execute(
      { action: "retry" },
      toolContext(),
    );

    expect(result).toBe(
      "Pipeline is paused but has no valid pause metadata. Use `/lattice status` or `/lattice abort`.",
    );
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.stages[0]?.status).toBe("rejected");
    expect(scheduleCurrentStage).not.toHaveBeenCalled();
  });

  it("refuses to rewind past maxRewinds and leaves the pipeline paused", async () => {
    const definition = pipeline("bounded", {
      stages: [
        stage("author", {
          agent: "ticket-author",
          completion: "signal",
          signals: ["complete"],
          isRewindTarget: true,
          maxRewinds: 2,
        }),
        stage("judge", { agent: "judge", completion: "signal", signals: ["pass", "fail"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "bounded",
        status: "paused",
        currentStageIndex: 1,
        pause: { kind: "rejection", stageId: "judge", reason: "still wrong" },
        stages: [
          { id: "author", agent: "ticket-author", status: "completed", rewindsUsed: 2 },
          { id: "judge", agent: "judge", status: "rejected", summary: "still wrong" },
        ],
      }),
    );

    const result = await createLatticeControlTool(deps(state)).execute({ action: "retry" }, toolContext());

    expect(result).toContain("exhausted its rewind cap");
    expect(result).toContain("/lattice accept");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.stages[0]?.rewindsUsed).toBe(2);
  });

  it("accepts a failed stage and advances", async () => {
    const definition = pipeline("review", {
      stages: [
        stage("review", { agent: "reviewer", completion: "signal", signals: ["pass", "fail"] }),
        stage("follow-up", { agent: "implementor", completion: "signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 0,
        pause: { kind: "rejection", stageId: "review", reason: "known issue" },
        stages: [
          { id: "review", agent: "reviewer", status: "rejected", summary: "known issue" },
          { id: "follow-up", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const scheduleCurrentStage = vi.fn(async () => {});
    const ask = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state, { scheduleCurrentStage })).execute(
      { action: "accept", reason: "intentional" },
      toolContext({ ask }),
    );

    expect(result).toBe('Accepted stage "review". Advancing to "follow-up".');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: "lattice" }));
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.currentStageIndex).toBe(1);
    expect(state.activeInstance?.pause).toBeUndefined();
    expect(state.activeInstance?.resumeContext).toBe("intentional");
    expect(state.activeInstance?.stages[0]).toMatchObject({ status: "completed", verdict: "pass" });
    expect(scheduleCurrentStage).toHaveBeenCalledTimes(1);
  });

  it("does not infer accept target from rejected stages without pause metadata", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("review", { agent: "reviewer", completion: "signal", signals: ["pass", "fail"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 0,
        stages: [{ id: "review", agent: "reviewer", status: "rejected", summary: "needs work" }],
      }),
    );

    const result = await createLatticeControlTool(deps(state)).execute(
      { action: "accept", reason: "known" },
      toolContext(),
    );

    expect(result).toBe(
      "Pipeline is paused but has no valid pause metadata. Use `/lattice status` or `/lattice abort`.",
    );
    expect(state.activeInstance?.stages[0]?.status).toBe("rejected");
    expect(state.activeInstance?.stages[0]?.verdict).toBeUndefined();
  });

  it("refuses to accept a stuck-stage recovery pause", async () => {
    const registry = registryOf(
      pipeline("implement", {
        stages: [stage("apply", { agent: "implementor", completion: "signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        pause: { kind: "stuck", stageId: "apply" },
        stages: [{ id: "apply", agent: "implementor", status: "pending" }],
      }),
    );

    const result = await createLatticeControlTool(deps(state)).execute(
      { action: "accept", reason: "skip" },
      toolContext(),
    );

    expect(result).toBe(
      "This pause is a stuck-stage recovery. Use `/lattice retry` to restart it or `/lattice abort` to cancel.",
    );
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("aborts an active pipeline and cleans signals", async () => {
    const definition = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance());
    const signalsDir = join(projectDir, ".lattice", "signals");
    await mkdir(signalsDir, { recursive: true });
    await writeFile(join(signalsDir, "plan.json"), JSON.stringify({ status: "complete" }));

    const ask = vi.fn(async () => {});
    const result = await createLatticeControlTool(deps(state)).execute({ action: "abort" }, toolContext({ ask }));

    expect(result).toBe('Pipeline "implement" aborted.');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: "lattice" }));
    expect(state.activeInstance).toBeUndefined();

    const persisted = await readFile(join(projectDir, ".lattice", "state", "run-1.json"), "utf-8");
    expect(JSON.parse(persisted)).toMatchObject({
      status: "failed",
      stages: [{ id: "plan", status: "failed", summary: "Aborted by user" }],
    });
    await expect(access(join(signalsDir, "plan.json"))).rejects.toThrow();
  });

  it("moves a stuck running stage back to pending and pauses the pipeline", async () => {
    const registry = registryOf(
      pipeline("implement", {
        stages: [
          stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] }),
          stage("apply", { agent: "implementor", completion: "signal", signals: ["complete"] }),
        ],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        status: "running",
        currentStageIndex: 1,
        stages: [
          { id: "plan", agent: "planner", status: "completed", summary: "done" },
          {
            id: "apply",
            agent: "implementor",
            status: "running",
            sessionId: "child-1",
            startedAt: new Date().toISOString(),
            summary: "partial",
            verdict: "pass",
          },
        ],
      }),
    );
    const signalsDir = join(projectDir, ".lattice", "signals");
    await mkdir(signalsDir, { recursive: true });
    await writeFile(join(signalsDir, "apply.json"), JSON.stringify({ status: "complete" }));

    const result = await createLatticeControlTool(deps(state)).execute({ action: "reset" }, toolContext());

    expect(result).toContain("reset");
    expect(result).toContain("apply");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.pause).toMatchObject({ kind: "stuck", stageId: "apply" });
    expect(state.activeInstance?.stages[0]).toMatchObject({ id: "plan", status: "completed", summary: "done" });
    expect(state.activeInstance?.stages[1]).toMatchObject({
      id: "apply",
      status: "pending",
      sessionId: undefined,
      startedAt: undefined,
      summary: undefined,
      verdict: undefined,
    });
    await expect(access(join(signalsDir, "apply.json"))).rejects.toThrow();
  });
});

describe("createLatticeSignalTool", () => {
  it("writes a signal file for the current stage", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete", "fail"] })],
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
      { status: "fail", reason: "Found 2 issues" },
      toolContext({ agent: "code-reviewer" }),
    );

    expect(result).toBe("Signal recorded: fail - Found 2 issues");

    const signal = await readFile(join(projectDir, ".lattice", "signals", "code-review.json"), "utf-8");
    expect(JSON.parse(signal)).toEqual({ status: "fail", reason: "Found 2 issues" });
  });

  it("refuses signals from the wrong agent", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
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
      { status: "complete", reason: "done" },
      toolContext({ agent: "planner" }),
    );

    expect(result).toContain('uses agent "code-reviewer", not "planner"');
  });

  it("refuses undeclared signal statuses", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
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
      { status: "fail", reason: "needs work" },
      toolContext({ agent: "code-reviewer" }),
    );

    expect(result).toContain('status "fail" is not declared');
  });
});
