import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin/tool";
import { tool } from "@opencode-ai/plugin/tool";
import { cleanSignals, effectivePipeline, saveInstance, startPipeline } from "../engine/index.js";
import type { PipelineInstance, PipelinePause, SignalVerdict, StageInstance } from "../schema/index.js";
import type { PluginState } from "./state.js";

interface ToolDeps {
  state: PluginState;
  getFlattened: (name: string) => Promise<ReturnType<typeof import("../engine/flattener.js").flattenPipeline>>;
  selectSkillsForStage: (sessionId: string, stageId: string, agent: string, goal: string) => Promise<void>;
  scheduleCurrentStage?: () => Promise<void>;
  log: Logger;
}

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const CONTROL_ACTIONS = ["status", "run", "continue", "retry", "accept", "abort", "reset"] as const;

function formatStatus(instance: PipelineInstance | undefined): string {
  const lines: string[] = [];

  if (!instance) return "No active pipeline.";

  lines.push(`Pipeline: ${instance.pipelineName} (${instance.status})`, `Goal: ${instance.goal}`);
  if (instance.pause) {
    lines.push(
      `Pause: ${instance.pause.kind} at ${instance.pause.stageId}${instance.pause.reason ? ` - ${instance.pause.reason}` : ""}`,
    );
  }
  for (const s of instance.stages) {
    const marker =
      s.status === "running"
        ? "→"
        : s.status === "dispatching"
          ? "…"
          : s.status === "completed"
            ? "✓"
            : s.status === "skipped"
              ? "-"
              : s.status === "rejected"
                ? "✗"
                : " ";
    lines.push(`${marker} ${s.id} (${s.agent}): ${s.status}${s.summary ? ` - ${s.summary}` : ""}`);
  }

  return lines.join("\n");
}

function clearStageForRetry(stage: StageInstance | undefined): void {
  if (!stage) return;
  stage.status = "pending";
  stage.sessionId = undefined;
  stage.dispatchId = undefined;
  stage.dispatchedAt = undefined;
  stage.startedAt = undefined;
  stage.completedAt = undefined;
  stage.summary = undefined;
  stage.verdict = undefined;
}

function nextRunnableStageIndex(instance: PipelineInstance, start: number): number {
  let index = start;
  while (index < instance.stages.length && instance.stages[index]?.status === "skipped") {
    index++;
  }
  return index;
}

function parallelGroupRange(
  flat: Awaited<ReturnType<ToolDeps["getFlattened"]>>,
  stageIndex: number,
): { start: number; end: number } {
  const group = flat.stages[stageIndex]?.parallelGroup;
  if (!group) return { start: stageIndex, end: stageIndex + 1 };

  let start = stageIndex;
  while (start > 0 && flat.stages[start - 1]?.parallelGroup?.id === group.id) start--;

  let end = stageIndex + 1;
  while (end < flat.stages.length && flat.stages[end]?.parallelGroup?.id === group.id) end++;

  return { start, end };
}

function activeStageIndexForSignal(instance: PipelineInstance, context: ToolContext): number | undefined {
  const active = instance.stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.status === "running" || stage.status === "dispatching")
    .filter(({ stage }) => !context.agent || stage.agent === context.agent);

  const exact = active.find(({ stage }) => !!context.sessionID && stage.sessionId === context.sessionID);
  if (exact) return exact.index;

  const shared = active.find(
    ({ stage }) =>
      !!context.sessionID &&
      context.sessionID === instance.parentSessionId &&
      (!stage.sessionId || stage.sessionId === instance.parentSessionId),
  );
  if (shared) return shared.index;

  return active.length === 1 ? active[0]?.index : undefined;
}

function pausedStageIndex(instance: PipelineInstance): number | undefined {
  const pausedStageId = instance.pause?.stageId;
  if (!pausedStageId) return undefined;
  const index = instance.stages.findIndex((stage) => stage.id === pausedStageId);
  return index === -1 ? undefined : index;
}

function missingPauseMetadataMessage(): string {
  return "Pipeline is paused but has no valid pause metadata. Use `/lattice status` or `/lattice abort`.";
}

