import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import { tool } from "@opencode-ai/plugin/tool";
import { cleanSignals, effectivePipeline, saveInstance, startPipeline } from "../engine/index.js";
import type { PipelineInstance } from "../schema/index.js";
import type { PluginState } from "./state.js";

interface ToolDeps {
  state: PluginState;
  getFlattened: (name: string) => Promise<ReturnType<typeof import("../engine/flattener.js").flattenPipeline>>;
  selectSkillsForStage: (sessionId: string, stageId: string, agent: string, goal: string) => Promise<void>;
  scheduleCurrentStage?: () => Promise<void>;
  log: Logger;
}

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

/** How long a user-typed /lattice-retry or /lattice-approve slash-command token stays valid as a hard-gate release. */
const HARD_GATE_TOKEN_TTL_MS = 60_000;

/**
 * Release a pauseAfter gate and resume the pipeline at the next stage.
 * Shared by `lattice_retry` (back-compat path) and `lattice_approve`.
 * Enforces the hard-gate token check when `instance.hardGated === true`.
 */
async function releaseGatePause(
  instance: PipelineInstance,
  response: string | undefined,
  projectDir: string,
  log: Logger,
  toolName: "lattice_retry" | "lattice_approve",
  scheduleCurrentStage?: () => Promise<void>,
): Promise<string> {
  if (instance.hardGated === true) {
    const token = instance.userRetryToken;
    const freshMs = token ? Date.now() - Date.parse(token.issuedAt) : Number.POSITIVE_INFINITY;
    if (!token || !Number.isFinite(freshMs) || freshMs > HARD_GATE_TOKEN_TTL_MS) {
      log.warn(`${toolName} refused at hard gate — no fresh /lattice-retry or /lattice-approve command observed`);
      return [
        "This pause is a hard gate. Hard gates are released only by a user-typed `/lattice-approve`",
        "(or `/lattice-retry`) slash command in the opencode TUI — not by an orchestrator tool call.",
        "",
        "Tell the user: type `/lattice-approve` to proceed, or `/lattice-abort` to cancel.",
        "Do not retry this tool without that signal.",
      ].join("\n");
    }
    instance.userRetryToken = undefined;
    instance.hardGated = undefined;
  }

  instance.status = "running";
  instance.updatedAt = new Date().toISOString();
  instance.pendingResponse = response;
  await cleanSignals(projectDir);
  await saveInstance(projectDir, instance);
  const resumingId = instance.stages[instance.currentStageIndex]?.id ?? "?";
  log.info(`Resuming from gate at stage "${resumingId}" (${toolName})`);
  await scheduleCurrentStage?.();
  return `Resuming pipeline at stage "${resumingId}".`;
}

export function createLatticeRunTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Start a lattice pipeline. The pipeline runs as a sequence of agent stages. " +
      "Do NOT take any implementation actions yourself — the pipeline agents handle everything. " +
      "Do NOT call lattice_signal or lattice_status after starting — the pipeline advances automatically.",
    args: {
      pipeline: tool.schema.string().describe("Pipeline name (must match a discovered pipeline definition)"),
      goal: tool.schema.string().describe("What to analyze, implement, or review (issue number, URL, or description)"),
    },
    async execute(args, context) {
      const { state, getFlattened, log } = deps;

      if (!state.registry.has(args.pipeline)) {
        return `Unknown pipeline "${args.pipeline}". Available: ${[...state.registry.keys()].join(", ")}`;
      }

      if (
        state.activeInstance &&
        (state.activeInstance.status === "running" || state.activeInstance.status === "paused")
      ) {
        return `Pipeline "${state.activeInstance.pipelineName}" is ${state.activeInstance.status}. Use lattice_abort first.`;
      }

      try {
        await cleanSignals(state.engineConfig.projectDir);
        const flat = await getFlattened(args.pipeline);
        state.parentSessionId = context.sessionID;
        const result = await startPipeline(flat, args.goal, state.engineConfig);
        state.activeInstance = result.instance;

        log.info(`Started pipeline "${args.pipeline}" — goal: ${args.goal}`);

        const stageList = flat.stages.map((s) => s.id).join(" → ");
        return `Pipeline "${args.pipeline}" started. Stages: ${stageList}. The first stage will begin automatically. Do NOT call any other lattice tools — the pipeline advances on its own.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to start pipeline: ${msg}`);
        return `Failed to start pipeline: ${msg}`;
      }
    },
  });
}

