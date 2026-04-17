import type { PauseAfter, PipelineRef, SignalVerdict, SkillsConfig, StageDefinition } from "../schema/index.js";

interface BaseStageOptions {
  agent: string;
  fork?: boolean;
  skills?: Partial<SkillsConfig>;
  prompt?: string;
  pauseAfter?: PauseAfter;
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
  return {
    id,
    type: "stage",
    agent: options.agent,
    completion: options.completion,
    fork: options.fork ?? false,
    pauseAfter: options.pauseAfter ?? false,
    ...(options.completion === "tool_signal" && { signals: options.signals }),
    ...(options.skills && { skills: { dynamic: false, pinned: [], max: 4, ...options.skills } }),
    ...(options.prompt && { prompt: options.prompt }),
  };
}

export function ref(name: string): PipelineRef {
  return { type: "pipeline", pipeline: name };
}
