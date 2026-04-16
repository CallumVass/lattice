import plugin from "./plugin/index.js";

export default plugin;

// Builder — for authoring custom pipeline files in `.lattice/pipelines/`.
export type { PipelineOptions, StageOptions } from "./builder/index.js";
export { pipeline, ref, stage } from "./builder/index.js";

// Schema types — for TypeScript authors of custom pipelines.
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

// Skill types — for implementing a custom ScoringProvider.
export type { DiscoveredSkill, ScoringContext, ScoringProvider } from "./skills/index.js";
