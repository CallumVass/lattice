import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineDefinition } from "../schema/index.js";
import { pipelineDefinitionSchema } from "../schema/pipeline.js";

export type PipelineRegistry = Map<string, PipelineDefinition>;

interface PipelineLoadDiagnostic {
  file: string;
  message: string;
}

interface LoadPipelinesOptions {
  onDiagnostic?: (diagnostic: PipelineLoadDiagnostic) => void;
}

/**
 * Load pipelines from an ordered list of directories. Later directories take
 * precedence — a later directory with the same pipeline name overrides the
 * earlier one. Missing directories are silently skipped.
 */
export async function loadPipelines(
  pipelinesDirs: string[],
  options: LoadPipelinesOptions = {},
): Promise<PipelineRegistry> {
  const registry: PipelineRegistry = new Map();

  for (const pipelinesDir of pipelinesDirs) {
    let entries: string[];
    try {
      const dirEntries = await readdir(pipelinesDir);
      entries = dirEntries.filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"));
    } catch {
      continue;
    }

    for (const file of entries) {
      const fullPath = join(pipelinesDir, file);
      try {
        const fileStat = await stat(fullPath);
        const href = `${pathToFileURL(fullPath).href}?mtime=${fileStat.mtimeMs}`;
        const mod = (await import(href)) as { default?: unknown };

        if (!mod.default) {
          throw new Error(`Pipeline file ${file} must have a default export`);
        }

        const parsed = pipelineDefinitionSchema.safeParse(mod.default);
        if (!parsed.success) {
          throw new Error(`Invalid pipeline definition in ${file}: ${parsed.error.message}`);
        }

        const definition = parsed.data;
        registry.set(definition.name, definition);
      } catch (error) {
        options.onDiagnostic?.({ file: fullPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return registry;
}
