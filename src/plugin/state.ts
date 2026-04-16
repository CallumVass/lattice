import type { EngineConfig, FlattenedPipeline, PipelineRegistry } from "../engine/index.js";
import type { PipelineInstance } from "../schema/index.js";

/** In-memory state shared across plugin hooks. */
export interface PluginState {
  registry: PipelineRegistry;
  flattenedCache: Map<string, FlattenedPipeline>;
  activeInstance: PipelineInstance | undefined;
  parentSessionId: string | undefined;
  engineConfig: EngineConfig;
}
