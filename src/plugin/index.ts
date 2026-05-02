// pattern: Imperative Shell

import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "../config/loader.js";
import { createOpencodeSessionProvider, findActiveInstance, flattenPipeline, loadPipelines } from "../engine/index.js";
import { createOpencodeScoringProvider, scanSkills } from "../skills/index.js";
import { createEventHandler } from "./events.js";
import { createLogger } from "./logger.js";
import { executeStageAction, selectSkillsForStage } from "./stage-runner.js";
import type { PluginState } from "./state.js";
import { AgentTracker, buildSystemTransform, SkillStore } from "./system-transform.js";
import { createLatticeControlTool, createLatticeSignalTool } from "./tools.js";

const PIPELINE_DIR_NAME = "lattice-pipelines";

interface CommandRegistrationConfig {
  command?: Record<
    string,
    { template: string; description?: string; agent?: string; model?: string; subtask?: boolean }
  >;
}

export function registerLatticeCommands(config: CommandRegistrationConfig, pipelineNames: Iterable<string>): void {
  config.command = config.command ?? {};
  for (const name of pipelineNames) {
    config.command[name] = {
      description: `Run the ${name} pipeline via lattice`,
      template: `Use the lattice_control tool with action "run", pipeline "${name}", and goal: $ARGUMENTS`,
    };
  }
  config.command.lattice = {
    description: "Run or control lattice pipelines",
    template:
      "Interpret the first word of `$ARGUMENTS` as a lattice action and call the lattice_control tool. " +
      "Valid actions: status, run <pipeline> <goal>, continue [message], retry [message], accept [reason], abort, reset. " +
      "For run, pass the pipeline and remaining text as goal. For continue/retry, pass remaining text as response. For accept, pass remaining text as reason.",
  };
}

const server: Plugin = async ({ client, directory }) => {
  const latticeConfig = await loadConfig(directory);
  const pipelineDirs = [
    join(homedir(), ".config", "opencode", PIPELINE_DIR_NAME),
    join(directory, ".opencode", PIPELINE_DIR_NAME),
  ];
  const registry = await loadPipelines(pipelineDirs);
  const sessions = createOpencodeSessionProvider(client, directory);
  const scoringProvider = createOpencodeScoringProvider(client, directory);
  const log = createLogger(client);

  const agentTracker = new AgentTracker();
  const skillStore = new SkillStore();

  const discoveredSkills = await scanSkills(directory, {
    extraPaths: latticeConfig.skills?.paths,
  });
  log.info(`Discovered ${discoveredSkills.length} skills, ${registry.size} pipelines`);

  const state: PluginState = {
    registry,
    flattenedCache: new Map(),
    activeInstance: await findActiveInstance(directory),
    parentSessionId: undefined,
    engineConfig: { projectDir: directory, latticeConfig },
  };

  async function getFlattened(name: string) {
    let flat = state.flattenedCache.get(name);
    if (flat) return flat;

    let def = state.registry.get(name);
    if (!def) {
      // Registry miss — re-scan pipeline dirs. Covers: pipelines added
      // mid-session, plugin-state resets, and transient registry corruption
      // (the case that stranded PR #480 mid-run with "Pipeline not found").
      const refreshed = await loadPipelines(pipelineDirs);
      state.registry = refreshed;
      state.flattenedCache.clear();
      def = refreshed.get(name);
      if (!def) {
        throw new Error(`Pipeline "${name}" not found. Available: ${[...refreshed.keys()].join(", ") || "(none)"}`);
      }
      log.info(`Pipeline registry reloaded on miss — found "${name}" after re-scan`);
    }

    flat = flattenPipeline(def, state.registry);
    state.flattenedCache.set(name, flat);
    return flat;
  }

  const stageRunnerDeps = {
    sessions,
    engineConfig: state.engineConfig,
    latticeConfig,
    discoveredSkills,
    scoringProvider,
    skillStore,
    state,
    log,
  };

  // Tools still invoke stage-runner's skill selector directly once they know
  // which pipeline is running, hence the thin wrapper that resolves the
  // flattened pipeline for the currently active instance.
  const selectSkillsForActiveStage = async (sessionId: string, stageId: string, agent: string, goal: string) => {
    if (!state.activeInstance) return;
    const flat = await getFlattened(state.activeInstance.pipelineName);
    return selectSkillsForStage(sessionId, flat, stageId, agent, goal, stageRunnerDeps);
  };

  const scheduleCurrentStage = async () => {
    const instance = state.activeInstance;
    if (!instance || instance.status !== "running" || !state.parentSessionId) return;
    const currentStage = instance.stages[instance.currentStageIndex];
    if (!currentStage || currentStage.status !== "pending") return;
    const flat = await getFlattened(instance.pipelineName);
    await executeStageAction(instance, state.parentSessionId, flat, stageRunnerDeps);
  };

  const toolDeps = { state, getFlattened, selectSkillsForStage: selectSkillsForActiveStage, scheduleCurrentStage, log };
  const eventHandler = createEventHandler({ ...stageRunnerDeps, state, getFlattened });

  return {
    tool: {
      lattice_control: createLatticeControlTool(toolDeps),
      lattice_signal: createLatticeSignalTool(toolDeps),
    },

    async config(config) {
      registerLatticeCommands(config, state.registry.keys());
    },

    "chat.params": async (input) => {
      agentTracker.track(input.sessionID, input.agent);
    },

    "experimental.chat.system.transform": buildSystemTransform(latticeConfig, agentTracker, skillStore),

    async event(input) {
      return eventHandler(input);
    },
  };
};

export default {
  id: "lattice",
  server,
};
