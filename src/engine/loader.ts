import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineDefinition } from "../schema/index.js";
import { pipelineDefinitionSchema } from "../schema/pipeline.js";

export type PipelineRegistry = Map<string, PipelineDefinition>;

/**
 * Load pipelines from a directory (user overrides) and merge with builtins.
 * User pipelines take precedence over builtins with the same name.
 */
export async function loadPipelines(
  pipelinesDir: string,
  builtins: PipelineDefinition[] = [],
): Promise<PipelineRegistry> {
  const registry: PipelineRegistry = new Map();

  // Load builtins first (lower precedence)
  for (const definition of builtins) {
    registry.set(definition.name, definition);
  }

  // Load user pipelines (override builtins)
  let entries: string[];
  try {
    const dirEntries = await readdir(pipelinesDir);
    entries = dirEntries.filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  } catch {
    return registry;
  }

  for (const file of entries) {
    const fullPath = join(pipelinesDir, file);
    const mod = (await import(pathToFileURL(fullPath).href)) as { default?: unknown };

    if (!mod.default) {
      throw new Error(`Pipeline file ${file} must have a default export`);
    }

    const parsed = pipelineDefinitionSchema.safeParse(mod.default);
    if (!parsed.success) {
      throw new Error(`Invalid pipeline definition in ${file}: ${parsed.error.message}`);
    }

    const definition = parsed.data;
    registry.set(definition.name, definition);
  }

  return registry;
}