export function createLatticeStatusTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description: "Show the current lattice pipeline status.",
    args: {},
    async execute() {
      const lines: string[] = [];
      const instance = deps.state.activeInstance;

      if (instance) {
        lines.push(`Pipeline: ${instance.pipelineName} (${instance.status})`, `Goal: ${instance.goal}`);
        for (const s of instance.stages) {
          const marker =
            s.status === "running"
              ? "→"
              : s.status === "completed"
                ? "✓"
                : s.status === "skipped"
                  ? "-"
                  : s.status === "rejected"
                    ? "✗"
                    : " ";
          lines.push(`${marker} ${s.id} (${s.agent}): ${s.status}${s.summary ? ` — ${s.summary}` : ""}`);
        }
      } else {
        lines.push("No active pipeline.");
      }

      return lines.join("\n");
    },
  });
}

export function createLatticeAbortTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Abort the currently running lattice pipeline. " +
      "USER-INITIATED ONLY — do NOT call this in response to an injected pipeline status message. " +
      "The `confirm` argument must be `true`.",
    args: {
      confirm: tool.schema.boolean().describe("Must be true. Set only when the user has explicitly asked to abort."),
    },
    async execute(args) {
      const { state, log } = deps;
      if (args.confirm !== true) {
        return "lattice_abort requires confirm: true. This tool is user-initiated only — the user will decide whether to abort.";
      }
      const instance = state.activeInstance;
      if (!instance) return "No active pipeline to abort.";

      instance.status = "failed";
      instance.updatedAt = new Date().toISOString();
      const running = instance.stages.find((s) => s.status === "running");
      if (running) {
        running.status = "failed";
        running.completedAt = new Date().toISOString();
        running.summary = "Aborted by user";
      }

      await saveInstance(state.engineConfig.projectDir, instance);
      await cleanSignals(state.engineConfig.projectDir);
      log.info(`Pipeline "${instance.pipelineName}" aborted`);
      state.activeInstance = undefined;
      return `Pipeline "${instance.pipelineName}" aborted.`;
    },
  });
}

