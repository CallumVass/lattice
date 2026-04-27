import { rm } from "node:fs/promises";
import { join } from "node:path";
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
import type { PipelineInstance, StageTelemetry } from "../schema/index.js";
import type { createLogger } from "./logger.js";
import {
  completionMessage,
  customGateMessage,
  failureMessage,
  gateMessage,
  hardGateMessage,
  pauseMessage,
  postHookPauseMessage,
} from "./notifications.js";
import { type PostHookRunner, runPostHook, waitForWorkspaceSettled } from "./post-hook.js";
import { executeStageAction, type StageRunnerDeps } from "./stage-runner.js";

interface AssistantMessageInfo {
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
  /** Overridable for tests. Defaults to the real shell runner. */
  postHookRunner?: PostHookRunner;
  /** Quiet window before/after completion hooks. Defaults to LATTICE_COMPLETION_SETTLE_MS or 5000ms. */
  completionSettleMs?: number;
}

function completionSettleMs(deps: EventHandlerDeps): number {
  if (deps.completionSettleMs !== undefined) return deps.completionSettleMs;
  const configured = Number(process.env.LATTICE_COMPLETION_SETTLE_MS ?? "5000");
  return Number.isFinite(configured) && configured >= 0 ? configured : 5000;
}

function postHookFeedbackPrompt(command: string, output: string): string {
  return [
    `Post-hook command \`${command}\` failed after this stage signalled completion. Its output:`,
    "",
    "```",
    output,
    "```",
    "",
    "Fix the issue, then signal completion again. Do not hand off until the post-hook passes.",
  ].join("\n");
}

/**
 * Execute the stage's post-hook. Returns `true` when the handler should stop
 * processing this idle event — either because a retry feedback prompt was
 * injected or because the pipeline was paused after retry exhaustion. Returns
 * `false` when the hook passed and the caller should keep advancing.
 */
