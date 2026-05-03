// Engine facade — the single entry point plugin code uses. Everything the
// plugin runtime needs to drive a pipeline is re-exported here. Consumers
// outside the package should not reach past this file into submodules.

export { cleanBlockedFile, cleanSignals } from "./cleanup.js";
export {
  advancePipelineAt,
  buildStageAction,
  buildStageActions,
  checkStageCompletionAt,
  type EngineConfig,
  effectivePipeline,
  expandCurrentStageIfNeeded,
  expandRunnableStagesIfNeeded,
  markStageDispatching,
  markStageDispatchingAt,
  markStageRunning,
  markStageRunningAt,
  startPipeline,
} from "./engine.js";
export { type FlattenedPipeline, flattenPipeline } from "./flattener.js";
export { loadPipelines, type PipelineRegistry } from "./loader.js";
export { createOpencodeSessionProvider } from "./opencode-session.js";
export { findActiveInstance, saveInstance } from "./persistence.js";
export { resolveModelOverride, type SessionProvider } from "./session.js";
