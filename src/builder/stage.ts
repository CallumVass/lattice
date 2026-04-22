import type {
  PauseAfter,
  PipelineRef,
  PostHook,
  SignalVerdict,
  SkillsConfig,
  StageDefinition,
} from "../schema/index.js";

interface BaseStageOptions {
  agent: string;
  fork?: boolean;
  skills?: Partial<SkillsConfig>;
  prompt?: string;
  pauseAfter?: PauseAfter;
  postHook?: { commands: string[]; maxRetries?: number };
  /**
   * Opt this stage in as the rewind target when a downstream stage rejects.
   * When at least one stage in the pipeline is marked, the legacy
   * `agent === "implementor"` fallback is not used. See
   * `StageDefinition.isRewindTarget` for semantics.
   */
  isRewindTarget?: boolean;
  /**
   * Cap how many times this stage may be rewound-to. Undefined = unlimited.
   * On exhaustion, `lattice_retry` pauses the pipeline instead of looping.
   */
  maxRewinds?: number;
}

export interface IdleStageOptions extends BaseStageOptions {
  completion: "idle";
}

export interface SignalStageOptions extends BaseStageOptions {
  completion: "tool_signal";
  /** Signal verdicts this stage may emit. Required; tailors the engine-injected signalling block. */
  signals: SignalVerdict[];
}

export type StageOptions = IdleStageOptions | SignalStageOptions;

export function stage(id: string, options: StageOptions): StageDefinition {
  const postHook: PostHook | undefined = options.postHook
    ? { commands: options.postHook.commands, maxRetries: options.postHook.maxRetries ?? 1 }
    : undefined;

  return {
    id,
    type: "stage",
    agent: options.agent,
    completion: options.completion,
    fork: options.fork ?? false,
    pauseAfter: options.pauseAfter ?? false,
    isRewindTarget: options.isRewindTarget ?? false,
    ...(options.completion === "tool_signal" && { signals: options.signals }),
    ...(options.skills && { skills: { dynamic: false, pinned: [], max: 4, ...options.skills } }),
    ...(options.prompt && { prompt: options.prompt }),
    ...(postHook && { postHook }),
    ...(options.maxRewinds !== undefined && { maxRewinds: options.maxRewinds }),
  };
}

export function ref(name: string): PipelineRef {
  return { type: "pipeline", pipeline: name };
}
