import type { EngineConfig, FlattenedPipeline, SessionProvider } from "../engine/index.js";
import { buildStageAction, markStageRunning, resolveModelOverride } from "../engine/index.js";
import type { LatticeConfig, PipelineInstance } from "../schema/index.js";
import { type DiscoveredSkill, type ScoringProvider, selectSkills } from "../skills/index.js";
import type { createLogger } from "./logger.js";
import type { PluginState } from "./state.js";
import type { SkillStore } from "./system-transform.js";

type Logger = ReturnType<typeof createLogger>;

export interface StageRunnerDeps {
  sessions: SessionProvider;
  engineConfig: EngineConfig;
  latticeConfig: LatticeConfig;
  discoveredSkills: DiscoveredSkill[];
  scoringProvider: ScoringProvider;
  skillStore: SkillStore;
  state: PluginState;
  log: Logger;
}

/** Decide and record which skills should be injected into the given stage's session. */
export async function selectSkillsForStage(
  sessionId: string,
  pipeline: FlattenedPipeline,
  stageId: string,
  agent: string,
  goal: string,
  deps: StageRunnerDeps,
): Promise<void> {
  if (deps.latticeConfig.skills?.disabled) return;

  const stageDef = pipeline.stages.find((s) => s.id === stageId);

  try {
    const selected = await selectSkills(
      deps.discoveredSkills,
      {
        skillsConfig: stageDef?.skills,
        defaultMax: deps.latticeConfig.skills?.max ?? 4,
        goal,
        agent,
        stageId,
      },
      deps.scoringProvider,
    );

    if (selected.length === 0) return;
    deps.skillStore.set(sessionId, selected);
    if (stageDef?.skills?.dynamic) {
      deps.log.info(`Skills for ${stageId}: ${selected.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    deps.log.warn(`Skill selection failed for ${stageId}: ${err}`);
  }
}

/** Execute the pending stage's action — inject prompt or subtask, then mark running. */
export async function executeStageAction(
  instance: PipelineInstance,
  parentSessionId: string,
  pipeline: FlattenedPipeline,
  deps: StageRunnerDeps,
): Promise<void> {
  const action = buildStageAction(instance, pipeline);
  if (!action) return;

  const stageIndex = (instance.stages.findIndex((s) => s.id === action.stageId) ?? 0) + 1;
  const progress = `[${stageIndex}/${instance.stages.length}]`;

  const modelOverride = resolveModelOverride(deps.latticeConfig, action.agent);
  if (modelOverride) {
    deps.log.info(
      `${progress} Model override for ${action.agent}: ${modelOverride.providerID}/${modelOverride.modelID}`,
    );
  }

  if (action.type === "inject") {
    await deps.sessions.injectPrompt(parentSessionId, action.agent, action.prompt, modelOverride);
    await markStageRunning(instance, deps.engineConfig);
    deps.log.info(`${progress} Stage "${action.stageId}" (agent: ${action.agent})`);
  } else {
    await deps.sessions.injectSubtask(
      parentSessionId,
      action.agent,
      action.prompt,
      `${progress} Lattice: ${action.stageId}`,
      modelOverride,
    );
    await markStageRunning(instance, deps.engineConfig);
    deps.log.info(`${progress} Subtask "${action.stageId}" (agent: ${action.agent})`);
  }

  await selectSkillsForStage(parentSessionId, pipeline, action.stageId, action.agent, instance.goal, deps);
}