export function createLatticeRetryTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Retry a paused lattice pipeline. Loops back to the nearest implementor stage (so it can address review findings) or resumes from a gated pause. " +
      "Use this when you want the pipeline to fix the issue that caused the pause. " +
      "To instead ACCEPT a review's findings and advance PAST the rejected stage without changes, use `lattice_proceed`. " +
      "USER-INITIATED ONLY — do NOT call this tool in response to an injected pipeline-paused status message. " +
      "The `confirm` argument must be `true`; it exists to prevent accidental auto-retry when the orchestrator reads a pause notification. " +
      "Pass the user's clarifying reply as `response` so the retried stage can act on it.",
    args: {
      confirm: tool.schema
        .boolean()
        .describe("Must be true. Set only when the user has explicitly asked to retry (e.g. they ran /lattice-retry)."),
      response: tool.schema
        .string()
        .optional()
        .describe(
          "The user's reply to the pause (e.g. the decision that unblocks the implementor, or the guidance after a review rejection). Injected into the next stage's prompt.",
        ),
    },
    async execute(args) {
      const { state, log, getFlattened, scheduleCurrentStage } = deps;
      if (args.confirm !== true) {
        return "lattice_retry requires confirm: true. This tool is user-initiated only — do not call it in response to a pipeline status message. The user will decide whether to retry.";
      }
      const instance = state.activeInstance;
      if (!instance || instance.status !== "paused") return "No paused pipeline to retry.";

      const response = args.response?.trim() || undefined;
      const rejectedIndex = instance.stages.findIndex((s) => s.status === "rejected");

      // Resume from an approval gate (pauseAfter): no rejected stage.
      if (rejectedIndex === -1) {
        return releaseGatePause(
          instance,
          response,
          state.engineConfig.projectDir,
          log,
          "lattice_retry",
          scheduleCurrentStage,
        );
      }

      // Reject-rewind: look for an explicitly-marked rewind target upstream.
      // If none marked, fall back to the legacy literal-`implementor`-name
      // rule (ADR 024) for backward compatibility.
      const flat = effectivePipeline(instance, await getFlattened(instance.pipelineName));
      let retryIndex = -1;
      for (let i = rejectedIndex - 1; i >= 0; i--) {
        if (flat.stages[i]?.isRewindTarget) {
          retryIndex = i;
          break;
        }
      }
      if (retryIndex === -1) {
        for (let i = rejectedIndex - 1; i >= 0; i--) {
          if (instance.stages[i]?.agent === "implementor") {
            retryIndex = i;
            break;
          }
        }
      }
      if (retryIndex === -1) retryIndex = rejectedIndex;

      // maxRewinds cap enforcement on the target stage.
      const targetDef = flat.stages[retryIndex];
      const targetInst = instance.stages[retryIndex];
      const cap = targetDef?.maxRewinds;
      if (cap !== undefined && targetInst) {
        const used = targetInst.rewindsUsed ?? 0;
        if (used >= cap) {
          log.warn(`lattice_retry refused — stage "${targetInst.id}" has exhausted its rewind cap (${used}/${cap})`);
          return [
            `Stage "${targetInst.id}" has exhausted its rewind cap (${used}/${cap}).`,
            "Pipeline remains paused. The reviewer and the rewind target are not converging;",
            "further retries in this direction will repeat the same failure.",
            "",
            "Options:",
            "- `lattice_proceed` to accept the rejection and advance past it.",
            "- `lattice_abort` to cancel the pipeline.",
          ].join("\n");
        }
        targetInst.rewindsUsed = used + 1;
      }

      for (let i = retryIndex; i < instance.stages.length; i++) {
        const s = instance.stages[i];
        if (s) {
          s.status = "pending";
          s.sessionId = undefined;
          s.startedAt = undefined;
          s.completedAt = undefined;
          s.summary = undefined;
          s.verdict = undefined;
          s.postHookRetriesUsed = undefined;
          // Preserve rewindsUsed — it's a lifetime counter, not reset on rewind.
          if (i !== retryIndex) s.rewindsUsed = undefined;
        }
      }

      instance.status = "running";
      instance.currentStageIndex = retryIndex;
      instance.updatedAt = new Date().toISOString();
      instance.pendingResponse = response;

      await cleanSignals(state.engineConfig.projectDir);
      await saveInstance(state.engineConfig.projectDir, instance);

      log.info(`Retrying from stage "${instance.stages[retryIndex]?.id}"`);
      await scheduleCurrentStage?.();
      return `Retrying from stage "${instance.stages[retryIndex]?.id}". The stage will begin automatically.`;
    },
  });
}

/**
 * Stamp a user-unlock token onto the active instance. Called from the
 * `command.execute.before` plugin hook when the user types a `/lattice-retry`
 * or `/lattice-approve` slash command. Consumed by `lattice_retry` and
 * `lattice_approve` to authorise advancing past a hard-gated pause.
 */
export async function stampUserUnlockToken(state: PluginState, sessionId: string | undefined): Promise<void> {
  const instance = state.activeInstance;
  if (!instance) return;
  instance.userRetryToken = {
    issuedAt: new Date().toISOString(),
    ...(sessionId && { sessionId }),
  };
  instance.updatedAt = new Date().toISOString();
  await saveInstance(state.engineConfig.projectDir, instance);
}

