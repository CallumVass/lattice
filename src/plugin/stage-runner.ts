import type { EngineConfig, FlattenedPipeline, SessionProvider } from "../engine/index.js";
import {
  buildStageAction,
  expandCurrentStageIfNeeded,
  markStageDispatching,
  markStageRunning,
  resolveModelOverride,
  saveInstance,
} from "../engine/index.js";
import type { LatticeConfig, PipelineInstance } from "../schema/index.js";
import { type DiscoveredSkill, type ScoringProvider, selectSkills } from "../skills/index.js";
import type { createLogger } from "./logger.js";
import type { PluginState } from "./state.js";
import { activeStageSkillKey, type SkillStore } from "./system-transform.js";

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
  const activeInstance = deps.state.activeInstance;
  const activeStage = activeInstance?.stages[activeInstance.currentStageIndex];
  const stageKey = activeStage?.id === stageId ? activeStageSkillKey(activeInstance) : undefined;

  const store = (skills: DiscoveredSkill[]) => {
    deps.skillStore.set(sessionId, skills);
    if (stageKey) deps.skillStore.setStage(stageKey, skills);
  };

  if (deps.latticeConfig.skills?.disabled) {
    store([]);
    return;
  }

  const stageDef = pipeline.stages.find((s) => s.id === stageId);
  const stageOverride = deps.latticeConfig.pipelines?.[pipeline.name]?.stages?.[stageId]?.skills;
  const agentOverride = deps.latticeConfig.agents?.[agent]?.skills;
  const skillsConfig = mergeSkillsConfig(agentOverride, stageDef?.skills, stageOverride);

  try {
    const selected = await selectSkills(
      deps.discoveredSkills,
      {
        skillsConfig,
        defaultMax: deps.latticeConfig.skills?.max ?? 4,
        goal,
        agent,
        stageId,
        stagePrompt: stageDef?.prompt,
      },
      deps.scoringProvider,
    );

    store(selected);
    if (skillsConfig?.dynamic && selected.length > 0) {
      deps.log.info(`Skills for ${stageId}: ${selected.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    store([]);
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
  const effective = await expandCurrentStageIfNeeded(instance, pipeline, deps.engineConfig);
  const action = buildStageAction(instance, effective);
  if (!action) return;

  const dispatchId = await markStageDispatching(instance, deps.engineConfig, parentSessionId);
  if (!dispatchId) return;

  const stageIndex = (instance.stages.findIndex((s) => s.id === action.stageId) ?? 0) + 1;
  const progress = `[${stageIndex}/${instance.stages.length}]`;

  const modelOverride = resolveModelOverride(deps.latticeConfig, action.agent);
  if (modelOverride) {
    deps.log.info(
      `${progress} Model override for ${action.agent}: ${modelOverride.providerID}/${modelOverride.modelID}`,
    );
  }

  try {
    await selectSkillsForStage(parentSessionId, effective, action.stageId, action.agent, instance.goal, deps);

    if (action.type === "inject") {
      await deps.sessions.injectPrompt(parentSessionId, action.agent, action.prompt, modelOverride);
      seedConfiguredTelemetry(instance, modelOverride);
      await markStageRunning(instance, deps.engineConfig, parentSessionId);
      deps.log.info(`${progress} Stage "${action.stageId}" (agent: ${action.agent})`);
    } else {
      const result = await deps.sessions.injectSubtask(
        parentSessionId,
        action.agent,
        action.prompt,
        `${progress} Lattice: ${action.stageId}`,
        modelOverride,
      );
      seedConfiguredTelemetry(instance, modelOverride);
      await markStageRunning(instance, deps.engineConfig, result.sessionId);
      deps.log.info(`${progress} Subtask "${action.stageId}" (agent: ${action.agent})`);
    }
  } catch (error) {
    await failDispatch(instance, deps.engineConfig, error);
    throw error;
  }
}

async function failDispatch(instance: PipelineInstance, engineConfig: EngineConfig, error: unknown): Promise<void> {
  const stage = instance.stages[instance.currentStageIndex];
  if (stage) {
    stage.status = "failed";
    stage.completedAt = new Date().toISOString();
    stage.summary = `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  instance.status = "failed";
  instance.updatedAt = new Date().toISOString();
  await saveInstance(engineConfig.projectDir, instance);
}

function mergeSkillsConfig(
  ...configs: Array<Parameters<typeof selectSkills>[1]["skillsConfig"]>
): Parameters<typeof selectSkills>[1]["skillsConfig"] | undefined {
  let merged: Parameters<typeof selectSkills>[1]["skillsConfig"] | undefined;
  for (const config of configs) {
    if (!config) continue;
    merged = merged ?? {};
    Object.assign(merged, config);
  }
  return merged;
}

function seedConfiguredTelemetry(
  instance: PipelineInstance,
  modelOverride: ReturnType<typeof resolveModelOverride>,
): void {
  if (!modelOverride) return;

  const stage = instance.stages[instance.currentStageIndex];
  if (!stage) return;

  stage.telemetry = {
    tokensIn: stage.telemetry?.tokensIn ?? 0,
    tokensOut: stage.telemetry?.tokensOut ?? 0,
    tokensReasoning: stage.telemetry?.tokensReasoning ?? 0,
    tokensCacheRead: stage.telemetry?.tokensCacheRead ?? 0,
    tokensCacheWrite: stage.telemetry?.tokensCacheWrite ?? 0,
    costUSD: stage.telemetry?.costUSD ?? 0,
    messageCount: stage.telemetry?.messageCount ?? 0,
    configuredModel: stage.telemetry?.configuredModel ?? modelOverride.modelID,
    configuredProvider: stage.telemetry?.configuredProvider ?? modelOverride.providerID,
    model: stage.telemetry?.model ?? modelOverride.modelID,
    provider: stage.telemetry?.provider ?? modelOverride.providerID,
  };
}
