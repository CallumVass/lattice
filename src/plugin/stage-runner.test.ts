import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EngineConfig,
  type FlattenedPipeline,
  flattenPipeline,
  type PipelineRegistry,
  type SessionProvider,
  startPipeline,
} from "../engine/index.js";
import reviewPipeline from "../pipelines/review.js";
import type { LatticeConfig, LearningEntry, PipelineDefinition } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import { createEventHandler } from "./events.js";
import { selectSkillsForStage } from "./stage-runner.js";
import type { PluginState } from "./state.js";
import { buildSystemTransform, SkillStore } from "./system-transform.js";

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
  };
}

function entry(overrides: Partial<LearningEntry>): LearningEntry {
  const now = new Date("2026-04-10T00:00:00.000Z").toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000000",
    agent: "code-reviewer",
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

async function writeSignal(stageId: string, status: string, reason?: string) {
  const dir = join(projectDir, ".lattice", "signals");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${stageId}.json`), JSON.stringify({ status, reason }));
}

async function clearSignal(stageId: string) {
  await rm(join(projectDir, ".lattice", "signals", `${stageId}.json`), { force: true });
}

const COMPOSER_FINDINGS = `FINDINGS

## Blocking

### Finding: Null check missing
- **File**: \`src/auth/login.ts:42\`
- **Severity**: critical
- **Confidence**: 95
- **Issue**: user can be null

### Finding: SQL injection
- **File**: \`src/db/users.ts:118\`
- **Severity**: high
- **Confidence**: 90
- **Issue**: id is interpolated
`;

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-stage-runner-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("selectSkillsForStage → learnings injection", () => {
  it("prepends a codebase-learnings skill whose content the system transform exposes", async () => {
    await seedLearnings([
      entry({ id: "11111111-1111-4111-8111-111111111111", category: "auth", pattern: "Null check on user" }),
      entry({
        id: "22222222-2222-4222-8222-222222222222",
        category: "db",
        pattern: "SQL injection via template string",
      }),
      entry({ id: "33333333-3333-4333-8333-333333333333", confidence: 0.1, pattern: "Low-confidence noise" }),
    ]);

    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);
    const flat = flattenPipeline(reviewPipeline, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "code-review", "code-reviewer", "review PR #1", {
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
    expect(learnings?.content).toContain("(learning: 11111111)");
    expect(learnings?.content).toContain("(learning: 22222222)");
    expect(learnings?.content).not.toContain("Low-confidence noise");
    expect(state.learningsInjected).toBe(2);

    const output = { system: [] as string[] };
    await buildSystemTransform(
      {},
      { track: () => {}, get: () => "code-reviewer" } as never,
      skillStore,
    )({ sessionID: "session-1", model: { id: "x", providerID: "y" } }, output);
    expect(output.system.join("\n")).toContain("### Skill: codebase-learnings");
    expect(output.system.join("\n")).toContain("(learning: 11111111)");
  });

  it("injects nothing when learnings are disabled in config", async () => {
    await seedLearnings([entry({ id: "11111111-1111-4111-8111-111111111111", category: "auth" })]);

    const registry = registryOf(reviewPipeline);
    const state = makeState(
      {
        learnings: {
          enabled: false,
          storePath: ".lattice/learnings.jsonl",
          agents: ["code-reviewer"],
          maxPerAgent: 5,
          confidenceThreshold: 0.5,
        },
      },
      registry,
    );
    const flat = flattenPipeline(reviewPipeline, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "code-review", "code-reviewer", "review PR #1", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: state.engineConfig.latticeConfig,
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

  it("injects nothing for an agent not listed in learnings.agents", async () => {
    await seedLearnings([entry({ id: "11111111-1111-4111-8111-111111111111" })]);

    const registry = registryOf(reviewPipeline);
    const state = makeState(
      {
        learnings: {
          enabled: true,
          storePath: ".lattice/learnings.jsonl",
          agents: ["planner"],
          maxPerAgent: 5,
          confidenceThreshold: 0.5,
        },
      },
      registry,
    );
    const flat = flattenPipeline(reviewPipeline, registry);
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "code-review", "code-reviewer", "review PR #1", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: state.engineConfig.latticeConfig,
      discoveredSkills: [],
      scoringProvider: NO_SKILLS_PROVIDER,
      skillStore,
      state,
      log: SILENT_LOG,
    });

    const selected = skillStore.get("session-1");
    expect(selected.find((s) => s.name === "codebase-learnings")).toBeUndefined();
  });
});

describe("pipeline completion → metrics", () => {
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

  async function runReview(state: PluginState, handler: ReturnType<typeof createEventHandler>, composerOutput: string) {
    const signals = [
      { id: "code-review", status: "complete", reason: "FINDINGS" },
      { id: "review-judge", status: "complete", reason: "validated" },
      { id: "advisory-review", status: "complete", reason: "NO_FINDINGS" },
      { id: "propose-comments", status: "complete", reason: composerOutput },
      { id: "post-comments", status: "complete", reason: "posted" },
    ];
    for (const sig of signals) {
      await fireIdle(handler);
      await writeSignal(sig.id, sig.status, sig.reason);
      await fireIdle(handler);
      await clearSignal(sig.id);
      if (sig.id === "propose-comments") {
        const paused = state.activeInstance;
        if (paused) paused.status = "running";
      }
    }
  }

  it("appends a metrics row per completed run with byCategory breakdown", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry, new SkillStore());

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "https://github.com/acme/widgets/pull/10", state.engineConfig);
    state.activeInstance = instance;
    state.learningsInjected = 4;

    await runReview(state, handler, COMPOSER_FINDINGS);

    const raw = await readFile(join(projectDir, ".lattice", "metrics.jsonl"), "utf-8");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instance: instance.id,
      pipeline: "review",
      findingsCount: 2,
      byCategory: { auth: 1, db: 1 },
      learningsInjected: 4,
    });
    expect(state.learningsInjected).toBe(0);
  });

  it("records metrics even when learnings injection is disabled", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState(
      {
        learnings: {
          enabled: false,
          storePath: ".lattice/learnings.jsonl",
          agents: ["code-reviewer"],
          maxPerAgent: 5,
          confidenceThreshold: 0.5,
        },
      },
      registry,
    );
    const handler = buildHandler(state, registry, new SkillStore());

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "PR #20", state.engineConfig);
    state.activeInstance = instance;

    await runReview(state, handler, COMPOSER_FINDINGS);

    const raw = await readFile(join(projectDir, ".lattice", "metrics.jsonl"), "utf-8");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ findingsCount: 2, learningsInjected: 0 });
  });
});
