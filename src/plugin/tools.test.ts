import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import { type FlattenedPipeline, flattenPipeline, type PipelineRegistry } from "../engine/index.js";
import type { PipelineInstance } from "../schema/index.js";
import type { PluginState } from "./state.js";
import {
  createLatticeAbortTool,
  createLatticeApproveTool,
  createLatticeResetTool,
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
  return async (name: string): Promise<FlattenedPipeline> => {
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
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal", signals: ["complete"] })],
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
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance({ pipelineName: "review", status: "paused" }));

    const result = await createLatticeRunTool(deps(state)).execute({ pipeline: "review", goal: "Review PR #13" }, {
      sessionID: "session-1",
    } as never);

    expect(result).toBe('Pipeline "review" is paused. Use lattice_abort first.');
  });

  it("reports unknown pipeline names", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(registry);

    const result = await createLatticeRunTool(deps(state)).execute({ pipeline: "ghost", goal: "" }, {
      sessionID: "session-1",
    } as never);

    expect(result).toContain('Unknown pipeline "ghost"');
    expect(result).toContain("Available: review");
  });
});

describe("createLatticeStatusTool", () => {
  it("reports no active pipeline when idle", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(registry);

    const result = await createLatticeStatusTool(deps(state)).execute({}, undefined as never);

    expect(result).toBe("No active pipeline.");
  });

  it("formats stage markers for multiple statuses", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
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
      stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance());
    const signalsDir = join(projectDir, ".lattice", "signals");
    await mkdir(signalsDir, { recursive: true });
    await writeFile(join(signalsDir, "plan.json"), JSON.stringify({ status: "complete" }));

    const result = await createLatticeAbortTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toBe('Pipeline "implement" aborted.');
    expect(state.activeInstance).toBeUndefined();

    const persisted = await readFile(join(projectDir, ".lattice", "state", "run-1.json"), "utf-8");
    expect(JSON.parse(persisted)).toMatchObject({
      status: "failed",
      stages: [{ id: "plan", status: "failed", summary: "Aborted by user" }],
    });

    await expect(access(join(signalsDir, "plan.json"))).rejects.toThrow();
  });

  it("refuses to abort without confirm: true", async () => {
    const definition = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(registry, runningInstance());

    const result = await createLatticeAbortTool(deps(state)).execute({ confirm: false }, undefined as never);

    expect(result).toContain("requires confirm: true");
    expect(state.activeInstance?.status).toBe("running");
  });
});

