import { z } from "zod/v4";

export const completionMethodSchema = z.enum(["idle", "tool_signal"]);

export type CompletionMethod = z.infer<typeof completionMethodSchema>;

export const signalVerdictSchema = z.enum(["complete", "approve", "reject", "blocked"]);

export type SignalVerdict = z.infer<typeof signalVerdictSchema>;

export const pauseAfterSchema = z.union([z.boolean(), z.object({ prompt: z.string() })]);

export type PauseAfter = z.infer<typeof pauseAfterSchema>;

export const skillsConfigSchema = z.object({
  dynamic: z.boolean().default(false),
  pinned: z.array(z.string()).default([]),
  max: z.number().int().positive().default(4),
});

export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

export const stageDefinitionSchema = z
  .object({
    id: z.string(),
    agent: z.string(),
    type: z.literal("stage"),
    completion: completionMethodSchema,
    signals: z.array(signalVerdictSchema).optional(),
    fork: z.boolean().default(false),
    skills: skillsConfigSchema.optional(),
    prompt: z.string().optional(),
    /**
     * Pause the pipeline after this stage completes. `true` renders a generic
     * pause message; `{ prompt }` renders the given prompt verbatim with
     * `{{summary}}` / `{{reason}}` replaced by the stage's completion summary.
     */
    pauseAfter: pauseAfterSchema.default(false),
  })
  .refine((s) => s.completion !== "tool_signal" || (s.signals !== undefined && s.signals.length > 0), {
    message: "`signals` must be a non-empty array when `completion` is 'tool_signal'",
    path: ["signals"],
  })
  .refine((s) => s.completion === "tool_signal" || s.signals === undefined, {
    message: "`signals` can only be set when `completion` is 'tool_signal'",
    path: ["signals"],
  });

export type StageDefinition = z.infer<typeof stageDefinitionSchema>;

export const pipelineRefSchema = z.object({
  type: z.literal("pipeline"),
  pipeline: z.string(),
});

export type PipelineRef = z.infer<typeof pipelineRefSchema>;

export const stageEntrySchema = z.discriminatedUnion("type", [stageDefinitionSchema, pipelineRefSchema]);

export type StageEntry = z.infer<typeof stageEntrySchema>;
