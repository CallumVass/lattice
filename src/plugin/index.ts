import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "../config/loader.js";
import { cleanBlockedFile, cleanSignals } from "../engine/cleanup.js";
import { advancePipeline, buildStageAction, checkStageCompletion, markStageRunning } from "../engine/engine.js";
import { flattenPipeline } from "../engine/flattener.js";
import { loadPipelines } from "../engine/loader.js";
import { createOpencodeSessionProvider } from "../engine/opencode-session.js";
import { findActiveInstance, saveInstance } from "../engine/persistence.js";
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
        template: "Use the lattice_abort tool to cancel the active pipeline.",
      };
      config.command["lattice-retry"] = {
        description: "Retry a paused lattice pipeline",
        template: "Use the lattice_retry tool to resume the paused pipeline.",
      };
    },

    "chat.params": async (input) => {
      agentTracker.track(input.sessionID, input.agent);
    },

    "experimental.chat.system.transform": buildSystemTransform(latticeConfig, agentTracker, skillStore),

    async event({ event }) {
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
          const pauseMsg =
            `**Pipeline paused — review rejected**\n\n${result.pauseReason}\n\n` +
            "Options:\n" +
            "- `/lattice-retry` — send the implementor back to fix the issue\n" +
            "- `/lattice-abort` — cancel the pipeline\n" +
            "- Fix it manually, then `/lattice-retry`";
          await sessions.injectPrompt(state.parentSessionId, "build", pauseMsg);
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
            await sessions.injectPrompt(
              state.parentSessionId,
              "build",
              `**Pipeline "${instance.pipelineName}" complete**\n\n${completedStages}\n\n` +
                "Next steps:\n" +
                "- Review the changes with `git diff`\n" +
                "- Run the project's test suite to verify\n" +
                "- Commit and push when satisfied",
            );
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
          await sessions.injectPrompt(
            state.parentSessionId,
            "build",
            `**Pipeline failed**\n\nStage "${currentStage?.id ?? "unknown"}" encountered an error: ${errMsg}\n\nRun \`/${instance.pipelineName}\` again to restart.`,
          );
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
