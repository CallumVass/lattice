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
import { writeAllLearnings } from "../learnings/index.js";
import reviewPipeline from "../pipelines/review.js";
import {
  type LatticeConfig,
  type LearningEntry,
  learningEntrySchema,
  type PipelineDefinition,
  type PipelineInstance,
} from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import { createEventHandler } from "./events.js";
import type { PluginState } from "./state.js";
import { SkillStore } from "./system-transform.js";
import { createLatticeRetryTool } from "./tools.js";

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

const COMPOSER_FINDINGS = `FINDINGS

## Blocking

### Finding 1: Null check missing
- **File**: \`src/auth/login.ts:42\`
- **Severity**: critical
- **Confidence**: 95
- **Issue**: user can be null
- **Fix**: add a guard

### Finding 2: SQL injection
- **File**: \`src/db/users.ts:118\`
- **Severity**: high
- **Confidence**: 90
- **Issue**: id is interpolated directly
- **Fix**: parameterise the query

## Advisory

### Finding 3: Reuse existing helper
- **File**: \`src/util/route.ts:14\`
- **Severity**: advisory
- **Confidence**: 85
- **Issue**: helper already exists
- **Fix**: import the existing helper
`;

const COMPOSER_WITH_KILL_TARGETS = `FINDINGS

## Blocking

### Finding 1: Null check missing
- **File**: \`src/auth/login.ts:42\`
- **Severity**: critical
- **Confidence**: 95
- **Issue**: user can be null
- **Fix**: add a guard

### Finding 2: Overzealous refactor suggestion
- **File**: \`src/util/helper.ts:10\`
- **Severity**: high
- **Confidence**: 75
- **Issue**: false positive
- **Fix**: ignore

### Finding 3: SQL injection
- **File**: \`src/db/users.ts:118\`
- **Severity**: high
- **Confidence**: 90
- **Issue**: id is interpolated directly
- **Fix**: parameterise the query

## Advisory

### Finding 4: Reuse existing helper
- **File**: \`src/util/route.ts:14\`
- **Severity**: advisory
- **Confidence**: 85
- **Issue**: helper already exists
- **Fix**: import the existing helper
`;

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

interface RunOptions {
  kills?: number[];
  postSummary?: string;
}

/**
 * Drive the review pipeline through every stage by firing `session.idle`
 * events and writing signal payloads as each stage starts. Handles the
 * `propose-comments` approval gate by simulating `/lattice-retry` — with
 * optional `kills` to exercise the kill-list path through the real retry
 * tool instead of just flipping state.
 */
