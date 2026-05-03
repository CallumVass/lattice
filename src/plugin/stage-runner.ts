import type { EngineConfig, FlattenedPipeline, SessionProvider } from "../engine/index.js";
import {
  buildStageAction,
  buildStageActions,
  expandCurrentStageIfNeeded,
  expandRunnableStagesIfNeeded,
  markStageDispatching,
  markStageDispatchingAt,
  markStageRunning,
  markStageRunningAt,
  resolveModelOverride,
  saveInstance,
} from "../engine/index.js";
import type { LatticeConfig, PipelineInstance } from "../schema/index.js";
import { type DiscoveredSkill, type ScoringProvider, selectSkills } from "../skills/index.js";
import type { createLogger } from "./logger.js";
import type { PluginState } from "./state.js";
import { type SkillStore, stageSkillKey } from "./system-transform.js";

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
  const activeStage = activeInstance?.stages.find((stage) => stage.id === stageId);
  const stageKey = activeInstance && activeStage ? stageSkillKey(activeInstance, stageId) : undefined;

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

interface PreparedAction {
  action: NonNullable<ReturnType<typeof buildStageAction>>;
  progress: string;
  modelOverride: ReturnType<typeof resolveModelOverride>;
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

  const progress = stageProgress(instance, action.stageIndex);

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
      seedConfiguredTelemetry(instance, action.stageIndex, modelOverride);
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
      seedConfiguredTelemetry(instance, action.stageIndex, modelOverride);
      await markStageRunning(instance, deps.engineConfig, result.sessionId);
      if (result.sessionId)
        deps.skillStore.applyStageToSession(stageSkillKey(instance, action.stageId), result.sessionId);
      deps.log.info(`${progress} Subtask "${action.stageId}" (agent: ${action.agent})`);
    }
  } catch (error) {
    await failDispatch(instance, deps.engineConfig, action.stageIndex, error);
    throw error;
  }
}

export async function executeStageActions(
  instance: PipelineInstance,
  parentSessionId: string,
  pipeline: FlattenedPipeline,
  deps: StageRunnerDeps,
): Promise<void> {
  const effective = await expandRunnableStagesIfNeeded(instance, pipeline, deps.engineConfig);
  const actions = buildStageActions(instance, effective);
  if (actions.length === 0) return;

  const prepared: PreparedAction[] = [];
  for (const action of actions) {
    const dispatchId = await markStageDispatchingAt(instance, deps.engineConfig, action.stageIndex, parentSessionId);
    if (!dispatchId) continue;

    const progress = stageProgress(instance, action.stageIndex);
    const modelOverride = resolveModelOverride(deps.latticeConfig, action.agent);
    if (modelOverride) {
      deps.log.info(
        `${progress} Model override for ${action.agent}: ${modelOverride.providerID}/${modelOverride.modelID}`,
      );
    }
    prepared.push({ action, progress, modelOverride });
  }

  if (prepared.length === 0) return;

  try {
    for (const item of prepared) {
      await selectSkillsForStage(
        parentSessionId,
        effective,
        item.action.stageId,
        item.action.agent,
        instance.goal,
        deps,
      );
    }

    const injectActions = prepared.filter((item) => item.action.type === "inject");
    const subtaskActions = prepared.filter((item) => item.action.type === "subtask");

    for (const item of injectActions) {
      await deps.sessions.injectPrompt(parentSessionId, item.action.agent, item.action.prompt, item.modelOverride);
      seedConfiguredTelemetry(instance, item.action.stageIndex, item.modelOverride);
      await markStageRunningAt(instance, deps.engineConfig, item.action.stageIndex, parentSessionId);
      deps.log.info(`${item.progress} Stage "${item.action.stageId}" (agent: ${item.action.agent})`);
    }

    if (subtaskActions.length === 1) {
      const item = subtaskActions[0];
      if (!item) return;
      const result = await deps.sessions.injectSubtask(
        parentSessionId,
        item.action.agent,
        item.action.prompt,
        `${item.progress} Lattice: ${item.action.stageId}`,
        item.modelOverride,
      );
      seedConfiguredTelemetry(instance, item.action.stageIndex, item.modelOverride);
      await markStageRunningAt(instance, deps.engineConfig, item.action.stageIndex, result.sessionId);
      if (result.sessionId)
        deps.skillStore.applyStageToSession(stageSkillKey(instance, item.action.stageId), result.sessionId);
      deps.log.info(`${item.progress} Subtask "${item.action.stageId}" (agent: ${item.action.agent})`);
    } else {
      for (const item of subtaskActions) {
        const result = await deps.sessions.injectSubtask(
          parentSessionId,
          item.action.agent,
          item.action.prompt,
          `${item.progress} Lattice: ${item.action.stageId}`,
          item.modelOverride,
        );
        seedConfiguredTelemetry(instance, item.action.stageIndex, item.modelOverride);
        await markStageRunningAt(instance, deps.engineConfig, item.action.stageIndex, result?.sessionId);
        if (result?.sessionId) {
          deps.skillStore.applyStageToSession(stageSkillKey(instance, item.action.stageId), result.sessionId);
        }
        deps.log.info(`${item.progress} Subtask "${item.action.stageId}" (agent: ${item.action.agent})`);
      }
    }
  } catch (error) {
    for (const item of prepared) {
      await failDispatch(instance, deps.engineConfig, item.action.stageIndex, error);
    }
    throw error;
  }
}

async function failDispatch(
  instance: PipelineInstance,
  engineConfig: EngineConfig,
  stageIndex: number,
  error: unknown,
): Promise<void> {
  const stage = instance.stages[stageIndex];
  if (stage) {
    stage.status = "failed";
    stage.completedAt = new Date().toISOString();
    stage.summary = `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  instance.status = "failed";
  instance.updatedAt = new Date().toISOString();
  await saveInstance(engineConfig.projectDir, instance);
}

function stageProgress(instance: PipelineInstance, stageIndex: number): string {
  return `[${stageIndex + 1}/${instance.stages.length}]`;
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
  stageIndex: number,
  modelOverride: ReturnType<typeof resolveModelOverride>,
): void {
  if (!modelOverride) return;

  const stage = instance.stages[stageIndex];
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
