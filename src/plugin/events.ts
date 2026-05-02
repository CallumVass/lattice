import type { Plugin } from "@opencode-ai/plugin";
import {
  advancePipeline,
  checkStageCompletion,
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
import { executeStageAction, type StageRunnerDeps } from "./stage-runner.js";

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
}

function eventSessionId(event: unknown): string | undefined {
  const properties = (event as { properties?: { sessionID?: string; info?: { sessionID?: string } } }).properties;
  return properties?.sessionID ?? properties?.info?.sessionID;
}

function currentStageSessionId(
  instance: { parentSessionId?: string; currentStageIndex: number; stages: Array<{ sessionId?: string }> },
  fallbackSessionId?: string,
): string | undefined {
  return instance.stages[instance.currentStageIndex]?.sessionId ?? instance.parentSessionId ?? fallbackSessionId;
}

function isCurrentStageSession(
  instance: { parentSessionId?: string; currentStageIndex: number; stages: Array<{ sessionId?: string }> },
  fallbackSessionId: string | undefined,
  incomingSessionId: string | undefined,
): boolean {
  const expected = currentStageSessionId(instance, fallbackSessionId);
  return !expected || incomingSessionId === expected;
}

/**
 * Build the `event` plugin hook. Owns the `session.idle` processing loop —
 * advances the active pipeline, executes the next stage, and posts the right
 * status notification when the pipeline pauses, gates, fails, or completes.
 */
export function createEventHandler(deps: EventHandlerDeps): EventHandler {
  let processing = false;

  return async ({ event }) => {
    if (event.type === "message.updated") {
      const msg = event as unknown as { properties?: { sessionID?: string; info?: AssistantMessageInfo } };
      const info = msg.properties?.info;
      // Only authoritative assistant turns carry finalised tokens/cost; partial frames have zeros.
      if (!info || info.role !== "assistant" || !info.time?.completed) return;

      const instance = deps.state.activeInstance;
      if (!instance || instance.status !== "running") return;
      const stage = instance.stages[instance.currentStageIndex];
      if (!stage || stage.status !== "running") return;
      if (!isCurrentStageSession(instance, deps.state.parentSessionId, msg.properties?.sessionID ?? info.sessionID))
        return;
      if (info.agent && info.agent !== stage.agent) return;

      if (stage.telemetry?.configuredModel && info.modelID && stage.telemetry.configuredModel !== info.modelID) {
        deps.log.warn(
          `Telemetry model mismatch for stage "${stage.id}": configured ${stage.telemetry.configuredProvider ?? ""}/${stage.telemetry.configuredModel}, observed ${info.providerID ?? ""}/${info.modelID}`,
        );
      }

      stage.telemetry = accumulateTelemetry(stage.telemetry, info);
      instance.updatedAt = new Date().toISOString();
      await saveInstance(deps.state.engineConfig.projectDir, instance);
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
    if (event.type !== "session.idle") return;
    const sessionId = eventSessionId(event);

    const instance = deps.state.activeInstance;
    if (!instance || instance.status !== "running") return;
    if (!isCurrentStageSession(instance, deps.state.parentSessionId, sessionId)) return;
    if (processing) return;
    processing = true;

    try {
      const currentStage = instance.stages[instance.currentStageIndex];
      if (!currentStage) return;

      const staticFlat = await deps.getFlattened(instance.pipelineName);
      let flat = effectivePipeline(instance, staticFlat);

      if (currentStage.status === "pending") {
        if (deps.scheduleCurrentStage) {
          await deps.scheduleCurrentStage();
        } else {
          const parentSessionId = deps.state.parentSessionId ?? instance.parentSessionId;
          if (parentSessionId) {
            await executeStageAction(instance, parentSessionId, staticFlat, deps);
            flat = effectivePipeline(instance, staticFlat);
          }
        }
        return;
      }

      if (currentStage.status === "dispatching") return;

      if (currentStage.status !== "running") return;

      const parentSessionIdBeforeAdvance = deps.state.parentSessionId ?? instance.parentSessionId;
      const completedInParentSession =
        !currentStage.sessionId || currentStage.sessionId === parentSessionIdBeforeAdvance;
      const completion = await checkStageCompletion(instance, flat, deps.state.engineConfig);
      if (!completion.complete) return;

      deps.log.info(`Stage "${currentStage.id}" complete: ${completion.summary ?? "done"}`);

      await cleanBlockedFile(deps.state.engineConfig.projectDir);

      const result = await advancePipeline(instance, flat, deps.state.engineConfig, completion);
      deps.state.activeInstance = result.instance;

      if (result.diagnostics) {
        for (const msg of result.diagnostics) {
          deps.log.warn(msg);
        }
      }

      if (result.instance.status === "running") {
        if (!completedInParentSession) {
          deps.log.info("Waiting for parent session idle before dispatching the next stage");
        } else if (deps.scheduleCurrentStage) {
          await deps.scheduleCurrentStage();
        } else {
          const parentSessionId = deps.state.parentSessionId ?? result.instance.parentSessionId;
          if (parentSessionId) await executeStageAction(result.instance, parentSessionId, flat, deps);
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
    } finally {
      processing = false;
    }
  };
}