export function createLatticeProceedTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Accept a paused pipeline's rejection and advance PAST the rejected stage. " +
      "Use when the user has decided the review's findings are acceptable (e.g. intentional shared-file edits, known scope exceptions) and wants to move on rather than address them. " +
      "Without this, `lattice_retry` would rewind to the implementor and the pipeline would loop on the same rejection. " +
      "USER-INITIATED ONLY — do NOT call this in response to an injected pipeline-paused status message. " +
      "`confirm` must be `true`. Pass the user's justification as `reason` for the audit trail.",
    args: {
      confirm: tool.schema
        .boolean()
        .describe("Must be true. Set only when the user has explicitly asked to proceed past the rejection."),
      reason: tool.schema
        .string()
        .optional()
        .describe(
          'Optional justification for accepting the rejection (e.g. "scope findings are intentional shared-file edits approved by the user"). Recorded in the stage summary.',
        ),
    },
    async execute(args) {
      const { state, log } = deps;
      if (args.confirm !== true) {
        return "lattice_proceed requires confirm: true. Only call this when the user explicitly asks to advance past a rejection.";
      }
      const instance = state.activeInstance;
      if (!instance || instance.status !== "paused") return "No paused pipeline to proceed past.";

      const rejectedIndex = instance.stages.findIndex((s) => s.status === "rejected");
      if (rejectedIndex === -1) {
        return "No rejected stage — nothing to proceed past. Use `lattice_retry` to resume from a gated pause.";
      }

      const rejected = instance.stages[rejectedIndex];
      if (rejected) {
        rejected.status = "completed";
        rejected.verdict = "approve";
        rejected.summary = [rejected.summary ?? "", "", `[proceeded by user${args.reason ? `: ${args.reason}` : ""}]`]
          .join("\n")
          .trim();
        rejected.completedAt = new Date().toISOString();
      }

      const advanceIndex = rejectedIndex + 1;
      instance.status = "running";
      instance.currentStageIndex = advanceIndex;
      instance.updatedAt = new Date().toISOString();
      instance.pendingResponse = args.reason?.trim() || undefined;

      await cleanSignals(state.engineConfig.projectDir);

      const advancedTo = instance.stages[advanceIndex]?.id;
      if (!advancedTo) {
        instance.status = "completed";
        await saveInstance(state.engineConfig.projectDir, instance);
        log.info(`Proceed accepted for "${rejected?.id}"; pipeline has no further stages — completing.`);
        return `Proceed accepted for "${rejected?.id}". Pipeline completed (no further stages).`;
      }

      await saveInstance(state.engineConfig.projectDir, instance);
      log.info(`Proceed accepted for "${rejected?.id}"; advancing to "${advancedTo}"`);
      return `Proceed accepted for rejected stage "${rejected?.id}". Advancing to "${advancedTo}".`;
    },
  });
}

export function createLatticeApproveTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Approve a paused lattice pipeline at a `pauseAfter` gate and advance to the next stage. " +
      "Use this when the previous stage completed successfully and is awaiting user sign-off (e.g. plan review, destructive-action approval). " +
      "If the pause is caused by a rejected stage, use `lattice_retry` (rewind and fix) or `lattice_proceed` (accept rejection and skip) instead. " +
      "USER-INITIATED ONLY — do NOT call this in response to an injected pipeline-paused status message. " +
      "The `confirm` argument must be `true`. Pass the user's reply as `response` so the next stage can act on it.",
    args: {
      confirm: tool.schema
        .boolean()
        .describe(
          "Must be true. Set only when the user has explicitly asked to approve (e.g. they ran /lattice-approve).",
        ),
      response: tool.schema
        .string()
        .optional()
        .describe(
          "The user's reply to the gate (decisions, extra requirements, clarifications). Injected into the next stage's prompt.",
        ),
    },
    async execute(args) {
      const { state, log, scheduleCurrentStage } = deps;
      if (args.confirm !== true) {
        return "lattice_approve requires confirm: true. This tool is user-initiated only — do not call it in response to a pipeline status message.";
      }
      const instance = state.activeInstance;
      if (!instance || instance.status !== "paused") return "No paused pipeline to approve.";

      const rejectedIndex = instance.stages.findIndex((s) => s.status === "rejected");
      if (rejectedIndex !== -1) {
        return "This pause is a rejection, not an approval gate. Use `lattice_retry` to rewind and fix, or `lattice_proceed` to accept the rejection and advance past it.";
      }

      const response = args.response?.trim() || undefined;
      return releaseGatePause(
        instance,
        response,
        state.engineConfig.projectDir,
        log,
        "lattice_approve",
        scheduleCurrentStage,
      );
    },
  });
}

