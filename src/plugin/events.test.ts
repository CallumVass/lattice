import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import {
  type EngineConfig,
  type FlattenedPipeline,
  flattenPipeline,
  type PipelineRegistry,
  type SessionProvider,
  startPipeline,
} from "../engine/index.js";
import type { LatticeConfig, PipelineDefinition } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import { accumulateTelemetry, createEventHandler } from "./events.js";
import type { PostHookRunner } from "./post-hook.js";
import type { PluginState } from "./state.js";
import { SkillStore } from "./system-transform.js";

let projectDir: string;

const NO_OP_SESSIONS: SessionProvider = {
  injectPrompt: vi.fn(async () => {}),
  injectSubtask: vi.fn(async () => {}),
  notify: vi.fn(async () => {}),
  getLastAssistantMessage: vi.fn(async () => ""),
};

const NO_SKILLS_PROVIDER: ScoringProvider = {
  scoreSkills: vi.fn(async () => "[]"),
};

const SILENT_LOG = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function registryOf(...defs: PipelineDefinition[]): PipelineRegistry {
  const registry: PipelineRegistry = new Map();
  for (const def of defs) {
    registry.set(def.name, def);
  }
  return registry;
}

interface HandlerOverrides {
  sessions?: SessionProvider;
  postHookRunner?: PostHookRunner;
}

function buildHandler(state: PluginState, registry: PipelineRegistry, overrides: HandlerOverrides = {}) {
  const flattened = new Map<string, FlattenedPipeline>();
  const getFlattened = async (name: string): Promise<FlattenedPipeline> => {
    let flat = flattened.get(name);
    if (!flat) {
      const def = registry.get(name);
      if (!def) throw new Error(`Pipeline "${name}" not found`);
      flat = flattenPipeline(def, registry);
      flattened.set(name, flat);
    }
    return flat;
  };

  return createEventHandler({
    state,
    getFlattened,
    sessions: overrides.sessions ?? NO_OP_SESSIONS,
    engineConfig: state.engineConfig,
    latticeConfig: state.engineConfig.latticeConfig,
    discoveredSkills: [],
    scoringProvider: NO_SKILLS_PROVIDER,
    skillStore: new SkillStore(),
    log: SILENT_LOG,
    ...(overrides.postHookRunner && { postHookRunner: overrides.postHookRunner }),
  });
}

async function fireIdle(handler: ReturnType<typeof createEventHandler>) {
  await handler({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never);
}

interface AssistantInfoOverrides {
  role?: string;
  completed?: number | undefined;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  modelID?: string;
  providerID?: string;
}

async function fireAssistantMessage(
  handler: ReturnType<typeof createEventHandler>,
  overrides: AssistantInfoOverrides = {},
) {
  const time = "completed" in overrides ? { completed: overrides.completed } : { completed: 1 };
  await handler({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: overrides.role ?? "assistant",
          time,
          modelID: overrides.modelID ?? "anthropic/claude-opus-4",
          providerID: overrides.providerID ?? "anthropic",
          cost: overrides.cost ?? 0.01,
          tokens: {
            input: overrides.input ?? 100,
            output: overrides.output ?? 50,
            reasoning: overrides.reasoning ?? 0,
            cache: { read: overrides.cacheRead ?? 0, write: overrides.cacheWrite ?? 0 },
          },
        },
      },
    },
  } as never);
}

