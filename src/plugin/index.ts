import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "../config/loader.js";
import {
  advancePipeline,
  buildStageAction,
  checkStageCompletion,
  cleanBlockedFile,
  cleanSignals,
  createOpencodeSessionProvider,
  findActiveInstance,
  flattenPipeline,
  loadPipelines,
  markStageRunning,
  saveInstance,
} from "../engine/index.js";
import { builtinPipelines } from "../pipelines/index.js";
import { createOpencodeScoringProvider } from "../skills/opencode-scoring.js";
import { scanSkills } from "../skills/scanner.js";
import { scoreSkills } from "../skills/scorer.js";
import { loadAgentConfigs } from "./agents.js";
import { createLogger } from "./logger.js";
import type { PluginState } from "./state.js";
import { AgentTracker, buildSystemTransform, SkillStore } from "./system-transform.js";
import {
  createLatticeAbortTool,
  createLatticeRetryTool,
  createLatticeRunTool,
  createLatticeSignalTool,
  createLatticeStatusTool,
} from "./tools.js";

const LATTICE_DIR = ".lattice";

/**
 * Build a terminal status notification with clear UX for the user.
 *
 * The message has two audiences:
 * - The orchestrator agent (reads it as an injected user-turn prompt). We tell
 *   it to stand down so it doesn't auto-fix, auto-retry, or auto-commit.
 * - The human user (sees it in their session). We give them a clean "what
 *   happened" + "what to do next" block they can act on.
 */