function rememberControlSession(
  state: PluginState,
  instance: PipelineInstance,
  context: ToolContext,
): string | undefined {
  const sessionId = context.sessionID ?? instance.parentSessionId ?? state.parentSessionId;
  if (context.sessionID) {
    state.parentSessionId = context.sessionID;
    instance.parentSessionId = context.sessionID;
  } else if (sessionId) {
    state.parentSessionId = sessionId;
  }
  return sessionId;
}

function missingControlSessionMessage(): string {
  return "No control session is available for this pipeline. Run the command again from an OpenCode chat session.";
}

async function runPipeline(
  deps: ToolDeps,
  args: { pipeline?: string; goal?: string },
  context: ToolContext,
): Promise<string> {
  const { state, getFlattened, log } = deps;
  const pipeline = args.pipeline?.trim();
  const goal = args.goal?.trim();

  if (!pipeline) return "Missing pipeline name. Use `/lattice run <pipeline> <goal>`.";
  if (!goal) return "Missing goal. Use `/lattice run <pipeline> <goal>`.";

  if (!state.registry.has(pipeline)) {
    return `Unknown pipeline "${pipeline}". Available: ${[...state.registry.keys()].join(", ")}`;
  }

  if (state.activeInstance && (state.activeInstance.status === "running" || state.activeInstance.status === "paused")) {
    return `Pipeline "${state.activeInstance.pipelineName}" is ${state.activeInstance.status}. Use \`/lattice status\` or \`/lattice abort\` first.`;
  }

  try {
    if (!context.sessionID) return missingControlSessionMessage();
    await cleanSignals(state.engineConfig.projectDir);
    const flat = await getFlattened(pipeline);
    state.parentSessionId = context.sessionID;
    const result = await startPipeline(flat, goal, state.engineConfig, context.sessionID);
    state.activeInstance = result.instance;
    log.info(`Started pipeline "${pipeline}" - goal: ${goal}`);

    const stageList = flat.stages.map((s) => s.id).join(" -> ");
    return `Pipeline "${pipeline}" started. Stages: ${stageList}. The first stage will begin when this control turn is idle.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to start pipeline: ${msg}`);
    return `Failed to start pipeline: ${msg}`;
  }
}

async function continuePipeline(deps: ToolDeps, response: string | undefined, context: ToolContext): Promise<string> {
  const { state, log } = deps;
  const instance = state.activeInstance;
  if (!instance || instance.status !== "paused") return "No paused pipeline to continue.";
  if (!instance.pause) return missingPauseMetadataMessage();
  if (instance.pause?.kind !== "checkpoint") {
    return `Pipeline is paused for ${instance.pause?.kind ?? "unknown reason"}; use \`/lattice retry\` or \`/lattice accept\`.`;
  }
  if (!rememberControlSession(state, instance, context)) return missingControlSessionMessage();

  instance.status = "running";
  instance.pause = undefined;
  instance.updatedAt = new Date().toISOString();
  instance.resumeContext = response?.trim() || undefined;
  await cleanSignals(state.engineConfig.projectDir, instance.id);
  await saveInstance(state.engineConfig.projectDir, instance);
  const resumingId = instance.stages[instance.currentStageIndex]?.id ?? "?";
  log.info(`Continuing pipeline at stage "${resumingId}"`);
  return `Continuing pipeline at stage "${resumingId}". The stage will begin when this control turn is idle.`;
}

