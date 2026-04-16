import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import { tool } from "@opencode-ai/plugin/tool";
import { cleanSignals } from "../engine/cleanup.js";
import { startPipeline } from "../engine/engine.js";
import { saveInstance } from "../engine/persistence.js";
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
      "Start a lattice pipeline. Available pipelines: architecture (architecture-review), implement (plan → arch-review → implement → refactor → review), review (code-review → review-judge), investigate (investigate a topic and write a spike/RFC), create-jira-issues (draft and create Jira issues via the Atlassian MCP). " +
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
      const instance = deps.state.activeInstance;
      if (!instance) return "No active pipeline.";

      const lines = [`Pipeline: ${instance.pipelineName} (${instance.status})`, `Goal: ${instance.goal}`];
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
      return lines.join("\n");
    },
  });
}

export function createLatticeAbortTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description: "Abort the currently running lattice pipeline.",
    args: {},
    async execute() {
      const { state, log } = deps;
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
      "Retry a paused lattice pipeline. Loops back to the nearest implementor stage, or retries the rejected stage.",
    args: {},
    async execute() {
      const { state, log } = deps;
      const instance = state.activeInstance;
      if (!instance || instance.status !== "paused") return "No paused pipeline to retry.";

      const rejectedIndex = instance.stages.findIndex((s) => s.status === "rejected");
      if (rejectedIndex === -1) return "No rejected stage found.";

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