function buildUserNotification(options: { title: string; summary: string; nextSteps: string[] }): string {
  const nextStepsBlock = options.nextSteps.length
    ? ["", "### What to do next", "", ...options.nextSteps.map((s) => `- ${s}`)].join("\n")
    : "";

  return [
    "[LATTICE — STATUS UPDATE]",
    "",
    "**For the agent:** this is a status notification for the user. Do NOT act on it. Do NOT call `lattice_retry`, `lattice_abort`, `lattice_run`, or `lattice_signal`. Do NOT run git commands, tests, or any follow-up actions implied below. Wait for the user's next instruction.",
    "",
    "---",
    "",
    `## ${options.title}`,
    "",
    options.summary,
    nextStepsBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

const server: Plugin = async ({ client, directory }) => {
  const latticeConfig = await loadConfig(directory);
  const pipelinesDir = join(directory, LATTICE_DIR, "pipelines");
  const registry = await loadPipelines(pipelinesDir, builtinPipelines);
  const sessions = createOpencodeSessionProvider(client, directory);
  const scoringProvider = createOpencodeScoringProvider(client, directory);
  const log = createLogger(client);

  const agentTracker = new AgentTracker();
  const skillStore = new SkillStore();

  const discoveredSkills = await scanSkills(directory, {
    extraPaths: latticeConfig.skills?.paths,
  });
  log.info(`Discovered ${discoveredSkills.length} skills`);

  const agentConfigs = await loadAgentConfigs();
  log.info(`Loaded ${Object.keys(agentConfigs).length} bundled agents`);

  const state: PluginState = {
    registry,
    flattenedCache: new Map(),
    activeInstance: await findActiveInstance(directory),
    parentSessionId: undefined,
    engineConfig: { projectDir: directory, latticeConfig },
  };

  function getFlattened(name: string) {
    let flat = state.flattenedCache.get(name);
    if (!flat) {
      const def = state.registry.get(name);
      if (!def) throw new Error(`Pipeline "${name}" not found`);
      flat = flattenPipeline(def, state.registry);
      state.flattenedCache.set(name, flat);
    }
    return flat;
  }

  async function selectSkillsForStage(sessionId: string, stageId: string, agent: string, goal: string) {
    const flat = state.activeInstance ? getFlattened(state.activeInstance.pipelineName) : undefined;
    const stageDef = flat?.stages.find((s) => s.id === stageId);
    const skillsConfig = stageDef?.skills;

    if (!skillsConfig?.dynamic && (!skillsConfig?.pinned || skillsConfig.pinned.length === 0)) return;

    const pinned = skillsConfig?.pinned ?? [];
    const max = skillsConfig?.max ?? latticeConfig.skills?.max ?? 4;

    try {
      if (skillsConfig?.dynamic && discoveredSkills.length > 0) {
        const selected = await scoreSkills(discoveredSkills, { goal, agent, stageId }, pinned, max, scoringProvider);
        skillStore.set(sessionId, selected);
        log.info(`Skills for ${stageId}: ${selected.map((s) => s.name).join(", ") || "none"}`);
      } else {
        const pinnedSkills = discoveredSkills.filter((s) => pinned.includes(s.name));
        skillStore.set(sessionId, pinnedSkills);
      }
    } catch (err) {
      log.warn(`Skill selection failed for ${stageId}: ${err}`);
    }
  }

  const toolDeps = { state, getFlattened, selectSkillsForStage, log };
  let processing = false;

  /** Execute a stage action — inject prompt or subtask into the session. */
  async function executeStageAction(instance: typeof state.activeInstance) {
    if (!instance || !state.parentSessionId) return;

    const flat = getFlattened(instance.pipelineName);
    const action = buildStageAction(instance, flat);
    if (!action) return;

    const stageIndex = (instance.stages.findIndex((s) => s.id === action.stageId) ?? 0) + 1;
    const totalStages = instance.stages.length;
    const progress = `[${stageIndex}/${totalStages}]`;

    if (action.type === "inject") {
      await sessions.injectPrompt(state.parentSessionId, action.agent, action.prompt);
      await markStageRunning(instance, state.engineConfig);
      log.info(`${progress} Stage "${action.stageId}" (agent: ${action.agent})`);
    } else {
      await sessions.injectSubtask(
        state.parentSessionId,
        action.agent,
        action.prompt,
        `${progress} Lattice: ${action.stageId}`,
      );
      await markStageRunning(instance, state.engineConfig);
      log.info(`${progress} Subtask "${action.stageId}" (agent: ${action.agent})`);
    }

    await selectSkillsForStage(state.parentSessionId, action.stageId, action.agent, instance.goal);
  }

  return {
    tool: {
      lattice_run: createLatticeRunTool(toolDeps),
      lattice_status: createLatticeStatusTool(toolDeps),
      lattice_abort: createLatticeAbortTool(toolDeps),
      lattice_retry: createLatticeRetryTool(toolDeps),
      lattice_signal: createLatticeSignalTool(toolDeps),
    },

    async config(config) {
      config.agent = config.agent ?? {};
      for (const [name, agentConfig] of Object.entries(agentConfigs)) {
        if (!config.agent[name]) {
          config.agent[name] = agentConfig as unknown as (typeof config.agent)[string];
        }
      }

      config.command = config.command ?? {};
      for (const name of state.registry.keys()) {
        config.command[name] = {
          description: `Run the ${name} pipeline via lattice`,
          template: `Use the lattice_run tool with pipeline "${name}" and goal: $ARGUMENTS`,
        };
      }
      config.command["lattice-status"] = {
        description: "Show lattice pipeline status",
        template: "Use the lattice_status tool to show the current pipeline status.",
      };
      config.command["lattice-abort"] = {
        description: "Abort the active lattice pipeline",
        template:
          "The user has explicitly invoked /lattice-abort. Call the lattice_abort tool with confirm: true. Do not call any other lattice tools.",
      };
      config.command["lattice-retry"] = {
        description: "Retry a paused lattice pipeline",
        template:
          "The user has explicitly invoked /lattice-retry. Call the lattice_retry tool with confirm: true. " +
          "If the user's most recent message contains a decision, clarification, or guidance that answers the pause reason, pass it verbatim as the `response` argument so the retried stage receives it. " +
          "Do not call any other lattice tools.",
      };
    },

    "chat.params": async (input) => {
      agentTracker.track(input.sessionID, input.agent);
    },

    "experimental.chat.system.transform": buildSystemTransform(latticeConfig, agentTracker, skillStore),

    async event({ event }) {
      if (event.type === "session.error") {
        const ev = event as unknown as { properties?: { sessionID?: string; error?: { data?: { message?: string } } } };
        const msg = ev.properties?.error?.data?.message;
        if (msg && msg !== "UnknownError") {
          log.error(`OpenCode session error (${ev.properties?.sessionID}): ${msg}`);
        }
        return;
      }
      if (event.type !== "session.idle") return;

      const instance = state.activeInstance;
      if (!instance || instance.status !== "running") return;
      if (processing) return;
      processing = true;

      try {
        const currentStage = instance.stages[instance.currentStageIndex];
        if (!currentStage) return;

        const flat = getFlattened(instance.pipelineName);

        // Pending stage — execute the action
        if (currentStage.status === "pending") {
          await executeStageAction(instance);
          return;
        }

        // Running stage — check completion
        if (currentStage.status !== "running") return;

        const completion = await checkStageCompletion(instance, flat, state.engineConfig);
        if (!completion.complete) return;

        log.info(`Stage "${currentStage.id}" complete: ${completion.summary ?? "done"}`);
        await cleanBlockedFile(state.engineConfig.projectDir);

        const result = await advancePipeline(instance, flat, state.engineConfig, completion);
        state.activeInstance = result.instance;

        // If still running, execute next stage action immediately
        if (result.instance.status === "running") {
          await executeStageAction(result.instance);
        }

        if (result.pauseReason && state.parentSessionId) {
          log.warn(`Pipeline paused: ${result.pauseReason}`);
          const pauseMsg = buildUserNotification({
            title: `Pipeline "${instance.pipelineName}" paused — review rejected`,
            summary: `The review stage flagged an issue:\n\n> ${result.pauseReason}`,
            nextSteps: [
              "**Fix it manually**, then run `/lattice-retry` — lattice rewinds to the implementor with your changes in context.",
              "**Retry as-is** with `/lattice-retry` — the implementor re-runs with the rejection reason so it can try again.",
              "**Cancel** with `/lattice-abort`.",
              "**Inspect state** with `/lattice-status` before deciding.",
            ],
          });
          await sessions.injectPrompt(state.parentSessionId, "build", pauseMsg);
        }

        if (result.gateReason && state.parentSessionId) {
          log.info(`Pipeline gated: ${result.gateReason}`);
          const nextStage = result.instance.stages[result.instance.currentStageIndex];
          const gateMsg = buildUserNotification({
            title: `Pipeline "${instance.pipelineName}" paused — approval required`,
            summary: `${result.gateReason}\n\nReview the outputs from the completed stages and tell the orchestrator how to proceed.`,
            nextSteps: [
              `**Approve as-is** — reply "proceed" (or similar); the orchestrator will run \`/lattice-retry\` and stage "${nextStage?.id ?? "next"}" will start.`,
              "**Propose changes** — reply with your changes, questions answered, or extra requirements. The orchestrator will pass them through to the next stage via `/lattice-retry`.",
              "**Cancel** with `/lattice-abort`.",
              "**Inspect state** with `/lattice-status` before deciding.",
            ],
          });
          await sessions.injectPrompt(state.parentSessionId, "build", gateMsg);
        }

        if (result.instance.status === "completed") {
          await cleanSignals(state.engineConfig.projectDir);
          await cleanBlockedFile(state.engineConfig.projectDir);
          log.info(`Pipeline "${instance.pipelineName}" completed`);

          if (state.parentSessionId) {
            const completedStages = result.instance.stages
              .filter((s) => s.status === "completed")
              .map((s) => `- **${s.id}**: ${s.summary ?? "done"}`)
              .join("\n");
            const completionMsg = buildUserNotification({
              title: `Pipeline "${instance.pipelineName}" complete`,
              summary: `Stages completed:\n${completedStages}`,
              nextSteps: [
                "Review the changes: `git diff` (or your editor's diff view).",
                "Run the project's test suite to verify.",
                "Commit and push when you're satisfied.",
                "Start another pipeline with `/implement`, `/review`, `/architecture`, etc.",
              ],
            });
            await sessions.injectPrompt(state.parentSessionId, "build", completionMsg);
          }

          state.activeInstance = undefined;
        }
      } catch (err) {
        log.error(`Pipeline error: ${err}`);
        const currentStage = instance.stages[instance.currentStageIndex];
        instance.status = "failed";
        instance.updatedAt = new Date().toISOString();
        if (currentStage) {
          currentStage.status = "failed";
          currentStage.summary = `Error: ${err}`;
        }
        await saveInstance(state.engineConfig.projectDir, instance);
        state.activeInstance = undefined;

        if (state.parentSessionId) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const failureMsg = buildUserNotification({
            title: `Pipeline "${instance.pipelineName}" failed`,
            summary: `Stage "${currentStage?.id ?? "unknown"}" errored:\n\n> ${errMsg}`,
            nextSteps: [
              `Rerun \`/${instance.pipelineName}\` to start fresh once the underlying cause is fixed.`,
              "Check the opencode log at `~/.local/share/opencode/log/` for the full stack trace.",
              "`/lattice-status` can show the stored pipeline state before it's cleared.",
            ],
          });
          await sessions.injectPrompt(state.parentSessionId, "build", failureMsg);
        }
      } finally {
        processing = false;
      }
    },
  };
};

export default {
  id: "lattice",
  server,
};