async function retryPipeline(deps: ToolDeps, response: string | undefined, context: ToolContext): Promise<string> {
  const { state, log, getFlattened } = deps;
  const instance = state.activeInstance;
  if (!instance || instance.status !== "paused") return "No paused pipeline to retry.";
  if (!instance.pause) return missingPauseMetadataMessage();

  if (instance.pause?.kind === "checkpoint") {
    return "This pause is a checkpoint, not a failure. Use `/lattice continue [message]`.";
  }
  if (!rememberControlSession(state, instance, context)) return missingControlSessionMessage();

  if (instance.pause?.kind === "stuck") {
    instance.status = "running";
    instance.pause = undefined;
    instance.resumeContext = response?.trim() || undefined;
    instance.updatedAt = new Date().toISOString();
    await cleanSignals(state.engineConfig.projectDir, instance.id);
    await saveInstance(state.engineConfig.projectDir, instance);
    return `Restarting stage "${instance.stages[instance.currentStageIndex]?.id ?? "?"}". The stage will begin when this control turn is idle.`;
  }

  const failedIndex = pausedStageIndex(instance);
  if (failedIndex === undefined) return missingPauseMetadataMessage();

  const flat = effectivePipeline(instance, await getFlattened(instance.pipelineName));
  let retryIndex = failedIndex;
  for (let i = failedIndex - 1; i >= 0; i--) {
    if (flat.stages[i]?.isRewindTarget) {
      retryIndex = i;
      break;
    }
  }

  if (retryIndex === failedIndex && flat.stages[failedIndex]?.parallelGroup) {
    retryIndex = parallelGroupRange(flat, failedIndex).start;
  }

  const targetDef = flat.stages[retryIndex];
  const targetInst = instance.stages[retryIndex];
  const cap = targetDef?.maxRewinds;
  if (cap !== undefined && targetInst) {
    const used = targetInst.rewindsUsed ?? 0;
    if (used >= cap) {
      log.warn(`lattice retry refused - stage "${targetInst.id}" exhausted rewind cap (${used}/${cap})`);
      return [
        `Stage "${targetInst.id}" has exhausted its rewind cap (${used}/${cap}).`,
        "Pipeline remains paused.",
        "Use `/lattice accept [reason]` to accept and advance, or `/lattice abort` to cancel.",
      ].join("\n");
    }
    targetInst.rewindsUsed = used + 1;
  }

  for (let i = retryIndex; i < instance.stages.length; i++) {
    const stage = instance.stages[i];
    clearStageForRetry(stage);
    if (stage && i !== retryIndex) stage.rewindsUsed = undefined;
  }

  instance.status = "running";
  instance.currentStageIndex = retryIndex;
  instance.pause = undefined;
  instance.updatedAt = new Date().toISOString();
  instance.resumeContext = response?.trim() || undefined;

  await cleanSignals(state.engineConfig.projectDir, instance.id);
  await saveInstance(state.engineConfig.projectDir, instance);

  log.info(`Retrying from stage "${instance.stages[retryIndex]?.id}"`);
  return `Retrying from stage "${instance.stages[retryIndex]?.id}". The stage will begin when this control turn is idle.`;
}

async function acceptPause(deps: ToolDeps, reason: string | undefined, context: ToolContext): Promise<string> {
  const { state, log, getFlattened } = deps;
  const instance = state.activeInstance;
  if (!instance || instance.status !== "paused") return "No paused pipeline to accept.";
  if (!instance.pause) return missingPauseMetadataMessage();
  if (instance.pause?.kind === "checkpoint") return "This pause is a checkpoint. Use `/lattice continue [message]`.";
  if (instance.pause?.kind === "stuck") {
    return "This pause is a stuck-stage recovery. Use `/lattice retry` to restart it or `/lattice abort` to cancel.";
  }
  if (!rememberControlSession(state, instance, context)) return missingControlSessionMessage();

  const acceptedIndex = pausedStageIndex(instance);
  if (acceptedIndex === undefined) return missingPauseMetadataMessage();

  const accepted = instance.stages[acceptedIndex];
  if (!accepted) return "No paused stage to accept.";

  accepted.status = "completed";
  accepted.verdict = "pass";
  accepted.summary = [accepted.summary ?? "", "", `[accepted by user${reason ? `: ${reason}` : ""}]`].join("\n").trim();
  accepted.completedAt = new Date().toISOString();

  const flat = effectivePipeline(instance, await getFlattened(instance.pipelineName));
  const groupRange = parallelGroupRange(flat, acceptedIndex);
  if (flat.stages[acceptedIndex]?.parallelGroup) {
    for (let index = groupRange.start; index < groupRange.end; index++) {
      const stage = instance.stages[index];
      if (!stage || index === acceptedIndex || stage.status === "completed" || stage.status === "skipped") continue;
      stage.status = "skipped";
      stage.completedAt = new Date().toISOString();
      stage.summary = `Skipped after user accepted "${accepted.id}".`;
    }
  }

  const advanceIndex = nextRunnableStageIndex(instance, groupRange.end);
  instance.currentStageIndex = advanceIndex;
  instance.pause = undefined;
  instance.updatedAt = new Date().toISOString();
  instance.resumeContext = reason?.trim() || undefined;

  await cleanSignals(state.engineConfig.projectDir, instance.id);

  const advancedTo = instance.stages[advanceIndex]?.id;
  if (!advancedTo) {
    instance.status = "completed";
    await saveInstance(state.engineConfig.projectDir, instance);
    state.activeInstance = undefined;
    log.info(`Accepted "${accepted.id}"; pipeline completed`);
    return `Accepted stage "${accepted.id}". Pipeline completed.`;
  }

  instance.status = "running";
  await saveInstance(state.engineConfig.projectDir, instance);
  log.info(`Accepted "${accepted.id}"; advancing to "${advancedTo}"`);
  return `Accepted stage "${accepted.id}". Advancing to "${advancedTo}" when this control turn is idle.`;
}

