import type { Plugin } from "@opencode-ai/plugin";
import {
  advancePipelineAt,
  checkStageCompletionAt,
  cleanBlockedFile,
  cleanSignals,
  effectivePipeline,
  type FlattenedPipeline,
  resolveModelOverride,
  type SessionProvider,
  saveInstance,
} from "../engine/index.js";
import type { StageTelemetry } from "../schema/index.js";
import type { createLogger } from "./logger.js";
import { completionMessage, failureMessage, pauseInstruction, pauseMessage } from "./notifications.js";
import { executeStageActions, type StageRunnerDeps } from "./stage-runner.js";

interface AssistantMessageInfo {
  sessionID?: string;
  role?: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  time?: { completed?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export function accumulateTelemetry(existing: StageTelemetry | undefined, info: AssistantMessageInfo): StageTelemetry {
  const base: StageTelemetry = existing ?? {
    tokensIn: 0,
    tokensOut: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUSD: 0,
    messageCount: 0,
  };
  return {
    ...base,
    observedModel: base.observedModel ?? info.modelID,
    observedProvider: base.observedProvider ?? info.providerID,
    model: base.model ?? base.configuredModel ?? info.modelID,
    provider: base.provider ?? base.configuredProvider ?? info.providerID,
    tokensIn: base.tokensIn + (info.tokens?.input ?? 0),
    tokensOut: base.tokensOut + (info.tokens?.output ?? 0),
    tokensReasoning: base.tokensReasoning + (info.tokens?.reasoning ?? 0),
    tokensCacheRead: base.tokensCacheRead + (info.tokens?.cache?.read ?? 0),
    tokensCacheWrite: base.tokensCacheWrite + (info.tokens?.cache?.write ?? 0),
    costUSD: base.costUSD + (info.cost ?? 0),
    messageCount: base.messageCount + 1,
  };
}

type Logger = ReturnType<typeof createLogger>;

type PluginReturn = Awaited<ReturnType<Exclude<Plugin, undefined>>>;
type EventHandler = NonNullable<PluginReturn["event"]>;

interface EventHandlerDeps extends StageRunnerDeps {
  getFlattened: (name: string) => Promise<FlattenedPipeline>;
  sessions: SessionProvider;
  log: Logger;
  scheduleCurrentStage?: () => Promise<void>;
  runExclusive?: <T>(work: () => Promise<T>) => Promise<T>;
}

function eventSessionId(event: unknown): string | undefined {
  const properties = (event as { properties?: { sessionID?: string; info?: { sessionID?: string } } }).properties;
  return properties?.sessionID ?? properties?.info?.sessionID;
}

function parentSessionId(instance: { parentSessionId?: string }, fallbackSessionId?: string): string | undefined {
  return instance.parentSessionId ?? fallbackSessionId;
}

function isParentSession(
  instance: { parentSessionId?: string },
  fallbackSessionId: string | undefined,
  incomingSessionId: string | undefined,
): boolean {
  const expected = parentSessionId(instance, fallbackSessionId);
  return !!expected && incomingSessionId === expected;
}

function runningStageIndexForSession(
  instance: {
    parentSessionId?: string;
    stages: Array<{ agent: string; sessionId?: string; status: string }>;
  },
  fallbackSessionId: string | undefined,
  incomingSessionId: string | undefined,
  agent?: string,
): number | undefined {
  const running = instance.stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.status === "running")
    .filter(({ stage }) => !agent || stage.agent === agent);

  const exact = running.find(({ stage }) => !!incomingSessionId && stage.sessionId === incomingSessionId);
  if (exact) return exact.index;

  const parent = parentSessionId(instance, fallbackSessionId);
  const shared = running.find(({ stage }) => !!parent && incomingSessionId === parent && stage.sessionId === parent);
  if (shared) return shared.index;

  const unboundChild = running.filter(
    ({ stage }) => !!agent && !!incomingSessionId && incomingSessionId !== parent && !stage.sessionId,
  );
  if (unboundChild.length === 1) return unboundChild[0]?.index;

  if (!incomingSessionId && running.length === 1) return running[0]?.index;
  return undefined;
}

function bindUntrackedChildSession(
  instance: { parentSessionId?: string },
  fallbackSessionId: string | undefined,
  stage: { sessionId?: string },
  incomingSessionId: string | undefined,
): void {
  if (!incomingSessionId || stage.sessionId) return;
  if (isParentSession(instance, fallbackSessionId, incomingSessionId)) return;
  stage.sessionId = incomingSessionId;
}

function hasPendingInSameParallelGroup(
  instance: { stages: Array<{ status: string }> },
  pipeline: FlattenedPipeline,
  stageIndex: number,
): boolean {
  const group = pipeline.stages[stageIndex]?.parallelGroup;
  if (!group) return false;
  return pipeline.stages.some(
    (stage, index) => stage.parallelGroup?.id === group.id && instance.stages[index]?.status === "pending",
  );
}

/**
 * Build the `event` plugin hook. Owns the `session.idle` processing loop —
 * advances the active pipeline, executes the next stage, and posts the right
 * status notification when the pipeline pauses, gates, fails, or completes.
 */
export function createEventHandler(deps: EventHandlerDeps): EventHandler {
  let idleQueue = Promise.resolve();

  return async ({ event }) => {
    if (event.type === "message.updated") {
      const msg = event as unknown as { properties?: { sessionID?: string; info?: AssistantMessageInfo } };
      const info = msg.properties?.info;
      // Only authoritative assistant turns carry finalised tokens/cost; partial frames have zeros.
      if (!info || info.role !== "assistant" || !info.time?.completed) return;

      const instance = deps.state.activeInstance;
      if (!instance || instance.status !== "running") return;
      const incomingSessionId = msg.properties?.sessionID ?? info.sessionID;
      const stageIndex = runningStageIndexForSession(
        instance,
        deps.state.parentSessionId,
        incomingSessionId,
        info.agent,
      );
      if (stageIndex === undefined) {
        if (isParentSession(instance, deps.state.parentSessionId, incomingSessionId)) await schedulePendingStage(deps);
        return;
      }
      const stage = instance.stages[stageIndex];
      if (!stage || stage.status !== "running") return;
      if (info.agent && info.agent !== stage.agent) return;
      bindUntrackedChildSession(instance, deps.state.parentSessionId, stage, incomingSessionId);

      if (stage.telemetry?.configuredModel && info.modelID && stage.telemetry.configuredModel !== info.modelID) {
        deps.log.warn(
          `Telemetry model mismatch for stage "${stage.id}": configured ${stage.telemetry.configuredProvider ?? ""}/${stage.telemetry.configuredModel}, observed ${info.providerID ?? ""}/${info.modelID}`,
        );
      }

      stage.telemetry = accumulateTelemetry(stage.telemetry, info);
      instance.updatedAt = new Date().toISOString();
      await saveInstance(deps.state.engineConfig.projectDir, instance);
      await handleIdle(incomingSessionId, deps);
      return;
    }

    if (event.type === "session.error") {
      const ev = event as unknown as { properties?: { sessionID?: string; error?: { data?: { message?: string } } } };
      const msg = ev.properties?.error?.data?.message;
      if (msg && msg !== "UnknownError") {
        deps.log.error(`OpenCode session error (${ev.properties?.sessionID}): ${msg}`);
      }
      return;
    }
    if (event.type === "command.executed") {
      const run = idleQueue
        .catch(() => {})
        .then(async () =>
          deps.runExclusive ? deps.runExclusive(() => schedulePendingStage(deps)) : schedulePendingStage(deps),
        );
      idleQueue = run.then(
        () => {},
        () => {},
      );
      await run;
      return;
    }

    if (event.type !== "session.idle") return;

    const run = idleQueue
      .catch(() => {})
      .then(async () =>
        deps.runExclusive
          ? deps.runExclusive(() => handleIdle(eventSessionId(event), deps))
          : handleIdle(eventSessionId(event), deps),
      );
    idleQueue = run.then(
      () => {},
      () => {},
    );
    await run;
  };
}

async function schedulePendingStage(deps: EventHandlerDeps): Promise<void> {
  const instance = deps.state.activeInstance;
  if (!instance || instance.status !== "running") return;
  const parentSessionId = deps.state.parentSessionId ?? instance.parentSessionId;
  if (!parentSessionId) return;

  if (deps.scheduleCurrentStage) {
    await deps.scheduleCurrentStage();
    return;
  }

  const staticFlat = await deps.getFlattened(instance.pipelineName);
  await executeStageActions(instance, parentSessionId, staticFlat, deps);
}

async function handleIdle(sessionId: string | undefined, deps: EventHandlerDeps): Promise<void> {
  const instance = deps.state.activeInstance;
  if (!instance || instance.status !== "running") return;

  try {
    const staticFlat = await deps.getFlattened(instance.pipelineName);
    const flat = effectivePipeline(instance, staticFlat);

    const stageIndex = runningStageIndexForSession(instance, deps.state.parentSessionId, sessionId);
    if (stageIndex === undefined) {
      if (!isParentSession(instance, deps.state.parentSessionId, sessionId)) return;
      if (deps.scheduleCurrentStage) {
        await deps.scheduleCurrentStage();
      } else {
        const parent = deps.state.parentSessionId ?? instance.parentSessionId;
        if (parent) await executeStageActions(instance, parent, staticFlat, deps);
      }
      return;
    }

    const currentStage = instance.stages[stageIndex];
    if (!currentStage) return;
    bindUntrackedChildSession(instance, deps.state.parentSessionId, currentStage, sessionId);

    if (currentStage.status === "dispatching") return;

    if (currentStage.status !== "running") return;

    const parentSessionIdBeforeAdvance = deps.state.parentSessionId ?? instance.parentSessionId;
    const completedInParentSession = !currentStage.sessionId || currentStage.sessionId === parentSessionIdBeforeAdvance;
    const completion = await checkStageCompletionAt(instance, flat, deps.state.engineConfig, stageIndex);
    if (!completion.complete) return;

    deps.log.info(`Stage "${currentStage.id}" complete: ${completion.summary ?? "done"}`);

    await cleanBlockedFile(deps.state.engineConfig.projectDir);

    const result = await advancePipelineAt(instance, flat, deps.state.engineConfig, completion, stageIndex);
    deps.state.activeInstance = result.instance;

    if (result.diagnostics) {
      for (const msg of result.diagnostics) {
        deps.log.warn(msg);
      }
    }

    if (result.instance.status === "running") {
      const parentSessionId = deps.state.parentSessionId ?? result.instance.parentSessionId;
      if (hasPendingInSameParallelGroup(result.instance, flat, stageIndex) && parentSessionId) {
        if (deps.scheduleCurrentStage) {
          await deps.scheduleCurrentStage();
        } else {
          await executeStageActions(result.instance, parentSessionId, flat, deps);
        }
      } else if (!completedInParentSession) {
        deps.log.info("Waiting for parent session idle before dispatching the next stage");
      } else if (deps.scheduleCurrentStage) {
        await deps.scheduleCurrentStage();
      } else {
        if (parentSessionId) await executeStageActions(result.instance, parentSessionId, flat, deps);
      }
    }

    const buildModel = resolveModelOverride(deps.latticeConfig, "build");
    const parentSessionId = deps.state.parentSessionId ?? result.instance.parentSessionId;

    if (result.pause && parentSessionId) {
      deps.log.info(`Pipeline paused: ${result.pause.kind} at ${result.pause.stageId}`);
      await deps.sessions.injectPrompt(
        parentSessionId,
        "build",
        pauseMessage(instance.pipelineName, result.pause),
        buildModel,
        pauseInstruction(instance.pipelineName, result.pause),
      );
    }

    if (result.instance.status === "completed") {
      await cleanSignals(deps.state.engineConfig.projectDir, result.instance.id);
      await cleanBlockedFile(deps.state.engineConfig.projectDir);
      deps.log.info(`Pipeline "${instance.pipelineName}" completed`);

      if (parentSessionId) {
        await deps.sessions.notify(parentSessionId, completionMessage(result.instance)).catch(() => {});
      }

      deps.state.activeInstance = undefined;
    }
  } catch (err) {
    deps.log.error(`Pipeline error: ${err}`);
    const currentStage = instance.stages[instance.currentStageIndex];
    instance.status = "failed";
    instance.updatedAt = new Date().toISOString();
    if (currentStage) {
      currentStage.status = "failed";
      currentStage.summary = `Error: ${err}`;
    }
    await saveInstance(deps.state.engineConfig.projectDir, instance);
    deps.state.activeInstance = undefined;

    const parentSessionId = deps.state.parentSessionId ?? instance.parentSessionId;
    if (parentSessionId) {
      await deps.sessions.injectPrompt(
        parentSessionId,
        "build",
        failureMessage(instance.pipelineName, currentStage?.id, err),
        resolveModelOverride(deps.latticeConfig, "build"),
      );
    }
  }
}
