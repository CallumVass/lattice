import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { createEventHandler } from "../plugin/events.js";
import { selectSkillsForStage } from "../plugin/stage-runner.js";
import type { PluginState } from "../plugin/state.js";
import { buildSystemTransform, SkillStore } from "../plugin/system-transform.js";
import type { LatticeConfig, LearningEntry, PipelineDefinition } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import implementPipeline from "./implement.js";
import reviewLoopPipeline from "./review-loop.js";

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
    pattern: "default",
    category: "general",
    severity: "blocking",
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

async function fireIdle(handler: ReturnType<typeof createEventHandler>) {
  await handler({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never);
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-implement-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("plan stage → learnings injection", () => {
  it("injects a codebase-learnings skill for the planner agent when relevant entries exist", async () => {
    await seedLearnings([
      entry({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        category: "auth",
        pattern: "Null check on user.email before deref",
      }),
      entry({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        category: "db",
        pattern: "Parameterise SQL to avoid injection",
      }),
    ]);

    const registry = registryOf(implementPipeline, reviewLoopPipeline);
    const state = makeState({}, registry);
    const flat = flattenPipeline(implementPipeline, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "plan", "planner", "implement auth null guard", {
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

    const output = { system: [] as string[] };
    await buildSystemTransform(
      {},
      { track: () => {}, get: () => "planner" } as never,
      skillStore,
    )({ sessionID: "session-1", model: { id: "x", providerID: "y" } }, output);
    expect(output.system.join("\n")).toContain("### Skill: codebase-learnings");
    expect(output.system.join("\n")).toContain("(learning: aaaaaaaa)");
  });

  it("omits the learnings skill when the planner stage has no matching entries", async () => {
    await seedLearnings([
      // Scoped to a non-* non-planner agent, so planner should not see it.
      entry({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        agent: "jira-planner",
        pattern: "Jira-only guidance",
      }),
    ]);

    const registry = registryOf(implementPipeline, reviewLoopPipeline);
    const state = makeState({}, registry);
    const flat = flattenPipeline(implementPipeline, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "plan", "planner", "implement something", {
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
    expect(selected.find((s) => s.name === "codebase-learnings")).toBeUndefined();
    expect(state.learningsInjected).toBe(0);
  });

  it("skips learnings for planner when learnings.agents does not include it", async () => {
    await seedLearnings([entry({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })]);

    const registry = registryOf(implementPipeline, reviewLoopPipeline);
    const state = makeState(
      {
        learnings: {
          enabled: true,
          storePath: ".lattice/learnings.jsonl",
          agents: ["code-reviewer"],
          maxPerAgent: 5,
          confidenceThreshold: 0.5,
        },
      },
      registry,
    );
    const flat = flattenPipeline(implementPipeline, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "plan", "planner", "goal", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: state.engineConfig.latticeConfig,
      discoveredSkills: [],
      scoringProvider: NO_SKILLS_PROVIDER,
      skillStore,
      state,
      log: SILENT_LOG,
    });

    expect(skillStore.get("session-1").find((s) => s.name === "codebase-learnings")).toBeUndefined();
  });
});

describe("implement pipeline completion → per-pipeline metrics", () => {
  function buildHandler(state: PluginState, registry: PipelineRegistry, skillStore: SkillStore) {
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
      skillStore,
      log: SILENT_LOG,
    });
  }

  it("records a metrics row tagged pipeline=implement once the run completes", async () => {
    // Use a minimal two-stage pipeline so we can drive completion deterministically
    // without having to stand up every downstream implement stage.
    const tiny = pipeline("implement", {
      stages: [
        stage("plan", { agent: "planner", completion: "plan_created" }),
        stage("implement", { agent: "implementor", completion: "plan_complete", fork: true }),
      ],
    });
    const registry = registryOf(tiny);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry, new SkillStore());

    const flat = flattenPipeline(tiny, registry);
    const { instance } = await startPipeline(flat, "implement auth null guard", state.engineConfig);
    state.activeInstance = instance;

    // Plan stage: start, then write plan file with the Known Codebase Risks section.
    await fireIdle(handler);
    const plansDir = join(projectDir, ".lattice", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "implement-auth-null-guard.md"),
      [
        "## Test Plan for auth null guard",
        "",
        "## Known Codebase Risks",
        "- (learning: aaaaaaaa) Null check on user.email before deref",
        "",
        "### Boundary Tests",
        "- [ ] add null guard (learning: aaaaaaaa)",
        "",
      ].join("\n"),
    );
    await fireIdle(handler);

    // Implement stage: complete the checklist to trigger plan_complete.
    await writeFile(
      join(plansDir, "implement-auth-null-guard.md"),
      [
        "## Test Plan for auth null guard",
        "",
        "## Known Codebase Risks",
        "- (learning: aaaaaaaa) Null check on user.email before deref",
        "",
        "### Boundary Tests",
        "- [x] add null guard (learning: aaaaaaaa)",
        "",
      ].join("\n"),
    );
    await fireIdle(handler);

    expect(state.activeInstance).toBeUndefined();

    const raw = await readFile(join(projectDir, ".lattice", "metrics.jsonl"), "utf-8");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pipeline: "implement", instance: instance.id });
  });
});
