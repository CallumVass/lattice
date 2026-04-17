import type { EngineConfig, FlattenedPipeline, PipelineRegistry } from "../engine/index.js";
import type { PipelineInstance } from "../schema/index.js";

/** In-memory state shared across plugin hooks. */
export interface PluginState {
  registry: PipelineRegistry;
  flattenedCache: Map<string, FlattenedPipeline>;
  activeInstance: PipelineInstance | undefined;
  parentSessionId: string | undefined;
  engineConfig: EngineConfig;
  /** Accumulated count of learning entries injected across stages of the active run. */
  learningsInjected: number;
  /**
   * Finding indices the user asked to kill during `/lattice-retry kill:[...]`.
   * Survives from retry → post-comments completion so the capture hook can
   * mint negative learnings for the kills while posting only the survivors.
   */
  pendingKills: number[] | undefined;
  /**
   * Composer's full, pre-kill propose-comments summary. We mutate the stage's
   * summary in-place so the poster only sees survivors, but the capture hook
   * still needs the original ordering to correctly match kill indices to the
   * findings the user saw.
   */
  originalProposeSummary: string | undefined;
  /** Number of entries merged on the last `compact()` pass, shown by `/lattice-status`. */
  lastCompactionMerged: number;
}