async function abortPipeline(deps: ToolDeps): Promise<string> {
  const { state, log } = deps;
  const instance = state.activeInstance;
  if (!instance) return "No active pipeline to abort.";

  instance.status = "failed";
  instance.pause = undefined;
  instance.updatedAt = new Date().toISOString();
  const running = instance.stages.filter((s) => s.status === "running" || s.status === "dispatching");
  for (const stage of running) {
    stage.status = "failed";
    stage.completedAt = new Date().toISOString();
    stage.summary = "Aborted by user";
  }

  await saveInstance(state.engineConfig.projectDir, instance);
  await cleanSignals(state.engineConfig.projectDir, instance.id);
  log.info(`Pipeline "${instance.pipelineName}" aborted`);
  state.activeInstance = undefined;
  return `Pipeline "${instance.pipelineName}" aborted.`;
}

async function resetPipeline(deps: ToolDeps): Promise<string> {
  const { state, log, getFlattened } = deps;
  const instance = state.activeInstance;
  if (!instance) return "No active pipeline to reset.";
  if (instance.status !== "running") {
    return `Pipeline is ${instance.status}, not running. Use \`/lattice retry\`, \`/lattice continue\`, or \`/lattice abort\`.`;
  }

  const flat = effectivePipeline(instance, await getFlattened(instance.pipelineName));
  const range = parallelGroupRange(flat, instance.currentStageIndex);
  const resetStages = instance.stages.slice(range.start, range.end).filter((stage) => {
    return stage.status === "running" || stage.status === "dispatching";
  });
  const stuck = resetStages[0] ?? instance.stages[instance.currentStageIndex];
  for (const stage of resetStages.length > 0 ? resetStages : [stuck]) clearStageForRetry(stage);

  const pause: PipelinePause = {
    kind: "stuck",
    stageId: stuck?.id ?? "?",
    reason: `Stage "${stuck?.id ?? "?"}" was reset and can be restarted with /lattice retry.`,
  };

  instance.status = "paused";
  instance.pause = pause;
  instance.updatedAt = new Date().toISOString();

  await cleanSignals(state.engineConfig.projectDir, instance.id);
  await saveInstance(state.engineConfig.projectDir, instance);

  const label = resetStages.length > 1 ? `${resetStages.length} parallel stages` : `stage "${stuck?.id ?? "?"}"`;
  log.info(`Pipeline "${instance.pipelineName}" reset - ${label} returned to pending`);
  return `Pipeline "${instance.pipelineName}" reset. ${label} pending; use \`/lattice retry\` to restart it.`;
}

