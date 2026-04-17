import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EngineConfig, flattenPipeline, type PipelineRegistry, type SessionProvider } from "../engine/index.js";
import { selectSkillsForStage } from "../plugin/stage-runner.js";
import type { PluginState } from "../plugin/state.js";
import { SkillStore } from "../plugin/system-transform.js";
import { createLatticeInsightsTool } from "../plugin/tools.js";
import type { LatticeConfig, LearningEntry, PipelineDefinition } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import createJiraIssues from "./create-jira-issues.js";

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
  for (const def of defs) registry.set(def.name, def);
  return registry;
}

function makeState(latticeConfig: LatticeConfig, registry: PipelineRegistry): PluginState {
  const engineConfig: EngineConfig = { projectDir, latticeConfig };
  return {
    registry,
    flattenedCache: new Map(),
    activeInstance: undefined,
    parentSessionId: "session-1",
    engineConfig,
    learningsInjected: 0,
    pendingKills: undefined,
    originalProposeSummary: undefined,
    lastCompactionMerged: 0,
  };
}

function entry(overrides: Partial<LearningEntry>): LearningEntry {
  const now = new Date("2026-04-10T00:00:00.000Z").toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000000",
    agent: "*",
    pattern: "Parameterise SQL inputs",
    category: "db",
    severity: "advisory",
    source: { stageId: "propose-comments", date: now },
    confidence: 0.9,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

async function seedLearnings(entries: LearningEntry[]): Promise<void> {
  const dir = join(projectDir, ".lattice");
  await mkdir(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(join(dir, "learnings.jsonl"), `${lines}\n`);
}

async function seedMetrics(lines: string[]): Promise<void> {
  const dir = join(projectDir, ".lattice");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "metrics.jsonl"), `${lines.join("\n")}\n`);
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-jira-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("jira-planner draft stage → learnings injection", () => {
  it("injects a codebase-learnings skill for the jira-planner agent", async () => {
    await seedLearnings([
      entry({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        category: "auth",
        pattern: "Guard user.email before deref",
        severity: "advisory",
      }),
      entry({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        category: "db",
        pattern: "Parameterise SQL inputs",
        severity: "advisory",
      }),
    ]);

    const registry = registryOf(createJiraIssues);
    const state = makeState({}, registry);
    const flat = flattenPipeline(createJiraIssues, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "draft", "jira-planner", "decompose the billing page PRD", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [],
      scoringProvider: NO_SKILLS_PROVIDER,
      skillStore,
      state,
      log: SILENT_LOG,
    });

    const selected = skillStore.get("session-1");
    const learnings = selected.find((s) => s.name === "codebase-learnings");
    expect(learnings).toBeDefined();
    expect(learnings?.content).toContain("(learning: aaaaaaaa)");
    expect(learnings?.content).toContain("(learning: bbbbbbbb)");
    expect(state.learningsInjected).toBe(2);
  });

  it("omits the learnings skill when no positive entries apply", async () => {
    await seedLearnings([
      entry({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        severity: "negative",
      }),
    ]);

    const registry = registryOf(createJiraIssues);
    const state = makeState({}, registry);
    const flat = flattenPipeline(createJiraIssues, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "draft", "jira-planner", "goal", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [],
      scoringProvider: NO_SKILLS_PROVIDER,
      skillStore,
      state,
      log: SILENT_LOG,
    });

    expect(skillStore.get("session-1").find((s) => s.name === "codebase-learnings")).toBeUndefined();
  });
});

describe("lattice_insights tool", () => {
  function toolDeps(state: PluginState) {
    return {
      state,
      getFlattened: () => {
        throw new Error("not used");
      },
      selectSkillsForStage: vi.fn(async () => {}),
      log: SILENT_LOG,
    };
  }

  it("returns all four sections when learnings + metrics exist", async () => {
    await seedLearnings([
      entry({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        category: "auth",
        pattern: "Null-check email",
        reinforcementCount: 4,
        confidence: 0.85,
      }),
      entry({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        category: "db",
        pattern: "Parameterise SQL inputs",
        reinforcementCount: 2,
        confidence: 0.6,
        lastSeenAt: "2026-04-02T00:00:00.000Z",
      }),
      entry({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        severity: "negative",
      }),
    ]);
    await seedMetrics([
      JSON.stringify({
        instance: "run-a",
        pipeline: "review",
        findingsCount: 3,
        byCategory: { auth: 2, db: 1 },
        learningsInjected: 1,
        timestamp: "2026-04-06T10:00:00.000Z",
      }),
      JSON.stringify({
        instance: "run-b",
        pipeline: "review",
        findingsCount: 2,
        byCategory: { db: 2 },
        learningsInjected: 0,
        timestamp: "2026-04-13T10:00:00.000Z",
      }),
    ]);

    const registry = registryOf(createJiraIssues);
    const state = makeState({}, registry);

    const output = (await createLatticeInsightsTool(toolDeps(state)).execute({}, undefined as never)) as string;

    expect(output).toContain("# Lattice learning-loop insights");
    expect(output).toContain("## Findings trend");
    expect(output).toContain("| Category |");
    expect(output).toContain("auth");
    expect(output).toContain("db");
    expect(output).toContain("## Top 10 patterns by reinforcement");
    expect(output).toContain("aaaaaaaa");
    expect(output).toContain("## Near expiry (top 5)");
    expect(output).toContain("## Negative learnings");
    expect(output).toContain("1 false-positive pattern");
  });

  it("renders placeholders for an empty store without crashing", async () => {
    const registry = registryOf(createJiraIssues);
    const state = makeState({}, registry);

    const output = (await createLatticeInsightsTool(toolDeps(state)).execute({}, undefined as never)) as string;

    expect(output).toContain("_No metrics recorded yet._");
    expect(output).toContain("_No learnings captured yet._");
    expect(output).toContain("_No learnings near expiry._");
    expect(output).toContain("_No negative learnings stored yet._");
  });

  it("returns a disabled message when learnings are off", async () => {
    const registry = registryOf(createJiraIssues);
    const state = makeState({ learnings: { enabled: false } }, registry);

    const output = (await createLatticeInsightsTool(toolDeps(state)).execute({}, undefined as never)) as string;

    expect(output).toContain("Learnings are disabled.");
  });

  it("narrows the trend window when `since` is provided", async () => {
    await seedMetrics([
      JSON.stringify({
        instance: "old",
        pipeline: "review",
        findingsCount: 5,
        byCategory: { legacy: 5 },
        learningsInjected: 0,
        timestamp: "2025-12-01T00:00:00.000Z",
      }),
      JSON.stringify({
        instance: "new",
        pipeline: "review",
        findingsCount: 1,
        byCategory: { fresh: 1 },
        learningsInjected: 0,
        timestamp: new Date().toISOString(),
      }),
    ]);

    const registry = registryOf(createJiraIssues);
    const state = makeState({}, registry);

    const output = (await createLatticeInsightsTool(toolDeps(state)).execute(
      { since: "2026-04-01" },
      undefined as never,
    )) as string;

    expect(output).toContain("fresh");
    expect(output).not.toContain("legacy");
  });
});
