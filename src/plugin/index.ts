import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "../config/loader.js";
import { createOpencodeSessionProvider, findActiveInstance, flattenPipeline, loadPipelines } from "../engine/index.js";
import { builtinPipelines } from "../pipelines/index.js";
import { createOpencodeScoringProvider, scanSkills } from "../skills/index.js";
import { loadAgentConfigs } from "./agents.js";
import { createEventHandler } from "./events.js";
import { createLogger } from "./logger.js";
import { selectSkillsForStage } from "./stage-runner.js";
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

  const stageRunnerDeps = {
    sessions,
    engineConfig: state.engineConfig,
    latticeConfig,
    discoveredSkills,
    scoringProvider,
    skillStore,
    log,
  };

  // Tools still invoke stage-runner's skill selector directly once they know
  // which pipeline is running, hence the thin wrapper that resolves the
  // flattened pipeline for the currently active instance.
  const selectSkillsForActiveStage = (sessionId: string, stageId: string, agent: string, goal: string) => {
    const flat = state.activeInstance ? getFlattened(state.activeInstance.pipelineName) : undefined;
    if (!flat) return Promise.resolve();
    return selectSkillsForStage(sessionId, flat, stageId, agent, goal, stageRunnerDeps);
  };

  const toolDeps = { state, getFlattened, selectSkillsForStage: selectSkillsForActiveStage, log };

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

    event: createEventHandler({ ...stageRunnerDeps, state, getFlattened }),
  };
};

export default {
  id: "lattice",
  server,
};
