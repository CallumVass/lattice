import type { Plugin } from "@opencode-ai/plugin";
import {
  advancePipeline,
  checkStageCompletion,
  cleanBlockedFile,
  cleanSignals,
  type FlattenedPipeline,
  type SessionProvider,
  saveInstance,
} from "../engine/index.js";
import type { createLogger } from "./logger.js";
import { completionMessage, failureMessage, gateMessage, pauseMessage } from "./notifications.js";
import { executeStageAction, type StageRunnerDeps } from "./stage-runner.js";

type Logger = ReturnType<typeof createLogger>;

type PluginReturn = Awaited<ReturnType<Exclude<Plugin, undefined>>>;
type EventHandler = NonNullable<PluginReturn["event"]>;

interface EventHandlerDeps extends StageRunnerDeps {
  getFlattened: (name: string) => FlattenedPipeline;
  sessions: SessionProvider;
  log: Logger;
}

/**
 * Build the `event` plugin hook. Owns the `session.idle` processing loop —
 * advances the active pipeline, executes the next stage, and posts the right
 * status notification when the pipeline pauses, gates, fails, or completes.
 */
export function createEventHandler(deps: EventHandlerDeps): EventHandler {
  let processing = false;

  return async ({ event }) => {
    if (event.type === "session.error") {
      const ev = event as unknown as { properties?: { sessionID?: string; error?: { data?: { message?: string } } } };
      const msg = ev.properties?.error?.data?.message;
      if (msg && msg !== "UnknownError") {
        deps.log.error(`OpenCode session error (${ev.properties?.sessionID}): ${msg}`);
      }
      return;
    }
    if (event.type !== "session.idle") return;

    const instance = deps.state.activeInstance;
    if (!instance || instance.status !== "running") return;
    if (processing) return;
    processing = true;

    try {
      const currentStage = instance.stages[instance.currentStageIndex];
      if (!currentStage) return;

      const flat = deps.getFlattened(instance.pipelineName);

      if (currentStage.status === "pending") {
        if (deps.state.parentSessionId) {
          await executeStageAction(instance, deps.state.parentSessionId, flat, deps);
        }
        return;
      }

      if (currentStage.status !== "running") return;

      const completion = await checkStageCompletion(instance, flat, deps.state.engineConfig);
      if (!completion.complete) return;

      deps.log.info(`Stage "${currentStage.id}" complete: ${completion.summary ?? "done"}`);
      await cleanBlockedFile(deps.state.engineConfig.projectDir);

      const result = await advancePipeline(instance, flat, deps.state.engineConfig, completion);
      deps.state.activeInstance = result.instance;

      if (result.instance.status === "running" && deps.state.parentSessionId) {
        await executeStageAction(result.instance, deps.state.parentSessionId, flat, deps);
      }

      if (result.pauseReason && deps.state.parentSessionId) {
        deps.log.warn(`Pipeline paused: ${result.pauseReason}`);
        await deps.sessions.injectPrompt(
          deps.state.parentSessionId,
          "build",
          pauseMessage(instance.pipelineName, result.pauseReason),
        );
      }

      if (result.gateReason && deps.state.parentSessionId) {
        deps.log.info(`Pipeline gated: ${result.gateReason}`);
        const nextStage = result.instance.stages[result.instance.currentStageIndex];
        await deps.sessions.injectPrompt(
          deps.state.parentSessionId,
          "build",
          gateMessage(instance.pipelineName, result.gateReason, nextStage?.id),
        );
      }

      if (result.instance.status === "completed") {
        await cleanSignals(deps.state.engineConfig.projectDir);
        await cleanBlockedFile(deps.state.engineConfig.projectDir);
        deps.log.info(`Pipeline "${instance.pipelineName}" completed`);

        if (deps.state.parentSessionId) {
          await deps.sessions.injectPrompt(deps.state.parentSessionId, "build", completionMessage(result.instance));
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

      if (deps.state.parentSessionId) {
        await deps.sessions.injectPrompt(
          deps.state.parentSessionId,
          "build",
          failureMessage(instance.pipelineName, currentStage?.id, err),
        );
      }
    } finally {
      processing = false;
    }
  };
}