async function runPostHookForStage(
  instance: PipelineInstance,
  stageId: string,
  postHook: { commands: string[]; maxRetries: number },
  fork: boolean,
  deps: EventHandlerDeps,
): Promise<boolean> {
  const runner = deps.postHookRunner ?? runPostHook;
  const projectDir = deps.state.engineConfig.projectDir;
  const parentSessionId = deps.state.parentSessionId;
  const settleMs = completionSettleMs(deps);

  const beforeHook = await waitForWorkspaceSettled({ cwd: projectDir, quietMs: settleMs });
  if (!beforeHook.settled) {
    deps.log.warn(`Workspace did not settle before post-hook for "${stageId}"; running hook against latest files`);
  }

  // Surface a start notification so the user sees why the pipeline has gone
  // quiet — without this, post-hooks (dotnet build, tests, cdk synth) can
  // silently block for 2-5 minutes with nothing in the chat.
  if (parentSessionId && postHook.commands.length > 0) {
    const list = postHook.commands.map((c, i) => `  ${i + 1}. \`${c}\``).join("\n");
    await deps.sessions
      .notify(
        parentSessionId,
        [
          `**Lattice:** running post-hook for stage \`${stageId}\` (${postHook.commands.length} commands):`,
          "",
          list,
        ].join("\n"),
      )
      .catch(() => {});
  }

  let result = await runner({
    commands: postHook.commands,
    cwd: projectDir,
    onCommandStart: async (command, index, total) => {
      if (parentSessionId) {
        await deps.sessions
          .notify(parentSessionId, `**Lattice:** [${index + 1}/${total}] \`${command}\``)
          .catch(() => {});
      }
      deps.log.info(`Post-hook [${index + 1}/${total}] for "${stageId}": ${command}`);
    },
  });

  if (result.ok) {
    const afterHook = await waitForWorkspaceSettled({ cwd: projectDir, quietMs: settleMs });
    if (!afterHook.settled) {
      deps.log.warn(`Workspace did not settle after post-hook for "${stageId}"; re-running hook once`);
    }
    if (afterHook.latestMtimeMs > beforeHook.latestMtimeMs) {
      deps.log.warn(`Workspace changed during/after post-hook for "${stageId}"; re-running hook once`);
      result = await runner({
        commands: postHook.commands,
        cwd: projectDir,
        onCommandStart: async (command, index, total) => {
          if (parentSessionId) {
            await deps.sessions
              .notify(parentSessionId, `**Lattice:** recheck [${index + 1}/${total}] \`${command}\``)
              .catch(() => {});
          }
          deps.log.info(`Post-hook recheck [${index + 1}/${total}] for "${stageId}": ${command}`);
        },
      });
    }
  }

  if (result.ok) {
    if (parentSessionId) {
      await deps.sessions
        .notify(parentSessionId, `**Lattice:** post-hook for \`${stageId}\` passed. Advancing pipeline.`)
        .catch(() => {});
    }
    return false;
  }

  const currentStage = instance.stages[instance.currentStageIndex];
  if (!currentStage) return false;

  const used = currentStage.postHookRetriesUsed ?? 0;
  const signalPath = join(projectDir, ".lattice", "signals", `${stageId}.json`);

  if (used < postHook.maxRetries) {
    currentStage.postHookRetriesUsed = used + 1;
    instance.updatedAt = new Date().toISOString();
    await rm(signalPath, { force: true });
    await saveInstance(projectDir, instance);

    deps.log.warn(`Post-hook failed for "${stageId}" (retry ${used + 1}/${postHook.maxRetries}): ${result.command}`);

    if (deps.state.parentSessionId) {
      // Route the retry through the same path the stage used initially:
      // subtask stages (fork: false) must retry as a subtask — otherwise
      // opencode spawns a parent-session prompt that looks like a brand-new
      // agent session to the user. fork: true stages continue in-session
      // via injectPrompt.
      const retryModel = resolveModelOverride(deps.latticeConfig, currentStage.agent);
      const feedback = postHookFeedbackPrompt(result.command, result.output);

      if (fork) {
        await deps.sessions.injectPrompt(deps.state.parentSessionId, currentStage.agent, feedback, retryModel);
      } else {
        await deps.sessions.injectSubtask(
          deps.state.parentSessionId,
          currentStage.agent,
          feedback,
          `Lattice: ${stageId} (post-hook retry ${used + 1}/${postHook.maxRetries})`,
          retryModel,
        );
      }
    }
    return true;
  }

  currentStage.status = "rejected";
  currentStage.verdict = "reject";
  currentStage.completedAt = new Date().toISOString();
  currentStage.summary = `Post-hook \`${result.command}\` failed after ${postHook.maxRetries} retries.\n${result.output}`;
  instance.status = "paused";
  instance.updatedAt = new Date().toISOString();
  await rm(signalPath, { force: true });
  await saveInstance(projectDir, instance);

  deps.log.warn(`Post-hook for "${stageId}" exhausted retries, pausing pipeline`);

  if (deps.state.parentSessionId) {
    await deps.sessions.injectPrompt(
      deps.state.parentSessionId,
      "build",
      postHookPauseMessage(instance.pipelineName, stageId, result.command, result.output),
      resolveModelOverride(deps.latticeConfig, "build"),
    );
  }
  return true;
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
      const msg = event as unknown as { properties?: { info?: AssistantMessageInfo } };
      const info = msg.properties?.info;
      // Only authoritative assistant turns carry finalised tokens/cost; partial frames have zeros.
      if (!info || info.role !== "assistant" || !info.time?.completed) return;

      const instance = deps.state.activeInstance;
      if (!instance || instance.status !== "running") return;
      const stage = instance.stages[instance.currentStageIndex];
      if (!stage || stage.status !== "running") return;
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

    const instance = deps.state.activeInstance;
    if (!instance || instance.status !== "running") return;
    if (processing) return;
    processing = true;

    try {
      const currentStage = instance.stages[instance.currentStageIndex];
      if (!currentStage) return;

      const staticFlat = await deps.getFlattened(instance.pipelineName);
      let flat = effectivePipeline(instance, staticFlat);

      if (currentStage.status === "pending") {
        if (deps.state.parentSessionId) {
          await executeStageAction(instance, deps.state.parentSessionId, staticFlat, deps);
          flat = effectivePipeline(instance, staticFlat);
        }
        return;
      }

      if (currentStage.status !== "running") return;

      const completion = await checkStageCompletion(instance, flat, deps.state.engineConfig);
      if (!completion.complete) return;

      deps.log.info(`Stage "${currentStage.id}" complete: ${completion.summary ?? "done"}`);

      const stageDef = flat.stages[instance.currentStageIndex];
      if (stageDef?.postHook) {
        const hookHandled = await runPostHookForStage(
          instance,
          currentStage.id,
          stageDef.postHook,
          stageDef.fork ?? false,
          deps,
        );
        if (hookHandled) return;
      }

      await cleanBlockedFile(deps.state.engineConfig.projectDir);

      const result = await advancePipeline(instance, flat, deps.state.engineConfig, completion);
      deps.state.activeInstance = result.instance;

      if (result.diagnostics) {
        for (const msg of result.diagnostics) {
          deps.log.warn(msg);
        }
      }

      if (result.instance.status === "running" && deps.state.parentSessionId) {
        await executeStageAction(result.instance, deps.state.parentSessionId, flat, deps);
      }

      const buildModel = resolveModelOverride(deps.latticeConfig, "build");

      if (result.pauseReason && deps.state.parentSessionId) {
        deps.log.warn(`Pipeline paused: ${result.pauseReason}`);
        await deps.sessions.injectPrompt(
          deps.state.parentSessionId,
          "build",
          pauseMessage(instance.pipelineName, result.pauseReason),
          buildModel,
        );
      }

      if (result.gateReason && deps.state.parentSessionId) {
        deps.log.info(`Pipeline gated: ${result.gateReason}${result.hardGate ? " [hard gate]" : ""}`);
        const nextStage = result.instance.stages[result.instance.currentStageIndex];
        const message = result.customGatePrompt
          ? customGateMessage(instance.pipelineName, result.customGatePrompt, result.hardGate === true)
          : result.hardGate
            ? hardGateMessage(instance.pipelineName, result.gateReason, nextStage?.id)
            : gateMessage(instance.pipelineName, result.gateReason, nextStage?.id);
        await deps.sessions.injectPrompt(deps.state.parentSessionId, "build", message, buildModel);
      }

      if (result.instance.status === "completed") {
        await cleanSignals(deps.state.engineConfig.projectDir);
        await cleanBlockedFile(deps.state.engineConfig.projectDir);
        deps.log.info(`Pipeline "${instance.pipelineName}" completed`);

        if (deps.state.parentSessionId) {
          await deps.sessions.notify(deps.state.parentSessionId, completionMessage(result.instance)).catch(() => {});
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
          resolveModelOverride(deps.latticeConfig, "build"),
        );
      }
    } finally {
      processing = false;
    }
  };
}
