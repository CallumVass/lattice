// pattern: Imperative Shell

import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "../config/loader.js";
import { createOpencodeSessionProvider, findActiveInstance, flattenPipeline, loadPipelines } from "../engine/index.js";
import { createOpencodeScoringProvider, scanSkills } from "../skills/index.js";
import { createEventHandler } from "./events.js";
import { createLogger } from "./logger.js";
import { executeStageActions, selectSkillsForStage } from "./stage-runner.js";
import type { PluginDiagnostic, PluginState } from "./state.js";
import { AgentTracker, bindActiveStageSkillsToSession, buildSystemTransform, SkillStore } from "./system-transform.js";
import { createLatticeControlTool, createLatticeSignalTool } from "./tools.js";

const PIPELINE_DIR_NAME = "lattice-pipelines";

interface CommandRegistrationConfig {
  command?: Record<
    string,
    { template: string; description?: string; agent?: string; model?: string; subtask?: boolean }
  >;
}

type CommandConfigEntry = NonNullable<CommandRegistrationConfig["command"]>[string];

interface CommandRegistrationOptions {
  onDiagnostic?: (diagnostic: PluginDiagnostic) => void;
}

function isGeneratedPipelineCommand(command: CommandConfigEntry, name: string): boolean {
  return command.template.includes("lattice_control") && command.template.includes(`pipeline "${name}"`);
}

function isGeneratedFrameworkCommand(command: CommandConfigEntry): boolean {
  return command.template.includes("lattice_control") && command.template.includes("Valid actions:");
}

export function registerLatticeCommands(
  config: CommandRegistrationConfig,
  pipelineNames: Iterable<string>,
  options: CommandRegistrationOptions = {},
): void {
  config.command = config.command ?? {};
  for (const name of pipelineNames) {
    const existing = config.command[name];
    if (existing && !isGeneratedPipelineCommand(existing, name)) {
      options.onDiagnostic?.({
        source: "commands",
        message: `Pipeline command "/${name}" overwrote an existing OpenCode command with the same name.`,
        pipeline: name,
      });
    }
    config.command[name] = {
      description: `Run the ${name} pipeline via lattice`,
      template:
        `Use the lattice_control tool exactly once with action "run", pipeline "${name}", and goal: $ARGUMENTS. ` +
        "After the tool call returns, stop; do not inspect status, continue, retry, abort, or begin implementation.",
    };
  }
  if (config.command.lattice && !isGeneratedFrameworkCommand(config.command.lattice)) {
    options.onDiagnostic?.({
      source: "commands",
      message: 'Framework command "/lattice" overwrote an existing OpenCode command with the same name.',
    });
  }
  config.command.lattice = {
    description: "Run or control lattice pipelines",
    template:
      "Interpret the first word of `$ARGUMENTS` as a lattice action and call the lattice_control tool. " +
      "Valid actions: status, doctor, run <pipeline> <goal>, continue [message], retry [message], accept [reason], abort, reset. " +
      "For run, pass the pipeline and remaining text as goal. For continue/retry, pass remaining text as response. For accept, pass remaining text as reason. " +
      "After the tool call returns, stop; do not take follow-up pipeline actions unless the user explicitly asked for them.",
  };
}

function diagnosticKey(diagnostic: PluginDiagnostic): string {
  return [diagnostic.source, diagnostic.file, diagnostic.pipeline, diagnostic.stage, diagnostic.message].join("\0");
}

function recordDiagnostic(state: PluginState, diagnostic: PluginDiagnostic): void {
  const key = diagnosticKey(diagnostic);
  if (state.diagnostics.some((existing) => diagnosticKey(existing) === key)) return;
  state.diagnostics.push(diagnostic);
}

const server: Plugin = async ({ client, directory }) => {
  const latticeConfig = await loadConfig(directory);
  const pipelineDirs = [
    join(homedir(), ".config", "opencode", PIPELINE_DIR_NAME),
    join(directory, ".opencode", PIPELINE_DIR_NAME),
  ];
  const log = createLogger(client);
  const pipelineDiagnostics: PluginDiagnostic[] = [];
  const registry = await loadPipelines(pipelineDirs, {
    onDiagnostic: (diagnostic) => pipelineDiagnostics.push({ source: "pipeline", ...diagnostic }),
  });
  const sessions = createOpencodeSessionProvider(client, directory);
  const scoringProvider = createOpencodeScoringProvider(client, directory);
  for (const diagnostic of pipelineDiagnostics) {
    log.warn(`Pipeline load skipped: ${diagnostic.file}: ${diagnostic.message}`);
  }

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
    pipelineDirs,
    diagnostics: [...pipelineDiagnostics],
  };
  state.parentSessionId = state.activeInstance?.parentSessionId;

  async function getFlattened(name: string) {
    let flat = state.flattenedCache.get(name);
    if (flat) return flat;

    let def = state.registry.get(name);
    if (!def) {
      // Registry miss — re-scan pipeline dirs. Covers: pipelines added
      // mid-session, plugin-state resets, and transient registry corruption
      // (the case that stranded PR #480 mid-run with "Pipeline not found").
      const refreshed = await loadPipelines(pipelineDirs, {
        onDiagnostic: (diagnostic) => {
          log.warn(`Pipeline load skipped: ${diagnostic.file}: ${diagnostic.message}`);
          recordDiagnostic(state, { source: "pipeline", ...diagnostic });
        },
      });
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

  let transitionQueue = Promise.resolve();
  const runExclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const run = transitionQueue.catch(() => {}).then(work);
    transitionQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  let scheduleQueue = Promise.resolve();
  const scheduleCurrentStage = async () => {
    const run = scheduleQueue
      .catch(() => {})
      .then(async () => {
        const instance = state.activeInstance;
        const parentSessionId = state.parentSessionId ?? instance?.parentSessionId;
        if (!instance || instance.status !== "running" || !parentSessionId) return;
        const flat = await getFlattened(instance.pipelineName);
        await executeStageActions(instance, parentSessionId, flat, stageRunnerDeps);
        state.parentSessionId = instance.parentSessionId ?? parentSessionId;
      });
    scheduleQueue = run.then(
      () => {},
      () => {},
    );
    await run;
  };

  const toolDeps = {
    state,
    getFlattened,
    selectSkillsForStage: selectSkillsForActiveStage,
    scheduleCurrentStage,
    discoveredSkills,
    runExclusive,
    log,
  };
  const eventHandler = createEventHandler({
    ...stageRunnerDeps,
    state,
    getFlattened,
    scheduleCurrentStage,
    runExclusive,
  });

  const trackSessionAgent = (sessionID: string | undefined, agent: string | undefined) => {
    if (!sessionID || !agent) return;
    agentTracker.track(sessionID, agent);
    bindActiveStageSkillsToSession(skillStore, state.activeInstance, sessionID, agent);
  };

  return {
    tool: {
      lattice_control: createLatticeControlTool(toolDeps),
      lattice_signal: createLatticeSignalTool(toolDeps),
    },

    async config(config) {
      registerLatticeCommands(config, state.registry.keys(), {
        onDiagnostic: (diagnostic) => recordDiagnostic(state, diagnostic),
      });
    },

    "chat.message": async (input) => {
      trackSessionAgent(input.sessionID, input.agent);
    },

    "chat.params": async (input) => {
      trackSessionAgent(input.sessionID, input.agent);
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