export function createLatticeControlTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Control lattice pipelines. Use this single tool for status, run, continue, retry, accept, abort, and reset actions. " +
      "Pipeline stages advance automatically after run/continue/retry/accept when appropriate.",
    args: {
      action: tool.schema.enum(CONTROL_ACTIONS).describe("Control action to perform."),
      pipeline: tool.schema.string().optional().describe("Pipeline name for action 'run'."),
      goal: tool.schema.string().optional().describe("Pipeline goal for action 'run'."),
      response: tool.schema.string().optional().describe("User guidance for continue/retry."),
      reason: tool.schema.string().optional().describe("Reason for accepting a failed/blocked stage."),
    },
    async execute(args, context) {
      if (args.action === "status") return formatStatus(deps.state.activeInstance);
      if (args.action === "run") return runPipeline(deps, args, context);

      if (args.action === "continue") return continuePipeline(deps, args.response, context);
      if (args.action === "retry") return retryPipeline(deps, args.response, context);
      if (args.action === "accept") return acceptPause(deps, args.reason, context);
      if (args.action === "abort") return abortPipeline(deps);
      if (args.action === "reset") return resetPipeline(deps);
      return `Unsupported lattice action: ${args.action}`;
    },
  });
}

export function createLatticeSignalTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Signal the lattice pipeline engine with the current stage outcome. " +
      "Use 'pass' for a passing review/verdict, 'fail' for a failing review/verdict, 'blocked' when the stage cannot continue, or 'complete' for ordinary successful completion.",
    args: {
      status: tool.schema.enum(["complete", "pass", "fail", "blocked"]).describe("The stage outcome"),
      reason: tool.schema.string().optional().describe("Brief explanation of the outcome"),
    },
    async execute(args, context) {
      const instance = deps.state.activeInstance;
      if (!instance) return "No active pipeline.";
      if (instance.status !== "running") return `Pipeline is ${instance.status}; no running stage can be signalled.`;

      const stageIndex = activeStageIndexForSignal(instance, context);
      if (stageIndex === undefined) {
        const active = instance.stages.filter((stage) => stage.status === "running" || stage.status === "dispatching");
        const only = active.length === 1 ? active[0] : undefined;
        if (only?.sessionId && context.sessionID && context.sessionID !== only.sessionId) {
          return `Signal refused: current stage "${only.id}" is running in session "${only.sessionId}", not "${context.sessionID}".`;
        }
        if (only && context.agent && context.agent !== only.agent) {
          return `Signal refused: current stage "${only.id}" uses agent "${only.agent}", not "${context.agent}".`;
        }
        return "No running stage matches this signal context.";
      }
      const currentStage = instance.stages[stageIndex];
      if (!currentStage || (currentStage.status !== "running" && currentStage.status !== "dispatching")) {
        return "No running stage to signal.";
      }

      const flat = effectivePipeline(instance, await deps.getFlattened(instance.pipelineName));
      const stageDef = flat.stages[stageIndex];
      if (!stageDef || stageDef.completion !== "signal") {
        return `Signal refused: current stage "${currentStage.id}" does not use signal completion.`;
      }
      if (!stageDef.signals?.includes(args.status as SignalVerdict)) {
        return `Signal refused: status "${args.status}" is not declared for stage "${currentStage.id}". Declared signals: ${stageDef.signals?.join(", ") ?? "(none)"}.`;
      }

      if (currentStage.status === "dispatching") {
        currentStage.status = "running";
        currentStage.startedAt = currentStage.startedAt ?? new Date().toISOString();
        if (context.sessionID) currentStage.sessionId = context.sessionID;
        instance.updatedAt = new Date().toISOString();
        await saveInstance(deps.state.engineConfig.projectDir, instance);
      }

      const signalsDir = join(deps.state.engineConfig.projectDir, ".lattice", "signals", instance.id);
      await mkdir(signalsDir, { recursive: true });
      await writeFile(
        join(signalsDir, `${currentStage.id}.json`),
        JSON.stringify({ status: args.status, reason: args.reason }),
      );

      return `Signal recorded: ${args.status}${args.reason ? ` - ${args.reason}` : ""}`;
    },
  });
}
