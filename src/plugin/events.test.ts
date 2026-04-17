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
import { createEventHandler } from "./events.js";
import type { PluginState } from "./state.js";
import { SkillStore } from "./system-transform.js";

let projectDir: string;

const NO_OP_SESSIONS: SessionProvider = {
  injectPrompt: vi.fn(async () => {}),
  injectSubtask: vi.fn(async () => {}),
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

function buildHandler(state: PluginState, registry: PipelineRegistry) {
  const flattened = new Map<string, FlattenedPipeline>();
  const getFlattened = (name: string): FlattenedPipeline => {
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
    sessions: NO_OP_SESSIONS,
    engineConfig: state.engineConfig,
    latticeConfig: state.engineConfig.latticeConfig,
    discoveredSkills: [],
    scoringProvider: NO_SKILLS_PROVIDER,
    skillStore: new SkillStore(),
    log: SILENT_LOG,
  });
}

async function fireIdle(handler: ReturnType<typeof createEventHandler>) {
  await handler({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never);
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
      getLastAssistantMessage: vi.fn(async () => ""),
    };

    const failingHandler = createEventHandler({
      state,
      getFlattened: () => flat,
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
