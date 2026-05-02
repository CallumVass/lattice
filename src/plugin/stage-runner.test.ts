import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import {
  type EngineConfig,
  flattenPipeline,
  type PipelineRegistry,
  type SessionProvider,
  startPipeline,
} from "../engine/index.js";
import type { LatticeConfig } from "../schema/index.js";
import type { DiscoveredSkill, ScoringProvider } from "../skills/index.js";
import { executeStageAction, selectSkillsForStage } from "./stage-runner.js";
import type { PluginState } from "./state.js";
import { activeStageSkillKey, SkillStore } from "./system-transform.js";

let projectDir: string;

const NO_OP_SESSIONS: SessionProvider = {
  injectPrompt: vi.fn(async () => {}),
  injectSubtask: vi.fn(async () => ({})),
  notify: vi.fn(async () => {}),
  getLastAssistantMessage: vi.fn(async () => ""),
};

const SILENT_LOG = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeRegistry() {
  const def = pipeline("sample", {
    stages: [
      stage("plan", {
        agent: "planner",
        completion: "signal",
        signals: ["complete"],
        skills: { dynamic: false, pinned: ["tdd"], max: 2 },
      }),
    ],
  });
  const registry: PipelineRegistry = new Map();
  registry.set(def.name, def);
  return { registry, def };
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

function scoringProvider(order: string[]): ScoringProvider {
  return {
    scoreSkills: vi.fn(async () => JSON.stringify(order.map((name, index) => ({ name, score: 1 - index / 10 })))),
  };
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-stage-runner-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("selectSkillsForStage", () => {
  it("stores pinned skills for the stage", async () => {
    const { registry, def } = makeRegistry();
    const state = makeState({}, registry);
    const flat = flattenPipeline(def, registry);
    const skillStore = new SkillStore();

    const discovered: DiscoveredSkill[] = [
      { name: "tdd", description: "TDD", filePath: "/x/tdd.md", content: "Test first." },
      { name: "other", description: "Other", filePath: "/x/other.md", content: "Other stuff." },
    ];

    await selectSkillsForStage("session-1", flat, "plan", "planner", "build feature", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: discovered,
      scoringProvider: scoringProvider(["tdd"]),
      skillStore,
      state,
      log: SILENT_LOG,
    });

    const selected = skillStore.get("session-1");
    expect(selected.map((s) => s.name)).toContain("tdd");
  });

  it("writes nothing when latticeConfig.skills.disabled is true", async () => {
    const { registry, def } = makeRegistry();
    const state = makeState({ skills: { disabled: true } }, registry);
    const flat = flattenPipeline(def, registry);
    const skillStore = new SkillStore();
    const provider = scoringProvider(["tdd"]);

    await selectSkillsForStage("session-1", flat, "plan", "planner", "build feature", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: { skills: { disabled: true } },
      discoveredSkills: [{ name: "tdd", description: "", filePath: "/x/tdd.md", content: "" }],
      scoringProvider: provider,
      skillStore,
      state,
      log: SILENT_LOG,
    });

    expect(skillStore.get("session-1")).toEqual([]);
    expect(provider.scoreSkills).not.toHaveBeenCalled();
  });

  it("swallows scoring errors on dynamic stages and writes nothing", async () => {
    const def = pipeline("dynamic", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "signal",
          signals: ["complete"],
          skills: { dynamic: true, max: 2 },
        }),
      ],
    });
    const registry: PipelineRegistry = new Map([[def.name, def]]);
    const state = makeState({}, registry);
    const flat = flattenPipeline(def, registry);
    const skillStore = new SkillStore();
    const provider: ScoringProvider = {
      scoreSkills: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await selectSkillsForStage("session-1", flat, "plan", "planner", "build feature", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [{ name: "tdd", description: "", filePath: "/x/tdd.md", content: "" }],
      scoringProvider: provider,
      skillStore,
      state,
      log: SILENT_LOG,
    });

    expect(skillStore.get("session-1")).toEqual([]);
    expect(SILENT_LOG.warn).toHaveBeenCalled();
  });

  it("stores selected skills under the active stage key", async () => {
    const { registry, def } = makeRegistry();
    const state = makeState({}, registry);
    const flat = flattenPipeline(def, registry);
    const { instance } = await startPipeline(flat, "build feature", state.engineConfig);
    state.activeInstance = instance;
    const skillStore = new SkillStore();

    await selectSkillsForStage("session-1", flat, "plan", "planner", "build feature", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [{ name: "tdd", description: "TDD", filePath: "/x/tdd.md", content: "Test first." }],
      scoringProvider: scoringProvider(["tdd"]),
      skillStore,
      state,
      log: SILENT_LOG,
    });

    skillStore.applyStageToSession(activeStageSkillKey(instance), "child-session");

    expect(skillStore.get("child-session").map((s) => s.name)).toEqual(["tdd"]);
  });

  it("clears stale session skills when a stage selects none", async () => {
    const def = pipeline("plain", {
      stages: [stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] })],
    });
    const registry: PipelineRegistry = new Map([[def.name, def]]);
    const state = makeState({}, registry);
    const flat = flattenPipeline(def, registry);
    const skillStore = new SkillStore();
    skillStore.set("session-1", [{ name: "old", description: "Old", filePath: "/x/old.md", content: "Old." }]);

    await selectSkillsForStage("session-1", flat, "plan", "planner", "build feature", {
      sessions: NO_OP_SESSIONS,
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [{ name: "old", description: "Old", filePath: "/x/old.md", content: "Old." }],
      scoringProvider: scoringProvider([]),
      skillStore,
      state,
      log: SILENT_LOG,
    });

    expect(skillStore.get("session-1")).toEqual([]);
  });

  it("selects skills before dispatching a shared stage prompt", async () => {
    const def = pipeline("shared", {
      stages: [
        stage("plan", {
          agent: "planner",
          completion: "signal",
          signals: ["complete"],
          context: "shared",
          skills: { pinned: ["tdd"] },
        }),
      ],
    });
    const registry: PipelineRegistry = new Map([[def.name, def]]);
    const state = makeState({}, registry);
    const flat = flattenPipeline(def, registry);
    const { instance } = await startPipeline(flat, "build feature", state.engineConfig);
    state.activeInstance = instance;
    const skillStore = new SkillStore();
    const injectPrompt = vi.fn<SessionProvider["injectPrompt"]>(async () => {
      expect(skillStore.get("session-1").map((s) => s.name)).toEqual(["tdd"]);
    });

    await executeStageAction(instance, "session-1", flat, {
      sessions: { ...NO_OP_SESSIONS, injectPrompt },
      engineConfig: state.engineConfig,
      latticeConfig: {},
      discoveredSkills: [{ name: "tdd", description: "TDD", filePath: "/x/tdd.md", content: "Test first." }],
      scoringProvider: scoringProvider(["tdd"]),
      skillStore,
      state,
      log: SILENT_LOG,
    });

    expect(injectPrompt).toHaveBeenCalledOnce();
    expect(instance.stages[0]?.status).toBe("running");
  });
});
