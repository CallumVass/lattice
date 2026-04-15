import { z } from "zod/v4";
import { stageEntrySchema } from "./stage.js";

export const pipelineDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "Pipeline name must be lowercase alphanumeric with hyphens"),
  description: z.string().optional(),
  stages: z.array(stageEntrySchema).min(1),
});

export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;
