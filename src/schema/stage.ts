import { z } from "zod/v4";

export const completionMethodSchema = z.enum(["idle", "tool_signal"]);

export type CompletionMethod = z.infer<typeof completionMethodSchema>;

export const signalVerdictSchema = z.enum(["complete", "approve", "reject", "blocked"]);

export type SignalVerdict = z.infer<typeof signalVerdictSchema>;

export const pauseAfterSchema = z.union([
  z.boolean(),
  z.object({
    prompt: z.string().optional(),
    /**
     * Hard gates refuse `lattice_retry` unless the call is preceded by a
     * user-typed `/lattice-retry` slash command (observed via opencode's
     * `command.execute.before` hook). Use for approval steps the orchestrator
     * must not bypass on its own — plan reviews, destructive actions,
     * PR-comment approvals. Soft pauses (the default) are advisory: they
     * rely on the orchestrator respecting the pause message.
     */
    hardGate: z.boolean().optional(),
  }),
]);

export type PauseAfter = z.infer<typeof pauseAfterSchema>;

export const skillsConfigSchema = z.object({
  dynamic: z.boolean().default(false),
  pinned: z.array(z.string()).default([]),
  max: z.number().int().positive().default(4),
});

export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

export const postHookSchema = z.object({
  commands: z.array(z.string()).min(1),
  maxRetries: z.number().int().nonnegative().default(1),
});

export type PostHook = z.infer<typeof postHookSchema>;

const stageExpansionSchema = z.object({
  /** Local project-relative JSON file that contains the expansion manifest. */
  from: z.string().min(1),
  /** Dot-separated path to the array inside the manifest, e.g. "slices". */
  arrayPath: z.string().min(1).default("slices"),
  /** Maximum number of stages this expansion may insert. */
  maxItems: z.number().int().positive().max(50).default(8),
  /** StageDefinition-like template rendered once for each manifest item. */
  template: z.record(z.string(), z.unknown()),
});

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
    /**
     * Shell commands to run after the stage signals completion but before
     * advancing. On non-zero exit, the failed command's output is fed back to
     * the same agent for up to `maxRetries` follow-up turns; if still failing
     * after that, the pipeline pauses for user intervention.
     */
    postHook: postHookSchema.optional(),
    /**
     * Dynamically replace this placeholder with stages rendered from a local
     * JSON manifest. Expansion happens once, when the stage becomes current,
     * and the expanded runtime pipeline is persisted on the instance.
     */
    expand: stageExpansionSchema.optional(),
    /**
     * Opt this stage in as a reject-rewind target. On `reject`, lattice walks
     * upstream looking for the nearest stage with `isRewindTarget: true`. If
     * no stage is marked, lattice falls back to the legacy rule (rewind to
     * the nearest upstream stage whose agent is literally named `implementor`).
     * Marking multiple stages is allowed — lattice picks the nearest upstream.
     */
    isRewindTarget: z.boolean().default(false),
    /**
     * Cap on how many times this stage may be rewound-to before lattice
     * refuses further rewinds and leaves the pipeline paused. Counts every
     * successful rewind arrival at this stage across the pipeline's lifetime.
     * When exhausted, `lattice_retry` pauses with a message explaining the
     * cap — user can then `/lattice-proceed` or `/lattice-abort`. Undefined
     * = unlimited (current behaviour).
     */
    maxRewinds: z.number().int().positive().optional(),
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
