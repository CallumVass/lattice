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
import type { PluginState } from "./state.js";
import { SkillStore } from "./system-transform.js";

let projectDir: string;

const NO_OP_SESSIONS: SessionProvider = {
  injectPrompt: vi.fn(async () => {}),
  injectSubtask: vi.fn(async () => ({})),
  injectSubtasks: vi.fn<SessionProvider["injectSubtasks"]>(async (sessionId, subtasks) =>
    subtasks.map((_, index) => ({ sessionId: `${sessionId}-child-${index + 1}` })),
  ),
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
  for (const def of defs) registry.set(def.name, def);
  return registry;
}

interface HandlerOverrides {
  sessions?: SessionProvider;
  scheduleCurrentStage?: () => Promise<void>;
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
    ...(overrides.scheduleCurrentStage && { scheduleCurrentStage: overrides.scheduleCurrentStage }),
  });
}

async function fireIdle(handler: ReturnType<typeof createEventHandler>, sessionID = "session-1") {
  await handler({ event: { type: "session.idle", properties: { sessionID } } } as never);
}

interface AssistantInfoOverrides {
  sessionID?: string;
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
  agent?: string;
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
        sessionID: overrides.sessionID ?? "session-1",
        info: {
          role: overrides.role ?? "assistant",
          agent: overrides.agent,
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
      stage("first", { agent: "planner", completion: "signal", signals: ["complete"], context: "isolated" }),
      stage("second", { agent: "implementor", completion: "signal", signals: ["complete"], context: "shared" }),
    ],
  });

  it("advances through stages when each signals complete", async () => {
    const registry = registryOf(twoStage);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(twoStage, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler);
    expect(state.activeInstance?.stages[0]?.status).toBe("running");

    await writeSignal("first", "complete", "done");
    await fireIdle(handler);
    await clearSignal("first");

    expect(state.activeInstance?.currentStageIndex).toBe(1);
    expect(state.activeInstance?.stages[0]?.status).toBe("completed");

    await fireIdle(handler);
    expect(state.activeInstance?.stages[1]?.status).toBe("running");
    await writeSignal("second", "complete", "done");
    await fireIdle(handler);
    await clearSignal("second");

    expect(state.activeInstance).toBeUndefined();
  });

  it("waits for parent idle before scheduling after an isolated stage completes", async () => {
    const registry = registryOf(twoStage);
    const state = makeState({}, registry);
    const scheduleCurrentStage = vi.fn(async () => {});
    const handler = buildHandler(state, registry, { scheduleCurrentStage });

    const flat = flattenPipeline(twoStage, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig, "session-1");
    state.activeInstance = instance;
    const firstStage = instance.stages[0];
    expect(firstStage).toBeDefined();
    if (!firstStage) throw new Error("Expected first stage");
    firstStage.status = "running";
    firstStage.sessionId = "child-1";

    await writeSignal("first", "complete", "done");
    await fireIdle(handler, "child-1");

    expect(state.activeInstance?.currentStageIndex).toBe(1);
    expect(state.activeInstance?.stages[0]?.status).toBe("completed");
    expect(state.activeInstance?.stages[1]?.status).toBe("pending");
    expect(scheduleCurrentStage).not.toHaveBeenCalled();

    await fireIdle(handler, "session-1");

    expect(scheduleCurrentStage).toHaveBeenCalledTimes(1);
  });

  it("injects a pause prompt when a stage fails", async () => {
    const p = pipeline("review", {
      stages: [stage("review", { agent: "reviewer", completion: "signal", signals: ["pass", "fail"] })],
    });
    const registry = registryOf(p);
    const state = makeState({}, registry);
    const injectPrompt = vi.fn<SessionProvider["injectPrompt"]>(async () => {});
    const sessions: SessionProvider = {
      ...NO_OP_SESSIONS,
      injectPrompt,
    };
    const handler = buildHandler(state, registry, { sessions });

    const flat = flattenPipeline(p, registry);
    const { instance } = await startPipeline(flat, "review", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler);
    injectPrompt.mockClear();
    await writeSignal("review", "fail", "needs work");
    await fireIdle(handler);

    expect(state.activeInstance?.status).toBe("paused");
    expect(state.activeInstance?.pause).toMatchObject({ kind: "rejection", stageId: "review" });
    expect(injectPrompt).toHaveBeenCalledWith(
      "session-1",
      "build",
      expect.stringContaining("Pipeline: review"),
      undefined,
      expect.stringContaining("Call the question tool now"),
    );
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
      injectSubtasks: vi.fn(async () => {
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
      observedModel: "anthropic/claude-opus-4",
      observedProvider: "anthropic",
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

  it("does not overwrite configured model/provider telemetry", () => {
    const seeded = accumulateTelemetry(
      {
        model: "deepseek-v4-pro",
        provider: "opencode-go",
        configuredModel: "deepseek-v4-pro",
        configuredProvider: "opencode-go",
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        costUSD: 0,
        messageCount: 0,
      },
      {
        role: "assistant",
        modelID: "mimo-v2.5",
        providerID: "opencode-go",
        cost: 0.03,
        tokens: { input: 200, output: 80 },
      },
    );

    expect(seeded.model).toBe("deepseek-v4-pro");
    expect(seeded.provider).toBe("opencode-go");
    expect(seeded.configuredModel).toBe("deepseek-v4-pro");
    expect(seeded.configuredProvider).toBe("opencode-go");
    expect(seeded.observedModel).toBe("mimo-v2.5");
    expect(seeded.observedProvider).toBe("opencode-go");
    expect(seeded.tokensIn).toBe(200);
    expect(seeded.messageCount).toBe(1);
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
    stages: [stage("only", { agent: "planner", completion: "signal", signals: ["complete"], context: "isolated" })],
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

    await fireIdle(handler);
    return { state, handler };
  }

  it("attributes assistant-completed messages to the currently-running stage", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { input: 100, output: 50, cost: 0.02 });

    const stageInstance = state.activeInstance?.stages[0];
    expect(stageInstance?.telemetry).toBeDefined();
    expect(stageInstance?.telemetry?.tokensIn).toBe(100);
    expect(stageInstance?.telemetry?.tokensOut).toBe(50);
    expect(stageInstance?.telemetry?.costUSD).toBeCloseTo(0.02);
    expect(stageInstance?.telemetry?.messageCount).toBe(1);
  });

  it("ignores assistant messages from unrelated sessions", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { sessionID: "other-session", input: 100, output: 50, cost: 0.02 });

    expect(state.activeInstance?.stages[0]?.telemetry).toBeUndefined();
  });

  it("seeds running stage telemetry from configured model override", async () => {
    const registry = registryOf(oneStage);
    const state = makeState({ agents: { planner: { model: "opencode-go/deepseek-v4-pro" } } }, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(oneStage, registry);
    const { instance } = await startPipeline(flat, "ship it", state.engineConfig);
    state.activeInstance = instance;

    await fireIdle(handler);
    await fireAssistantMessage(handler, { agent: "planner", modelID: "mimo-v2.5", providerID: "opencode-go" });

    const telemetry = state.activeInstance?.stages[0]?.telemetry;
    expect(telemetry?.model).toBe("deepseek-v4-pro");
    expect(telemetry?.provider).toBe("opencode-go");
    expect(telemetry?.configuredModel).toBe("deepseek-v4-pro");
    expect(telemetry?.configuredProvider).toBe("opencode-go");
    expect(telemetry?.observedModel).toBe("mimo-v2.5");
    expect(telemetry?.observedProvider).toBe("opencode-go");
    expect(telemetry?.messageCount).toBe(1);
  });

  it("ignores partial frames where time.completed is unset", async () => {
    const { state, handler } = await primeRunningStage();

    await fireAssistantMessage(handler, { completed: undefined, input: 999, output: 999 });

    expect(state.activeInstance?.stages[0]?.telemetry).toBeUndefined();
  });

  it("ignores telemetry when the current stage is not running", async () => {
    const { state, handler } = await primeRunningStage();
    if (state.activeInstance) state.activeInstance.status = "paused";

    await fireAssistantMessage(handler);

    expect(state.activeInstance?.stages[0]?.telemetry).toBeUndefined();
  });
});
