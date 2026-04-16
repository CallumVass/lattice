import { z } from "zod/v4";

export const completionMethodSchema = z.enum(["plan_created", "plan_complete", "idle", "tool_signal"]);

export type CompletionMethod = z.infer<typeof completionMethodSchema>;

export const skillsConfigSchema = z.object({
  dynamic: z.boolean().default(false),
  pinned: z.array(z.string()).default([]),
  max: z.number().int().positive().default(4),
});

export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

export const stageDefinitionSchema = z.object({
  id: z.string(),
  agent: z.string(),
  type: z.literal("stage"),
  completion: completionMethodSchema,
  fork: z.boolean().default(false),
  skills: skillsConfigSchema.optional(),
  prompt: z.string().optional(),
  /** Pause the pipeline after this stage completes — user must run /lattice-retry to advance. */
  pauseAfter: z.boolean().default(false),
});

export type StageDefinition = z.infer<typeof stageDefinitionSchema>;

export const pipelineRefSchema = z.object({
  type: z.literal("pipeline"),
  pipeline: z.string(),
});

export type PipelineRef = z.infer<typeof pipelineRefSchema>;

export const stageEntrySchema = z.discriminatedUnion("type", [stageDefinitionSchema, pipelineRefSchema]);

export type StageEntry = z.infer<typeof stageEntrySchema>;
