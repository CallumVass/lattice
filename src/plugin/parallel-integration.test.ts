import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parallel, pipeline, stage } from "../builder/index.js";
import {
  type EngineConfig,
  type FlattenedPipeline,
  flattenPipeline,
  type PipelineRegistry,
  type SessionProvider,
} from "../engine/index.js";
import type { LatticeConfig, PipelineDefinition } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import { createEventHandler } from "./events.js";
import type { PluginState } from "./state.js";
import { SkillStore } from "./system-transform.js";
import { createLatticeControlTool, createLatticeSignalTool } from "./tools.js";

let projectDir: string;

const SILENT_LOG = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const NO_SKILLS_PROVIDER: ScoringProvider = {
  scoreSkills: vi.fn(async () => "[]"),
};

function registryOf(...defs: PipelineDefinition[]): PipelineRegistry {
  const registry: PipelineRegistry = new Map();
  for (const def of defs) registry.set(def.name, def);
  return registry;
}

function makeState(registry: PipelineRegistry, latticeConfig: LatticeConfig = {}): PluginState {
  const engineConfig: EngineConfig = { projectDir, latticeConfig };
  return {
    registry,
    flattenedCache: new Map(),
    activeInstance: undefined,
    parentSessionId: undefined,
    engineConfig,
    pipelineDirs: [join(projectDir, ".opencode", "lattice-pipelines")],
    diagnostics: [],
  };
}

function getFlattened(registry: PipelineRegistry) {
  return async (name: string): Promise<FlattenedPipeline> => {
    const def = registry.get(name);
    if (!def) throw new Error(`Pipeline "${name}" not found`);
    return flattenPipeline(def, registry);
  };
}

function toolContext(sessionID: string, agent: string) {
  return { sessionID, agent } as never;
}

async function fireIdle(handler: ReturnType<typeof createEventHandler>, sessionID: string) {
  await handler({ event: { type: "session.idle", properties: { sessionID } } } as never);
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-parallel-integration-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("parallel review integration", () => {
  it("runs a parallel reviewer group through control, events, signals, join, and final verdict", async () => {
    const definition = pipeline("swarm-review", {
      stages: [
        parallel("reviewers", {
          stages: [
            stage("security", {
              agent: "security-reviewer",
              completion: "signal",
              signals: ["complete", "blocked"],
              prompt: "Write security findings to `.lattice/review/security.md`.",
            }),
            stage("quality", {
              agent: "quality-reviewer",
              completion: "signal",
              signals: ["complete", "blocked"],
              prompt: "Write quality findings to `.lattice/review/quality.md`.",
            }),
          ],
        }),
        stage("verdict", {
          agent: "review-orchestrator",
          completion: "signal",
          signals: ["pass", "fail", "blocked"],
          context: "shared",
          prompt: "Read all reviewer outputs and issue the final verdict.",
        }),
      ],
    });
    const registry = registryOf(definition);
    const state = makeState(registry);
    const flattened = getFlattened(registry);
    const injectPrompt = vi.fn<SessionProvider["injectPrompt"]>(async () => {});
    const injectSubtask = vi.fn<SessionProvider["injectSubtask"]>(async () => ({}));
    const injectSubtasks = vi.fn<SessionProvider["injectSubtasks"]>(async (_sessionId, subtasks) =>
      subtasks.map((subtask) => ({
        sessionId: subtask.agent === "security-reviewer" ? "child-security" : "child-quality",
      })),
    );
    const notify = vi.fn<SessionProvider["notify"]>(async () => {});
    const sessions: SessionProvider = {
      injectPrompt,
      injectSubtask,
      injectSubtasks,
      notify,
      getLastAssistantMessage: vi.fn(async () => ""),
    };
    const stageRunnerDeps = {
      sessions,
      engineConfig: state.engineConfig,
      latticeConfig: state.engineConfig.latticeConfig,
      discoveredSkills: [],
      scoringProvider: NO_SKILLS_PROVIDER,
      skillStore: new SkillStore(),
      state,
      log: SILENT_LOG,
    };
    const toolDeps = {
      state,
      getFlattened: flattened,
      selectSkillsForStage: vi.fn(async () => {}),
      log: SILENT_LOG,
    };
    const eventHandler = createEventHandler({ ...stageRunnerDeps, getFlattened: flattened });
    const control = createLatticeControlTool(toolDeps);
    const signal = createLatticeSignalTool(toolDeps);

    const started = await control.execute(
      { action: "run", pipeline: "swarm-review", goal: "Review the current diff" },
      toolContext("parent", "build"),
    );
    expect(started).toContain('Pipeline "swarm-review" started.');

    await fireIdle(eventHandler, "parent");

    expect(injectSubtask).not.toHaveBeenCalled();
    expect(injectSubtasks).toHaveBeenCalledOnce();
    expect(injectSubtasks.mock.calls[0]?.[1].map((subtask) => subtask.agent)).toEqual([
      "security-reviewer",
      "quality-reviewer",
    ]);
    expect(state.activeInstance?.stages).toMatchObject([
      { id: "security", status: "running", sessionId: "child-security" },
      { id: "quality", status: "running", sessionId: "child-quality" },
      { id: "verdict", status: "pending" },
    ]);

    await signal.execute(
      { status: "complete", reason: "security findings written" },
      toolContext("child-security", "security-reviewer"),
    );
    await fireIdle(eventHandler, "child-security");

    expect(state.activeInstance?.currentStageIndex).toBe(0);
    expect(state.activeInstance?.stages).toMatchObject([
      { id: "security", status: "completed", summary: "security findings written" },
      { id: "quality", status: "running" },
      { id: "verdict", status: "pending" },
    ]);

    await signal.execute(
      { status: "complete", reason: "quality findings written" },
      toolContext("child-quality", "quality-reviewer"),
    );
    await fireIdle(eventHandler, "child-quality");

    expect(state.activeInstance?.currentStageIndex).toBe(2);
    expect(state.activeInstance?.stages[2]).toMatchObject({ id: "verdict", status: "pending" });
    expect(injectPrompt).not.toHaveBeenCalled();

    await fireIdle(eventHandler, "parent");

    expect(injectPrompt).toHaveBeenCalledWith(
      "parent",
      "review-orchestrator",
      expect.stringContaining("security findings written"),
      undefined,
    );
    expect(state.activeInstance?.stages[2]).toMatchObject({ id: "verdict", status: "running", sessionId: "parent" });

    await signal.execute(
      { status: "pass", reason: "all reviewer findings are acceptable" },
      toolContext("parent", "review-orchestrator"),
    );
    await fireIdle(eventHandler, "parent");

    expect(state.activeInstance).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("parent", expect.stringContaining('Pipeline "swarm-review" complete'));
  });
});
