import type { EngineConfig, FlattenedPipeline, SessionProvider } from "../engine/index.js";
import { buildStageAction, markStageRunning } from "../engine/index.js";
import {
  type ResolvedLearningsConfig,
  readAllLearnings,
  renderLearningsAsSkill,
  resolveLearningsConfig,
  selectLearningsForAgent,
} from "../learnings/index.js";
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

/**
 * Load, rank, and render learnings as a synthetic skill for the given agent.
 * Returns `undefined` when learnings are disabled, the agent is not covered
 * by the config, or no entries survive the filter. Failures are swallowed so
 * learnings never break a pipeline run — they are best-effort context.
 */
async function buildLearningsSkill(
  agent: string,
  goal: string,
  stageId: string,
  config: ResolvedLearningsConfig,
  deps: StageRunnerDeps,
): Promise<DiscoveredSkill | undefined> {
  if (!config.enabled) return undefined;
  if (!config.agents.includes(agent) && !config.agents.includes("*")) return undefined;

  try {
    const entries = await readAllLearnings({
      projectDir: deps.engineConfig.projectDir,
      storePath: config.storePath,
    });
    if (entries.length === 0) return undefined;

    const selected = await selectLearningsForAgent(
      entries,
      {
        agent,
        goal,
        stageId,
        maxPerAgent: config.maxPerAgent,
        confidenceThreshold: config.confidenceThreshold,
      },
      deps.scoringProvider,
    );
    if (selected.length === 0) return undefined;

    const skill = renderLearningsAsSkill(selected);
    if (!skill) return undefined;

    deps.log.info(`Learnings loaded: ${selected.length} entries`);
    deps.state.learningsInjected += selected.length;
    return skill;
  } catch (err) {
    deps.log.warn(`Learnings injection failed for ${stageId}: ${err}`);
    return undefined;
  }
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
  const stageDef = pipeline.stages.find((s) => s.id === stageId);
  const learningsConfig = resolveLearningsConfig(deps.engineConfig);

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

    const learningsSkill = await buildLearningsSkill(agent, goal, stageId, learningsConfig, deps);
    const combined = learningsSkill ? [learningsSkill, ...selected] : selected;

    if (combined.length === 0) return;
    deps.skillStore.set(sessionId, combined);
    if (stageDef?.skills?.dynamic) {
      deps.log.info(`Skills for ${stageId}: ${combined.map((s) => s.name).join(", ")}`);
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

  if (action.type === "inject") {
    await deps.sessions.injectPrompt(parentSessionId, action.agent, action.prompt);
    await markStageRunning(instance, deps.engineConfig);
    deps.log.info(`${progress} Stage "${action.stageId}" (agent: ${action.agent})`);
  } else {
    await deps.sessions.injectSubtask(
      parentSessionId,
      action.agent,
      action.prompt,
      `${progress} Lattice: ${action.stageId}`,
    );
    await markStageRunning(instance, deps.engineConfig);
    deps.log.info(`${progress} Subtask "${action.stageId}" (agent: ${action.agent})`);
  }

  await selectSkillsForStage(parentSessionId, pipeline, action.stageId, action.agent, instance.goal, deps);
}