describe("createLatticeRetryTool", () => {
  it("rewinds to the nearest implementor stage", async () => {
    const definition = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
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

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

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

  it("resumes a gate pause when no stage is rejected", async () => {
    const definition = pipeline("review", {
      stages: [
        stage("propose-comments", { agent: "pr-review-composer", completion: "tool_signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 1,
        stages: [
          { id: "propose-comments", agent: "pr-review-composer", status: "completed", summary: "ready" },
          { id: "post-comments", agent: "pr-commenter", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute(
      { confirm: true, response: "ship it" },
      undefined as never,
    );

    expect(result).toContain('Resuming pipeline at stage "post-comments".');
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.pendingResponse).toBe("ship it");
  });

  it("refuses to retry without confirm: true", async () => {
    const definition = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        currentStageIndex: 0,
        stages: [{ id: "plan", agent: "planner", status: "rejected", summary: "bad" }],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: false }, undefined as never);

    expect(result).toContain("requires confirm: true");
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("prefers an isRewindTarget stage over the legacy implementor fallback", async () => {
    const definition = pipeline("ship-ticket", {
      stages: [
        stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] }),
        stage("implement", { agent: "implementor", completion: "tool_signal", signals: ["complete"] }),
        stage("author", {
          agent: "ticket-author",
          completion: "tool_signal",
          signals: ["complete"],
          isRewindTarget: true,
        }),
        stage("review", { agent: "reviewer", completion: "tool_signal", signals: ["complete", "reject"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "ship-ticket",
        status: "paused",
        currentStageIndex: 3,
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "implement", agent: "implementor", status: "completed" },
          { id: "author", agent: "ticket-author", status: "completed" },
          { id: "review", agent: "reviewer", status: "rejected", summary: "fix" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain('Retrying from stage "author"');
    expect(state.activeInstance?.currentStageIndex).toBe(2);
  });

  it("refuses to rewind past maxRewinds and leaves the pipeline paused", async () => {
    const definition = pipeline("bounded", {
      stages: [
        stage("author", {
          agent: "ticket-author",
          completion: "tool_signal",
          signals: ["complete"],
          isRewindTarget: true,
          maxRewinds: 2,
        }),
        stage("judge", { agent: "judge", completion: "tool_signal", signals: ["approve", "reject"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "bounded",
        status: "paused",
        currentStageIndex: 1,
        stages: [
          { id: "author", agent: "ticket-author", status: "completed", rewindsUsed: 2 },
          { id: "judge", agent: "judge", status: "rejected", summary: "still wrong" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("exhausted its rewind cap");
    expect(result).toContain("lattice_proceed");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.stages[0]?.rewindsUsed).toBe(2);
  });

  it("increments rewindsUsed on each accepted rewind", async () => {
    const definition = pipeline("counting", {
      stages: [
        stage("author", {
          agent: "ticket-author",
          completion: "tool_signal",
          signals: ["complete"],
          isRewindTarget: true,
          maxRewinds: 5,
        }),
        stage("judge", { agent: "judge", completion: "tool_signal", signals: ["approve", "reject"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "counting",
        status: "paused",
        currentStageIndex: 1,
        stages: [
          { id: "author", agent: "ticket-author", status: "completed", rewindsUsed: 1 },
          { id: "judge", agent: "judge", status: "rejected", summary: "needs work" },
        ],
      }),
    );

    await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(state.activeInstance?.stages[0]?.rewindsUsed).toBe(2);
  });

  it("refuses to resume a hard-gated pause without a user-typed /lattice-retry token", async () => {
    const definition = pipeline("approval", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "tool_signal",
          signals: ["complete"],
          pauseAfter: { hardGate: true },
        }),
        stage("apply", { agent: "implementor", completion: "tool_signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "approval",
        status: "paused",
        currentStageIndex: 1,
        hardGated: true,
        stages: [
          { id: "plan", agent: "planner", status: "completed", summary: "ready" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("hard gate");
    expect(result).toContain("/lattice-retry");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.hardGated).toBe(true);
  });

  it("releases a hard-gated pause when a fresh userRetryToken is present", async () => {
    const definition = pipeline("approval", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "tool_signal",
          signals: ["complete"],
          pauseAfter: { hardGate: true },
        }),
        stage("apply", { agent: "implementor", completion: "tool_signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "approval",
        status: "paused",
        currentStageIndex: 1,
        hardGated: true,
        userRetryToken: { issuedAt: new Date().toISOString(), sessionId: "s1" },
        stages: [
          { id: "plan", agent: "planner", status: "completed", summary: "ready" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain('Resuming pipeline at stage "apply"');
    expect(state.activeInstance?.status).toBe("running");
    // Token and hardGated should be consumed on release.
    expect(state.activeInstance?.userRetryToken).toBeUndefined();
    expect(state.activeInstance?.hardGated).toBeUndefined();
  });

  it("refuses a stale userRetryToken (older than the TTL)", async () => {
    const definition = pipeline("approval", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "tool_signal",
          signals: ["complete"],
          pauseAfter: { hardGate: true },
        }),
        stage("apply", { agent: "implementor", completion: "tool_signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "approval",
        status: "paused",
        currentStageIndex: 1,
        hardGated: true,
        userRetryToken: { issuedAt: stale },
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("hard gate");
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("does not require a token for a soft pause (backward compatibility)", async () => {
    const definition = pipeline("soft-approval", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "tool_signal",
          signals: ["complete"],
          pauseAfter: true,
        }),
        stage("apply", { agent: "implementor", completion: "tool_signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "soft-approval",
        status: "paused",
        currentStageIndex: 1,
        // hardGated intentionally omitted — soft pause
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeRetryTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain('Resuming pipeline at stage "apply"');
    expect(state.activeInstance?.status).toBe("running");
  });
});

describe("createLatticeApproveTool", () => {
  it("releases a soft gate and resumes at the next stage", async () => {
    const definition = pipeline("review", {
      stages: [
        stage("propose-comments", { agent: "pr-review-composer", completion: "tool_signal", signals: ["complete"] }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "review",
        status: "paused",
        currentStageIndex: 1,
        stages: [
          { id: "propose-comments", agent: "pr-review-composer", status: "completed", summary: "ready" },
          { id: "post-comments", agent: "pr-commenter", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeApproveTool(deps(state)).execute(
      { confirm: true, response: "ship it" },
      undefined as never,
    );

    expect(result).toContain('Resuming pipeline at stage "post-comments".');
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.pendingResponse).toBe("ship it");
  });

  it("refuses to approve without confirm: true", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        currentStageIndex: 1,
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeApproveTool(deps(state)).execute({ confirm: false }, undefined as never);

    expect(result).toContain("requires confirm: true");
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("refuses when the pause is a rejection, pointing at lattice_retry / lattice_proceed", async () => {
    const registry = registryOf(
      pipeline("review", {
        stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        currentStageIndex: 0,
        stages: [{ id: "plan", agent: "planner", status: "rejected", summary: "bad" }],
      }),
    );

    const result = await createLatticeApproveTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("rejection, not an approval gate");
    expect(result).toContain("lattice_retry");
    expect(result).toContain("lattice_proceed");
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("refuses a hard gate without a fresh unlock token", async () => {
    const registry = registryOf(
      pipeline("approval", {
        stages: [
          stage("plan", {
            agent: "planner",
            completion: "tool_signal",
            signals: ["complete"],
            pauseAfter: { hardGate: true },
          }),
        ],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "approval",
        status: "paused",
        currentStageIndex: 1,
        hardGated: true,
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeApproveTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("hard gate");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.hardGated).toBe(true);
  });

  it("releases a hard gate when a fresh unlock token is present", async () => {
    const registry = registryOf(
      pipeline("approval", {
        stages: [
          stage("plan", {
            agent: "planner",
            completion: "tool_signal",
            signals: ["complete"],
            pauseAfter: { hardGate: true },
          }),
        ],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        pipelineName: "approval",
        status: "paused",
        currentStageIndex: 1,
        hardGated: true,
        userRetryToken: { issuedAt: new Date().toISOString(), sessionId: "s1" },
        stages: [
          { id: "plan", agent: "planner", status: "completed" },
          { id: "apply", agent: "implementor", status: "pending" },
        ],
      }),
    );

    const result = await createLatticeApproveTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain('Resuming pipeline at stage "apply"');
    expect(state.activeInstance?.status).toBe("running");
    expect(state.activeInstance?.userRetryToken).toBeUndefined();
    expect(state.activeInstance?.hardGated).toBeUndefined();
  });
});

describe("createLatticeResetTool", () => {
  it("moves a stuck running stage back to pending and pauses the pipeline", async () => {
    const registry = registryOf(
      pipeline("implement", {
        stages: [
          stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] }),
          stage("apply", { agent: "implementor", completion: "tool_signal", signals: ["complete"] }),
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
            verdict: "approve",
            postHookRetriesUsed: 1,
          },
        ],
      }),
    );
    const signalsDir = join(projectDir, ".lattice", "signals");
    await mkdir(signalsDir, { recursive: true });
    await writeFile(join(signalsDir, "apply.json"), JSON.stringify({ status: "complete" }));

    const result = await createLatticeResetTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("reset");
    expect(result).toContain("apply");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.stages[0]).toMatchObject({ id: "plan", status: "completed", summary: "done" });
    expect(state.activeInstance?.stages[1]).toMatchObject({
      id: "apply",
      status: "pending",
      sessionId: undefined,
      startedAt: undefined,
      summary: undefined,
      verdict: undefined,
      postHookRetriesUsed: undefined,
    });

    await expect(access(join(signalsDir, "apply.json"))).rejects.toThrow();
  });

  it("refuses to reset without confirm: true", async () => {
    const registry = registryOf(
      pipeline("implement", {
        stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(registry, runningInstance());

    const result = await createLatticeResetTool(deps(state)).execute({ confirm: false }, undefined as never);

    expect(result).toContain("requires confirm: true");
    expect(state.activeInstance?.status).toBe("running");
  });

  it("refuses to reset a paused pipeline (use retry/approve instead)", async () => {
    const registry = registryOf(
      pipeline("implement", {
        stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(
      registry,
      runningInstance({
        status: "paused",
        stages: [{ id: "plan", agent: "planner", status: "rejected", summary: "bad" }],
      }),
    );

    const result = await createLatticeResetTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toContain("not running");
    expect(result).toContain("lattice_retry");
    expect(state.activeInstance?.status).toBe("paused");
  });

  it("reports no active pipeline when nothing is running", async () => {
    const registry = registryOf(
      pipeline("implement", {
        stages: [stage("plan", { agent: "planner", completion: "tool_signal", signals: ["complete"] })],
      }),
    );
    const state = makeState(registry);

    const result = await createLatticeResetTool(deps(state)).execute({ confirm: true }, undefined as never);

    expect(result).toBe("No active pipeline to reset.");
  });
});

describe("createLatticeSignalTool", () => {
  it("writes a signal file for the current stage", async () => {
    const definition = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "tool_signal", signals: ["complete"] })],
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
