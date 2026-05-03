import type { PipelineDefinition, StageDefinition, StageEntry } from "../schema/index.js";
import type { PipelineRegistry } from "./loader.js";

export interface FlattenedPipeline {
  name: string;
  description?: string;
  stages: StageDefinition[];
}

export function flattenPipeline(
  definition: PipelineDefinition,
  registry: PipelineRegistry,
  visited: Set<string> = new Set(),
): FlattenedPipeline {
  if (visited.has(definition.name)) {
    const cycle = [...visited, definition.name].join(" -> ");
    throw new Error(`Circular pipeline reference: ${cycle}`);
  }

  visited.add(definition.name);

  const stages: StageDefinition[] = [];

  for (const entry of definition.stages) {
    stages.push(...resolveEntry(entry, registry, visited));
  }

  visited.delete(definition.name);

  return {
    name: definition.name,
    ...(definition.description && { description: definition.description }),
    stages,
  };
}

function resolveEntry(entry: StageEntry, registry: PipelineRegistry, visited: Set<string>): StageDefinition[] {
  if (entry.type === "stage") {
    return [entry];
  }

  if (entry.type === "parallel") {
    return entry.stages.map((stage) => ({
      ...stage,
      parallelGroup: {
        id: entry.id,
        ...(entry.maxConcurrency !== undefined && { maxConcurrency: entry.maxConcurrency }),
      },
    }));
  }

  const referenced = registry.get(entry.pipeline);
  if (!referenced) {
    throw new Error(`Pipeline "${entry.pipeline}" not found in registry`);
  }

  const flattened = flattenPipeline(referenced, registry, new Set(visited));
  return flattened.stages;
}
