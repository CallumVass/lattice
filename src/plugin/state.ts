import type { EngineConfig } from "../engine/engine.js";
import type { FlattenedPipeline } from "../engine/flattener.js";
import type { PipelineRegistry } from "../engine/loader.js";
import type { PipelineInstance } from "../schema/index.js";

/** In-memory state shared across plugin hooks. */
export interface PluginState {
  registry: PipelineRegistry;
  flattenedCache: Map<string, FlattenedPipeline>;
  activeInstance: PipelineInstance | undefined;
  parentSessionId: string | undefined;
  engineConfig: EngineConfig;
}
