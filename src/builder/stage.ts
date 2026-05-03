// pattern: Functional Core

import type {
  ParallelEntry,
  PauseAfter,
  PipelineRef,
  SignalVerdict,
  SkillsConfig,
  StageCompletedContext,
  StageContext,
  StageDefinition,
} from "../schema/index.js";
import { parallelEntrySchema, stageDefinitionSchema } from "../schema/index.js";

interface BaseStageOptions {
  agent: string;
  context?: StageContext;
  completedContext?: StageCompletedContext;
  skills?: Partial<SkillsConfig>;
  prompt?: string;
  pauseAfter?: PauseAfter;
  expand?: NonNullable<StageDefinition["expand"]>;
  /**
   * Opt this stage in as the rewind target when a downstream stage rejects.
   * If no stage is marked, the rejected stage itself is retried. See
   * `StageDefinition.isRewindTarget` for semantics.
   */
  isRewindTarget?: boolean;
  /**
   * Cap how many times this stage may be rewound-to. Undefined = unlimited.
   * On exhaustion, `/lattice retry` leaves the pipeline paused instead of looping.
   */
  maxRewinds?: number;
}

export interface IdleStageOptions extends BaseStageOptions {
  completion: "idle";
}

export interface SignalStageOptions extends BaseStageOptions {
  completion: "signal";
  /** Signal verdicts this stage may emit. Required; tailors the engine-injected signalling block. */
  signals: SignalVerdict[];
}

export type StageOptions = IdleStageOptions | SignalStageOptions;

export interface ParallelOptions {
  stages: StageDefinition[];
  maxConcurrency?: number;
}

export function stage(id: string, options: StageOptions): StageDefinition {
  return stageDefinitionSchema.parse({
    id,
    type: "stage",
    agent: options.agent,
    completion: options.completion,
    context: options.context ?? "isolated",
    completedContext: options.completedContext ?? "full",
    pauseAfter: options.pauseAfter ?? false,
    isRewindTarget: options.isRewindTarget ?? false,
    ...(options.completion === "signal" && { signals: options.signals }),
    ...(options.skills && { skills: { dynamic: false, pinned: [], max: 4, ...options.skills } }),
    ...(options.prompt && { prompt: options.prompt }),
    ...(options.expand && { expand: options.expand }),
    ...(options.maxRewinds !== undefined && { maxRewinds: options.maxRewinds }),
  });
}

export function ref(name: string): PipelineRef {
  return { type: "pipeline", pipeline: name };
}

export function parallel(id: string, options: ParallelOptions): ParallelEntry {
  return parallelEntrySchema.parse({
    type: "parallel",
    id,
    stages: options.stages,
    ...(options.maxConcurrency !== undefined && { maxConcurrency: options.maxConcurrency }),
  });
}
