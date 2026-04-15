import type { CompletionMethod, PipelineRef, SkillsConfig, StageDefinition } from "../schema/index.js";

export interface StageOptions {
  agent: string;
  completion: CompletionMethod;
  fork?: boolean;
  skills?: Partial<SkillsConfig>;
  prompt?: string;
}

export function stage(id: string, options: StageOptions): StageDefinition {
  return {
    id,
    type: "stage",
    agent: options.agent,
    completion: options.completion,
    fork: options.fork ?? false,
    ...(options.skills && { skills: { dynamic: false, pinned: [], max: 4, ...options.skills } }),
    ...(options.prompt && { prompt: options.prompt }),
  };
}

export function ref(name: string): PipelineRef {
  return { type: "pipeline", pipeline: name };
}
