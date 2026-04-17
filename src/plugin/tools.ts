import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import { tool } from "@opencode-ai/plugin/tool";
import { cleanSignals, saveInstance, startPipeline } from "../engine/index.js";
import {
  applyFeedback,
  compact,
  count as countLearnings,
  readAllLearnings,
  resolveLearningsConfig,
  trailingAverage,
  writeAllLearnings,
} from "../learnings/index.js";
import type { PluginState } from "./state.js";

interface ToolDeps {
  state: PluginState;
  getFlattened: (name: string) => ReturnType<typeof import("../engine/flattener.js").flattenPipeline>;
  selectSkillsForStage: (sessionId: string, stageId: string, agent: string, goal: string) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

type RunLogger = ToolDeps["log"];

/**
 * Run compaction on the learnings store and record the merge count on state.
 * Called on pipeline start — cheap pass that merges obvious duplicates so
 * the selector sees one reinforced entry per recurring pattern instead of
 * several near-identical rows.
 */
async function runCompaction(state: PluginState, log: RunLogger): Promise<void> {
  const resolved = resolveLearningsConfig(state.engineConfig);
  if (!resolved.enabled) {
    state.lastCompactionMerged = 0;
    return;
  }
  try {
    const storage = { projectDir: state.engineConfig.projectDir, storePath: resolved.storePath };
    const entries = await readAllLearnings(storage);
    if (entries.length === 0) {
      state.lastCompactionMerged = 0;
      return;
    }
    const { kept, merged } = compact(entries, { similarityThreshold: resolved.similarityThreshold });
    if (merged > 0) {
      await writeAllLearnings(kept, storage);
      log.info(`Learnings compaction merged ${merged} entr${merged === 1 ? "y" : "ies"}`);
    }
    state.lastCompactionMerged = merged;
  } catch (err) {
    log.warn(`Learnings compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    state.lastCompactionMerged = 0;
  }
}

/**
 * Rewrite the propose-comments stage summary to drop any finding whose
 * 1-indexed number appears in `kills`. Composer output uses
 * `### Finding N: ...` section headers; this regex-based stripper keeps the
 * rest of the document intact (section headings, review-decision footer) so
 * the poster sees exactly the survivors.
 */
function stripKilledFindings(summary: string, kills: number[]): string {
  if (kills.length === 0) return summary;
  const killSet = new Set(kills);
  const lines = summary.split("\n");
  const out: string[] = [];
  let skipping = false;
  const findingHeader = /^#{2,6}\s+Finding\s+(\d+)\s*:/i;
  const anyHeader = /^#{1,6}\s+/;

  for (const line of lines) {
    const findingMatch = line.match(findingHeader);
    if (findingMatch) {
      const n = Number(findingMatch[1]);
      skipping = killSet.has(n);
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (skipping) {
      if (anyHeader.test(line)) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
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
        state.pendingKills = undefined;
        state.originalProposeSummary = undefined;
        await runCompaction(state, log);
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
        const mergedSuffix =
          deps.state.lastCompactionMerged > 0 ? ` (${deps.state.lastCompactionMerged} merged on last compaction)` : "";
        lines.push(
          summary.entries === 0
            ? `Learnings: 0 entries${mergedSuffix}`
            : `Learnings: ${summary.entries} entries (last: ${summary.lastCapturedAt})${mergedSuffix}`,
        );

        const projectDir = deps.state.engineConfig.projectDir;
        const overall = await trailingAverage("findingsCount", 5, { projectDir });
        if (overall !== undefined) {
          lines.push(`Findings (last 5 runs avg): ${overall.toFixed(1)} per run`);
        }

        for (const pipeline of ["review", "implement"] as const) {
          const avg = await trailingAverage("findingsCount", 5, { projectDir, pipeline });
          if (avg !== undefined) {
            lines.push(`Findings (${pipeline}, last 5): ${avg.toFixed(1)} per run`);
          }
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
      "Pass the user's clarifying reply as `response` so the retried stage can act on it. " +
      "At the `/review` approval gate, pass `kill` with the 1-indexed finding numbers the user wants dropped (e.g. `/lattice-retry kill:[2,4]` → `kill: [2, 4]`); those findings are removed before posting and stored as negative learnings.",
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
      kill: tool.schema
        .array(tool.schema.number().int().positive())
        .optional()
        .describe(
          "1-indexed finding numbers to drop at the /review approval gate. Each dropped finding is stored as a negative learning so the reviewer avoids re-flagging the same false positive.",
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
      const kills = (args.kill ?? []).filter((n) => Number.isInteger(n) && n > 0);
      const rejectedIndex = instance.stages.findIndex((s) => s.status === "rejected");

      if (rejectedIndex === -1) {
        // Approval gate: currentStageIndex is already pointing at the next pending stage. Just unpause.
        if (kills.length > 0) {
          const propose = instance.stages.find((s) => s.id === "propose-comments");
          if (propose?.summary) {
            state.originalProposeSummary = propose.summary;
            propose.summary = stripKilledFindings(propose.summary, kills);
          }
          state.pendingKills = kills;
        } else {
          state.pendingKills = undefined;
          state.originalProposeSummary = undefined;
        }
        instance.status = "running";
        instance.updatedAt = new Date().toISOString();
        instance.pendingResponse = response;
        await cleanSignals(state.engineConfig.projectDir);
        await saveInstance(state.engineConfig.projectDir, instance);
        const resumingId = instance.stages[instance.currentStageIndex]?.id ?? "?";
        log.info(
          kills.length > 0
            ? `Resuming from gate at stage "${resumingId}" (dropping findings ${kills.join(", ")})`
            : `Resuming from gate at stage "${resumingId}"`,
        );
        const killSuffix = kills.length > 0 ? ` Dropping findings ${kills.join(", ")} before posting.` : "";
        return `Resuming pipeline at stage "${resumingId}".${killSuffix}`;
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

export function createLatticeLearningFeedbackTool(deps: ToolDeps): ToolDefinition {
  return tool({
    description:
      "Adjust a captured learning based on user feedback. `valid` boosts confidence, `invalid` drops it sharply, and `stale` expires the entry so it stops appearing in future injections. " +
      "USER-INITIATED ONLY — call from the `/lattice-learning-feedback` slash command. The id can be a full uuid or the 8-char short id shown in review findings.",
    args: {
      id: tool.schema.string().describe("Learning entry id (full uuid or the 8-char short id)."),
      verdict: tool.schema
        .enum(["valid", "invalid", "stale"])
        .describe("User's verdict on the learning: valid → reinforce; invalid → penalise; stale → expire."),
    },
    async execute(args) {
      const { state, log } = deps;
      const resolved = resolveLearningsConfig(state.engineConfig);
      if (!resolved.enabled) {
        return "Learnings are disabled. Nothing to update.";
      }

      try {
        const updated = await applyFeedback(
          args.id,
          args.verdict,
          { projectDir: state.engineConfig.projectDir, storePath: resolved.storePath },
          {
            decay: {
              decayRate: resolved.decayRate,
              reinforcementBoost: resolved.reinforcementBoost,
              invalidPenalty: resolved.invalidPenalty,
            },
          },
        );
        if (!updated) {
          return `No learning found for id "${args.id}".`;
        }
        log.info(`Learning feedback applied: ${updated.id} → ${args.verdict}`);
        const extra = args.verdict === "stale" ? ` (expiresAt=${updated.expiresAt})` : "";
        return `Applied ${args.verdict} feedback to learning ${updated.id.slice(0, 8)} (confidence=${updated.confidence.toFixed(2)}, feedbackScore=${updated.feedbackScore.toFixed(2)})${extra}.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Learning feedback failed: ${msg}`);
        return `Failed to apply feedback: ${msg}`;
      }
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
