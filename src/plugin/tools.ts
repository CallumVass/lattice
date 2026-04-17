import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import { tool } from "@opencode-ai/plugin/tool";
import { cleanSignals, saveInstance, startPipeline } from "../engine/index.js";
import { count as countLearnings, resolveLearningsConfig, trailingAverage } from "../learnings/index.js";
import type { PluginState } from "./state.js";

interface ToolDeps {
  state: PluginState;
  getFlattened: (name: string) => ReturnType<typeof import("../engine/flattener.js").flattenPipeline>;
  selectSkillsForStage: (sessionId: string, stageId: string, agent: string, goal: string) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export function createLatticeRunTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Start a lattice pipeline. Available pipelines: architecture (architecture-review), implement (plan → arch-review → implement → refactor → internal review-loop), review (code-review → judge → advisory → propose → user approval → post comments), review-lite (code-review → judge → propose → user approval → post comments; no advisory pass), investigate (investigate a topic and write a spike/RFC), create-jira-issues (draft and create Jira issues via the Atlassian MCP). " +
      "The pipeline runs as a sequence of agent stages. Do NOT take any implementation actions yourself — the pipeline agents handle everything. " +
      "Do NOT call lattice_signal or lattice_status after starting — the pipeline advances automatically.",
    args: {
      pipeline: tool.schema.string().describe("Pipeline name (e.g. 'architecture', 'implement', 'review')"),
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
        const flat = getFlattened(args.pipeline);
        state.parentSessionId = context.sessionID;
        state.learningsInjected = 0;
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

      const { enabled, storePath } = resolveLearningsConfig(deps.state.engineConfig);
      if (enabled) {
        const summary = await countLearnings({ projectDir: deps.state.engineConfig.projectDir, storePath });
        lines.push(
          summary.entries === 0
            ? "Learnings: 0 entries"
            : `Learnings: ${summary.entries} entries (last: ${summary.lastCapturedAt})`,
        );

        const avg = await trailingAverage("findingsCount", 5, {
          projectDir: deps.state.engineConfig.projectDir,
        });
        if (avg !== undefined) {
          lines.push(`Findings (last 5 runs avg): ${avg.toFixed(1)} per run`);
        }
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
      "Retry a paused lattice pipeline. Loops back to the nearest implementor stage, or retries the rejected stage. " +
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
      const { state, log } = deps;
      if (args.confirm !== true) {
        return "lattice_retry requires confirm: true. This tool is user-initiated only — do not call it in response to a pipeline status message. The user will decide whether to retry.";
      }
      const instance = state.activeInstance;
      if (!instance || instance.status !== "paused") return "No paused pipeline to retry.";

      const response = args.response?.trim() || undefined;
      const rejectedIndex = instance.stages.findIndex((s) => s.status === "rejected");

      if (rejectedIndex === -1) {
        // Approval gate: currentStageIndex is already pointing at the next pending stage. Just unpause.
        instance.status = "running";
        instance.updatedAt = new Date().toISOString();
        instance.pendingResponse = response;
        await cleanSignals(state.engineConfig.projectDir);
        await saveInstance(state.engineConfig.projectDir, instance);
        const resumingId = instance.stages[instance.currentStageIndex]?.id ?? "?";
        log.info(`Resuming from gate at stage "${resumingId}"`);
        return `Resuming pipeline at stage "${resumingId}".`;
      }

      let retryIndex = -1;
      for (let i = rejectedIndex - 1; i >= 0; i--) {
        if (instance.stages[i]?.agent === "implementor") {
          retryIndex = i;
          break;
        }
      }
      if (retryIndex === -1) retryIndex = rejectedIndex;

      for (let i = retryIndex; i < instance.stages.length; i++) {
        const s = instance.stages[i];
        if (s) {
          s.status = "pending";
          s.sessionId = undefined;
          s.startedAt = undefined;
          s.completedAt = undefined;
          s.summary = undefined;
          s.verdict = undefined;
        }
      }

      instance.status = "running";
      instance.currentStageIndex = retryIndex;
      instance.updatedAt = new Date().toISOString();
      instance.pendingResponse = response;

      await cleanSignals(state.engineConfig.projectDir);
      await saveInstance(state.engineConfig.projectDir, instance);

      log.info(`Retrying from stage "${instance.stages[retryIndex]?.id}"`);
      return `Retrying from stage "${instance.stages[retryIndex]?.id}". The stage will begin automatically.`;
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
