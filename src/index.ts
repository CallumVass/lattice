import plugin from "./plugin/index.js";

export default plugin;
export type { PipelineOptions, StageOptions } from "./builder/index.js";
export { pipeline, ref, stage } from "./builder/index.js";
export { loadConfig } from "./config/index.js";
export type {
  CompletionContext,
  CompletionResult,
  EngineConfig,
  EngineResult,
  FlattenedPipeline,
  PipelineRegistry,
  PromptContext,
  SessionProvider,
  StageAction,
} from "./engine/index.js";
export {
  advancePipeline,
  buildStageAction,
  checkCompletion,
  checkStageCompletion,
  composePrompt,
  findActiveInstance,
  flattenPipeline,
  loadInstance,
  loadPipelines,
  markStageRunning,
  saveInstance,
  startPipeline,
} from "./engine/index.js";

export type {
  AgentOverride,
  CompletionMethod,
  LatticeConfig,
  PipelineDefinition,
  PipelineInstance,
  PipelineOverride,
  PipelineRef,
  PipelineStatus,
  SkillsConfig,
  StageDefinition,
  StageEntry,
  StageInstance,
  StageOverride,
  StageStatus,
} from "./schema/index.js";

export type { DiscoveredSkill, ScanOptions, ScoredSkill, ScoringContext, ScoringProvider } from "./skills/index.js";
export { scanSkills, scoreSkills } from "./skills/index.js";
