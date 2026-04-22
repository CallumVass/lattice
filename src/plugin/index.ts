import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "../config/loader.js";
import { createOpencodeSessionProvider, findActiveInstance, flattenPipeline, loadPipelines } from "../engine/index.js";
import { createOpencodeScoringProvider, scanSkills } from "../skills/index.js";
import { createEventHandler } from "./events.js";
import { createLogger } from "./logger.js";
import { selectSkillsForStage } from "./stage-runner.js";
import type { PluginState } from "./state.js";
import { AgentTracker, buildSystemTransform, SkillStore } from "./system-transform.js";
import {
  createLatticeAbortTool,
  createLatticeProceedTool,
  createLatticeRetryTool,
  createLatticeRunTool,
  createLatticeSignalTool,
  createLatticeStatusTool,
  stampUserRetryToken,
} from "./tools.js";

const PIPELINE_DIR_NAME = "lattice-pipelines";

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

  const toolDeps = { state, getFlattened, selectSkillsForStage: selectSkillsForActiveStage, log };

  return {
    tool: {
      lattice_run: createLatticeRunTool(toolDeps),
      lattice_status: createLatticeStatusTool(toolDeps),
      lattice_abort: createLatticeAbortTool(toolDeps),
      lattice_retry: createLatticeRetryTool(toolDeps),
      lattice_proceed: createLatticeProceedTool(toolDeps),
      lattice_signal: createLatticeSignalTool(toolDeps),
    },

    async config(config) {
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
      config.command["lattice-proceed"] = {
        description: "Accept a paused pipeline's rejection and advance past it",
        template:
          "The user has explicitly invoked /lattice-proceed. Call the lattice_proceed tool with confirm: true. " +
          'If the user supplied a justification (e.g. "shared-file edits are intentional"), pass it verbatim as the `reason` argument. ' +
          "Do not call any other lattice tools.",
      };
    },

    "chat.params": async (input) => {
      agentTracker.track(input.sessionID, input.agent);
    },

    // Observe user-typed slash commands. When the user types `/lattice-retry`,
    // stamp a short-lived token on the active instance so `lattice_retry` can
    // distinguish a real user release from an orchestrator-initiated tool call.
    // Hard-gated pauses (`pauseAfter: { hardGate: true }`) require this token;
    // soft pauses do not. Agent tool calls do not go through this hook.
    "command.execute.before": async (input) => {
      if (input.command === "lattice-retry") {
        await stampUserRetryToken(state, input.sessionID).catch((err) => {
          log.warn(`Failed to stamp user-retry token: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    },

    "experimental.chat.system.transform": buildSystemTransform(latticeConfig, agentTracker, skillStore),

    event: createEventHandler({ ...stageRunnerDeps, state, getFlattened }),
  };
};

export default {
  id: "lattice",
  server,
};
