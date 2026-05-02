import { type PipelineDefinition, pipelineDefinitionSchema, type StageEntry } from "../schema/index.js";

export interface PipelineOptions {
  description?: string;
  stages: StageEntry[];
}

export function pipeline(name: string, options: PipelineOptions): PipelineDefinition {
  return pipelineDefinitionSchema.parse({
    name,
    ...(options.description && { description: options.description }),
    stages: options.stages,
  });
}