export function createLatticeResetTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Recover a lattice pipeline that is stuck in `running` state with no active stage (e.g. opencode died mid-stage and the state was never transitioned to `paused`). " +
      "Marks the current running stage `pending` (clearing its session/timestamps/summary) and moves the pipeline to `paused` so `/lattice-retry` or `/lattice-approve` can pick it up again. " +
      "Does NOT affect completed stages. If you want to cancel the pipeline entirely, use `lattice_abort` instead. " +
      "USER-INITIATED ONLY — do NOT call this in response to an injected pipeline status message. " +
      "The `confirm` argument must be `true`.",
    args: {
      confirm: tool.schema
        .boolean()
        .describe("Must be true. Set only when the user has explicitly asked to reset (e.g. they ran /lattice-reset)."),
    },
    async execute(args) {
      const { state, log } = deps;
      if (args.confirm !== true) {
        return "lattice_reset requires confirm: true. This tool is user-initiated only — do not call it in response to a pipeline status message.";
      }
      const instance = state.activeInstance;
      if (!instance) return "No active pipeline to reset.";
      if (instance.status !== "running") {
        return `Pipeline is ${instance.status}, not running. Use \`lattice_retry\` or \`lattice_approve\` to resume a paused pipeline, or \`lattice_abort\` to cancel.`;
      }

      const stuck = instance.stages[instance.currentStageIndex];
      if (stuck) {
        stuck.status = "pending";
        stuck.sessionId = undefined;
        stuck.startedAt = undefined;
        stuck.completedAt = undefined;
        stuck.summary = undefined;
        stuck.verdict = undefined;
        stuck.postHookRetriesUsed = undefined;
      }

      instance.status = "paused";
      instance.hardGated = undefined;
      instance.userRetryToken = undefined;
      instance.updatedAt = new Date().toISOString();

      await cleanSignals(state.engineConfig.projectDir);
      await saveInstance(state.engineConfig.projectDir, instance);

      log.info(`Pipeline "${instance.pipelineName}" reset — stage "${stuck?.id ?? "?"}" returned to pending`);
      return `Pipeline "${instance.pipelineName}" reset. Stage "${stuck?.id ?? "?"}" is back to pending and the pipeline is paused. Run \`/lattice-retry\` to restart the stage.`;
    },
  });
}

export function createLatticeSignalTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Signal the lattice pipeline engine with a verdict for the current stage. " +
      "Use 'approve' to pass a review, 'reject' to fail it, 'blocked' to halt the pipeline, " +
      "or 'complete' to signal that the stage finished successfully.",
    args: {
      status: tool.schema.enum(["complete", "approve", "reject", "blocked"]).describe("The stage outcome"),
      reason: tool.schema.string().optional().describe("Brief explanation of the verdict"),
    },
    async execute(args) {
      const instance = deps.state.activeInstance;
      if (!instance) return "No active pipeline.";

      const currentStage = instance.stages[instance.currentStageIndex];
      if (!currentStage) return "No active stage to signal.";

      const signalsDir = join(deps.state.engineConfig.projectDir, ".lattice", "signals");
      await mkdir(signalsDir, { recursive: true });
      await writeFile(
        join(signalsDir, `${currentStage.id}.json`),
        JSON.stringify({ status: args.status, reason: args.reason }),
      );

      return `Signal recorded: ${args.status}${args.reason ? ` — ${args.reason}` : ""}`;
    },
  });
}
