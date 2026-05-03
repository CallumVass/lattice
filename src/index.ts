import plugin from "./plugin/index.js";

export default plugin;

// Builder — for authoring custom pipeline files.
export type {
  IdleStageOptions,
  ParallelOptions,
  PipelineOptions,
  SignalStageOptions,
  StageOptions,
} from "./builder/index.js";
export { parallel, pipeline, ref, stage } from "./builder/index.js";

// Schema types — for TypeScript authors of custom pipelines.
export type {
  AgentOverride,
  CompletionMethod,
  LatticeConfig,
  ParallelEntry,
  ParallelGroup,
  PipelineDefinition,
  PipelineInstance,
  PipelineOverride,
  PipelinePause,
  PipelineRef,
  PipelineStatus,
  SkillsConfig,
  StageContext,
  StageDefinition,
  StageEntry,
  StageInstance,
  StageOverride,
  StageStatus,
} from "./schema/index.js";

// Skill types — for implementing a custom ScoringProvider.
export type { DiscoveredSkill, ScoringContext, ScoringProvider } from "./skills/index.js";