async function runReviewPipeline(
  state: PluginState,
  handler: ReturnType<typeof createEventHandler>,
  composerOutput: string,
  options: RunOptions = {},
) {
  const stageSignals: Array<{ id: string; status: string; reason?: string }> = [
    { id: "code-review", status: "complete", reason: "FINDINGS for 2 blocking issues" },
    { id: "review-judge", status: "complete", reason: "Validated 2 blocking findings" },
    { id: "advisory-review", status: "complete", reason: "1 advisory finding" },
    { id: "propose-comments", status: "complete", reason: composerOutput },
    {
      id: "post-comments",
      status: "complete",
      reason: options.postSummary ?? "Posted inline comments on PR",
    },
  ];

  for (const sig of stageSignals) {
    await fireIdle(handler);
    const instance = state.activeInstance;
    if (!instance) throw new Error("Pipeline instance unexpectedly cleared");
    const current = instance.stages[instance.currentStageIndex];
    expect(current?.id).toBe(sig.id);
    expect(current?.status).toBe("running");

    await writeSignal(sig.id, sig.status, sig.reason);
    await fireIdle(handler);
    await clearSignal(sig.id);

    if (sig.id === "propose-comments") {
      const paused = state.activeInstance;
      if (!paused) throw new Error("Instance lost during pause");
      expect(paused.status).toBe("paused");
      const retry = createLatticeRetryTool({
        state,
        getFlattened: () => flattenPipeline(reviewPipeline, state.registry),
        selectSkillsForStage: vi.fn(async () => {}),
        log: SILENT_LOG,
      });
      await retry.execute({ confirm: true, kill: options.kills }, undefined as never);
    }
  }
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-events-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("review pipeline → learnings capture", () => {
  it("writes one entry per finding and gitignores the store", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "https://github.com/acme/widgets/pull/472", state.engineConfig);
    state.activeInstance = instance;

    await runReviewPipeline(state, handler, COMPOSER_FINDINGS);

    expect(state.activeInstance).toBeUndefined();

    const raw = await readFile(join(projectDir, ".lattice", "learnings.jsonl"), "utf-8");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(() => learningEntrySchema.parse(entry)).not.toThrow();
      expect(entry.source.pr).toBe("acme/widgets#472");
      expect(entry.source.stageId).toBe("propose-comments");
      expect(entry.agent).toBe("*");
    }
    const blocking = entries.filter((e: { severity: string }) => e.severity === "blocking");
    const advisory = entries.filter((e: { severity: string }) => e.severity === "advisory");
    expect(blocking).toHaveLength(2);
    expect(advisory).toHaveLength(1);

    const gitignore = await readFile(join(projectDir, ".gitignore"), "utf-8");
    expect(gitignore.split("\n")).toContain(".lattice/learnings.jsonl");
  });

  it("does not write the store when learnings.enabled is false", async () => {
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
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "PR #5", state.engineConfig);
    state.activeInstance = instance;

    await runReviewPipeline(state, handler, COMPOSER_FINDINGS);

    await expect(readFile(join(projectDir, ".lattice", "learnings.jsonl"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(projectDir, ".gitignore"), "utf-8")).rejects.toThrow();
  });

  it("completes the pipeline without writing entries when composer output is malformed", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "PR #999", state.engineConfig);
    state.activeInstance = instance;

    await runReviewPipeline(state, handler, "garbled output with no findings structure");

    expect(state.activeInstance).toBeUndefined();
    await expect(readFile(join(projectDir, ".lattice", "learnings.jsonl"), "utf-8")).rejects.toThrow();
    const persisted = JSON.parse(
      await readFile(join(projectDir, ".lattice", "state", `${instance.id}.json`), "utf-8"),
    ) as PipelineInstance;
    expect(persisted.status).toBe("completed");
  });

  it("stores kills as negative learnings and strips them from the poster's summary", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "https://github.com/acme/widgets/pull/500", state.engineConfig);
    state.activeInstance = instance;

    await runReviewPipeline(state, handler, COMPOSER_WITH_KILL_TARGETS, { kills: [2] });

    expect(state.activeInstance).toBeUndefined();
    expect(state.pendingKills).toBeUndefined();

    const raw = await readFile(join(projectDir, ".lattice", "learnings.jsonl"), "utf-8");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LearningEntry);
    const positives = entries.filter((e) => e.severity !== "negative");
    const negatives = entries.filter((e) => e.severity === "negative");
    expect(positives).toHaveLength(3);
    expect(negatives).toHaveLength(1);
    expect(negatives[0]?.agent).toBe("code-reviewer");
    expect(negatives[0]?.pattern).toBe("Overzealous refactor suggestion");
    expect(negatives[0]?.confidence).toBeCloseTo(0.7, 5);

    const persisted = JSON.parse(
      await readFile(join(projectDir, ".lattice", "state", `${instance.id}.json`), "utf-8"),
    ) as PipelineInstance;
    const propose = persisted.stages.find((s) => s.id === "propose-comments");
    expect(propose?.summary).toBeDefined();
    expect(propose?.summary).not.toContain("Overzealous refactor suggestion");
    expect(propose?.summary).toContain("Null check missing");
    expect(propose?.summary).toContain("SQL injection");
  });

  it("reinforces an existing entry instead of duplicating on re-capture", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);
    const handler = buildHandler(state, registry);

    const seeded: LearningEntry = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agent: "*",
      pattern: "Null check missing",
      category: "auth",
      severity: "blocking",
      source: { stageId: "propose-comments", date: "2026-03-01T00:00:00.000Z" },
      confidence: 0.7,
      usageCount: 1,
      feedbackScore: 0,
      reinforcementCount: 0,
      createdAt: "2026-03-01T00:00:00.000Z",
      lastSeenAt: "2026-03-01T00:00:00.000Z",
    };
    await writeAllLearnings([seeded], { projectDir, storePath: ".lattice/learnings.jsonl" });

    const flat = flattenPipeline(reviewPipeline, registry);
    const { instance } = await startPipeline(flat, "https://github.com/acme/widgets/pull/700", state.engineConfig);
    state.activeInstance = instance;

    await runReviewPipeline(state, handler, COMPOSER_FINDINGS);

    const raw = await readFile(join(projectDir, ".lattice", "learnings.jsonl"), "utf-8");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LearningEntry);

    const nullCheckEntries = entries.filter((e) => e.pattern === "Null check missing");
    expect(nullCheckEntries).toHaveLength(1);
    expect(nullCheckEntries[0]?.id).toBe(seeded.id);
    expect(nullCheckEntries[0]?.reinforcementCount).toBe(1);
    expect(nullCheckEntries[0]?.confidence).toBeGreaterThan(0.7);
  });

  it("merges duplicate entries when a pipeline starts and records the merge count on state", async () => {
    const registry = registryOf(reviewPipeline);
    const state = makeState({}, registry);

    const baseIso = "2026-03-01T00:00:00.000Z";
    const seeded: LearningEntry[] = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        agent: "*",
        pattern: "Null check missing on email",
        category: "auth",
        severity: "blocking",
        source: { stageId: "propose-comments", date: baseIso },
        confidence: 0.7,
        usageCount: 1,
        feedbackScore: 0,
        reinforcementCount: 0,
        createdAt: baseIso,
        lastSeenAt: baseIso,
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        agent: "*",
        pattern: "null email null check missing",
        category: "auth",
        severity: "blocking",
        source: { stageId: "propose-comments", date: baseIso },
        confidence: 0.6,
        usageCount: 2,
        feedbackScore: 0,
        reinforcementCount: 1,
        createdAt: baseIso,
        lastSeenAt: baseIso,
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        agent: "*",
        pattern: "Completely unrelated guard",
        category: "util",
        severity: "blocking",
        source: { stageId: "propose-comments", date: baseIso },
        confidence: 0.65,
        usageCount: 1,
        feedbackScore: 0,
        reinforcementCount: 0,
        createdAt: baseIso,
        lastSeenAt: baseIso,
      },
    ];
    await writeAllLearnings(seeded, { projectDir, storePath: ".lattice/learnings.jsonl" });

    const { createLatticeRunTool } = await import("./tools.js");
    const runTool = createLatticeRunTool({
      state,
      getFlattened: () => flattenPipeline(reviewPipeline, registry),
      selectSkillsForStage: vi.fn(async () => {}),
      log: SILENT_LOG,
    });
    await runTool.execute({ pipeline: "review", goal: "Review PR #55" }, { sessionID: "session-1" } as never);

    expect(state.lastCompactionMerged).toBe(1);
    const raw = await readFile(join(projectDir, ".lattice", "learnings.jsonl"), "utf-8");
    const remaining = raw.split("\n").filter(Boolean).length;
    expect(remaining).toBe(2);
  });
});