async function writeSignal(stageId: string, status: string, reason?: string) {
  const dir = join(projectDir, ".lattice", "signals");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${stageId}.json`), JSON.stringify({ status, reason }));
}

async function clearSignal(stageId: string) {
  await rm(join(projectDir, ".lattice", "signals", `${stageId}.json`), { force: true });
}

function makeState(latticeConfig: LatticeConfig, registry: PipelineRegistry): PluginState {
  const engineConfig: EngineConfig = { projectDir, latticeConfig };
  return {
    registry,
    flattenedCache: new Map(),
    activeInstance: undefined,
    parentSessionId: "session-1",
    engineConfig,
  };
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-events-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("session.idle pipeline progression", () => {
  const twoStage = pipeline("two-stage", {
    stages: [
      stage("first", { agent: "planner", completion: "tool_signal", signals: ["complete"], fork: false }),
      stage("second", { agent: "implementor", completion: "tool_signal", signals: ["complete"], fork: true }),
    ],
  });

  it("advances through stages when each signals complete", async () => {
    const registry = registryOf(twoStage);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(twoStage, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    // first stage: execute pending → running
    await fireIdle(handler);
    expect(state.activeInstance?.stages[0]?.status).toBe("running");

    // first stage signals complete → advance to second
    await writeSignal("first", "complete", "done");
    await fireIdle(handler);
    await clearSignal("first");

    expect(state.activeInstance?.currentStageIndex).toBe(1);
    expect(state.activeInstance?.stages[0]?.status).toBe("completed");

    // second stage runs → signals complete → pipeline completes
    await fireIdle(handler);
    expect(state.activeInstance?.stages[1]?.status).toBe("running");
    await writeSignal("second", "complete", "done");
    await fireIdle(handler);
    await clearSignal("second");

    expect(state.activeInstance).toBeUndefined();
  });

  it("marks the instance failed when a stage throws during execution", async () => {
    const registry = registryOf(twoStage);
    const state = makeState({}, registry);
    const flat = flattenPipeline(twoStage, registry);
    const { instance } = await startPipeline(flat, "oops", state.engineConfig);
    state.activeInstance = instance;

    const sessions: SessionProvider = {
      injectPrompt: vi.fn(async () => {}),
      injectSubtask: vi.fn(async () => {
        throw new Error("subtask failed");
      }),
      notify: vi.fn(async () => {}),
      getLastAssistantMessage: vi.fn(async () => ""),
    };

    const failingHandler = createEventHandler({
      state,
      getFlattened: async () => flat,
      sessions,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [],
      scoringProvider: NO_SKILLS_PROVIDER,
      skillStore: new SkillStore(),
      log: SILENT_LOG,
    });

    await fireIdle(failingHandler);

    expect(state.activeInstance).toBeUndefined();
    expect(instance.status).toBe("failed");
  });

  it("ignores session.idle when no pipeline is active", async () => {
    const registry = registryOf(twoStage);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    await expect(fireIdle(handler)).resolves.toBeUndefined();
    expect(state.activeInstance).toBeUndefined();
  });
});

describe("telemetry accumulation", () => {
  it("accumulates token and cost fields across messages", () => {
    const first = accumulateTelemetry(undefined, {
      role: "assistant",
      modelID: "anthropic/claude-opus-4",
      providerID: "anthropic",
      cost: 0.02,
      time: { completed: 1 },
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
    });
    expect(first).toEqual({
      model: "anthropic/claude-opus-4",
      provider: "anthropic",
      tokensIn: 100,
      tokensOut: 50,
      tokensReasoning: 10,
      tokensCacheRead: 5,
      tokensCacheWrite: 2,
      costUSD: 0.02,
      messageCount: 1,
    });

    const second = accumulateTelemetry(first, {
      role: "assistant",
      cost: 0.03,
      tokens: { input: 200, output: 80, cache: { read: 3, write: 1 } },
    });
    expect(second.tokensIn).toBe(300);
    expect(second.tokensOut).toBe(130);
    expect(second.tokensCacheRead).toBe(8);
    expect(second.tokensCacheWrite).toBe(3);
    expect(second.costUSD).toBeCloseTo(0.05);
    expect(second.messageCount).toBe(2);
    expect(second.model).toBe("anthropic/claude-opus-4");
  });

  it("treats missing token/cost fields as zero", () => {
    const t = accumulateTelemetry(undefined, { role: "assistant" });
    expect(t).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costUSD: 0,
      messageCount: 1,
    });
  });
});

describe("message.updated event handling", () => {
  const oneStage = pipeline("one-stage", {
    stages: [stage("only", { agent: "planner", completion: "tool_signal", signals: ["complete"], fork: false })],
  });

  async function primeRunningStage(): Promise<{
    state: PluginState;
    handler: ReturnType<typeof createEventHandler>;
  }> {
    const registry = registryOf(oneStage);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(oneStage, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler); // transitions the stage to "running"
    return { state, handler };
  }

  it("attributes assistant-completed messages to the currently-running stage", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { input: 100, output: 50, cost: 0.02 });

    const stage = state.activeInstance?.stages[0];
    expect(stage?.telemetry).toBeDefined();
    expect(stage?.telemetry?.tokensIn).toBe(100);
    expect(stage?.telemetry?.tokensOut).toBe(50);
    expect(stage?.telemetry?.costUSD).toBeCloseTo(0.02);
    expect(stage?.telemetry?.messageCount).toBe(1);
  });

  it("accumulates multiple messages across the stage lifetime", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { input: 100, output: 50, cost: 0.02 });
    await fireAssistantMessage(handler, { input: 200, output: 80, cost: 0.03 });

    const stage = state.activeInstance?.stages[0];
    expect(stage?.telemetry?.tokensIn).toBe(300);
    expect(stage?.telemetry?.tokensOut).toBe(130);
    expect(stage?.telemetry?.costUSD).toBeCloseTo(0.05);
    expect(stage?.telemetry?.messageCount).toBe(2);
  });

  it("ignores partial frames where time.completed is unset", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { completed: undefined, input: 999, output: 999 });

    expect(state.activeInstance?.stages[0]?.telemetry).toBeUndefined();
  });

  it("ignores non-assistant roles (user messages)", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { role: "user", input: 999 });

    expect(state.activeInstance?.stages[0]?.telemetry).toBeUndefined();
  });

  it("drops telemetry when no pipeline is active", async () => {
    const registry = registryOf(oneStage);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    await expect(fireAssistantMessage(handler)).resolves.toBeUndefined();
    expect(state.activeInstance).toBeUndefined();
  });

  it("drops telemetry when the current stage is not running (e.g. paused)", async () => {
    const { state, handler } = await primeRunningStage();
    if (state.activeInstance) state.activeInstance.status = "paused";

    await fireAssistantMessage(handler);

    expect(state.activeInstance?.stages[0]?.telemetry).toBeUndefined();
  });
});

describe("post-hook integration", () => {
  const oneStageWithHook = pipeline("hooked", {
    stages: [
      stage("only", {
        agent: "planner",
        completion: "tool_signal",
        signals: ["complete"],
        postHook: { commands: ["npm run check"], maxRetries: 2 },
      }),
    ],
  });

  it("advances normally when the post-hook passes", async () => {
    const registry = registryOf(oneStageWithHook);
    const state = makeState({}, registry);
    const runner: PostHookRunner = vi.fn(async () => ({ ok: true }) as const);
    const handler = buildHandler(state, registry, { postHookRunner: runner });

    const flat = flattenPipeline(oneStageWithHook, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler); // pending → running

    await writeSignal("only", "complete", "done");
    await fireIdle(handler);
    await clearSignal("only");

    expect(runner).toHaveBeenCalledOnce();
    expect(state.activeInstance).toBeUndefined();
  });

  it("injects feedback as a subtask and stays running when the hook fails within retry budget (fork: false)", async () => {
    // oneStageWithHook has no `fork` set, so it defaults to false (subtask).
    // Retry must go through injectSubtask — routing via injectPrompt would
    // land the retry in the parent session instead of a fresh subtask.
    const registry = registryOf(oneStageWithHook);
    const state = makeState({}, registry);
    const injectPrompt = vi.fn<SessionProvider["injectPrompt"]>(async () => {});
    const injectSubtask = vi.fn<SessionProvider["injectSubtask"]>(async () => {});
    const sessions: SessionProvider = {
      injectPrompt,
      injectSubtask,
      notify: vi.fn(async () => {}),
      getLastAssistantMessage: vi.fn(async () => ""),
    };
    const runner: PostHookRunner = vi.fn(async () => ({
      ok: false,
      command: "npm run check",
      exitCode: 1,
      output: "typecheck error in foo.ts",
    }));

    const handler = buildHandler(state, registry, { sessions, postHookRunner: runner });

    const flat = flattenPipeline(oneStageWithHook, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler); // pending → running
    injectPrompt.mockClear();
    injectSubtask.mockClear();

    await writeSignal("only", "complete", "done");
    await fireIdle(handler);

    expect(runner).toHaveBeenCalledOnce();
    expect(state.activeInstance?.stages[0]?.status).toBe("running");
    expect(state.activeInstance?.stages[0]?.postHookRetriesUsed).toBe(1);
    expect(state.activeInstance?.status).toBe("running");

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(injectSubtask).toHaveBeenCalledOnce();
    const call = injectSubtask.mock.calls[0];
    expect(call?.[1]).toBe("planner");
    expect(call?.[2]).toContain("npm run check");
    expect(call?.[2]).toContain("typecheck error in foo.ts");
    expect(call?.[3]).toContain("post-hook retry");

    // Signal file must be cleared so the next idle doesn't immediately re-trigger completion.
    await expect(
      writeSignal("only", "complete", "done"), // should succeed fresh — prior one was removed
    ).resolves.toBeUndefined();
    await clearSignal("only");
  });

  it("pauses the pipeline with a rejected stage when retries are exhausted", async () => {
    const registry = registryOf(oneStageWithHook);
    const state = makeState({}, registry);
    const injectPrompt = vi.fn(async () => {});
    const sessions: SessionProvider = {
      injectPrompt,
      injectSubtask: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
      getLastAssistantMessage: vi.fn(async () => ""),
    };
    const runner: PostHookRunner = vi.fn(async () => ({
      ok: false,
      command: "npm run check",
      exitCode: 1,
      output: "still broken",
    }));

    const handler = buildHandler(state, registry, { sessions, postHookRunner: runner });

    const flat = flattenPipeline(oneStageWithHook, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler); // pending → running

    // Three completion attempts: first two consume retries, third exhausts.
    for (let i = 0; i < 3; i++) {
      await writeSignal("only", "complete", "done");
      await fireIdle(handler);
    }

    expect(runner).toHaveBeenCalledTimes(3);
    expect(state.activeInstance?.stages[0]?.status).toBe("rejected");
    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.stages[0]?.summary).toContain("still broken");
  });
});
