import { z } from "zod/v4";
import { stageDefinitionSchema } from "./stage.js";

const stageStatusSchema = z.enum(["pending", "running", "completed", "rejected", "skipped", "failed"]);

export type StageStatus = z.infer<typeof stageStatusSchema>;

const stageTelemetrySchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  tokensReasoning: z.number(),
  tokensCacheRead: z.number(),
  tokensCacheWrite: z.number(),
  costUSD: z.number(),
  messageCount: z.number(),
});

export type StageTelemetry = z.infer<typeof stageTelemetrySchema>;

const stageInstanceSchema = z.object({
  id: z.string(),
  agent: z.string(),
  status: stageStatusSchema,
  sessionId: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  verdict: z.enum(["approve", "reject", "blocked"]).optional(),
  telemetry: stageTelemetrySchema.optional(),
  /** How many post-hook retry follow-ups have been issued for this stage. */
  postHookRetriesUsed: z.number().int().nonnegative().optional(),
  /**
   * How many times this stage has been rewound-to. Incremented on each
   * successful rewind arrival. Compared against `StageDefinition.maxRewinds`
   * at retry time to enforce the per-stage cap.
   */
  rewindsUsed: z.number().int().nonnegative().optional(),
});

export type StageInstance = z.infer<typeof stageInstanceSchema>;

const pipelineStatusSchema = z.enum(["running", "completed", "paused", "failed"]);

export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

const pipelineInstanceSchema = z.object({
  id: z.string(),
  pipelineName: z.string(),
  goal: z.string(),
  status: pipelineStatusSchema,
  currentStageIndex: z.number().int().min(0),
  stages: z.array(stageInstanceSchema),
  /** Runtime-expanded stage definitions. Present after dynamic stage expansion. */
  runtimeStages: z.array(stageDefinitionSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** User response supplied via /lattice-retry. Consumed by the next stage's composed prompt, then cleared. */
  pendingResponse: z.string().optional(),
  /**
   * Short-lived token stamped by `command.execute.before` when the user
   * types a `/lattice-retry` slash command. Consumed by `lattice_retry`
   * to authorise advancing past a hard-gated pause. Absent when the tool
   * was called by the orchestrator without a preceding slash command.
   */
  userRetryToken: z
    .object({
      issuedAt: z.string().datetime(),
      sessionId: z.string().optional(),
    })
    .optional(),
  /**
   * True when the current paused state came from a stage with
   * `pauseAfter.hardGate === true`. Set by the engine when it transitions
   * the instance to paused; checked by `lattice_retry` to decide whether
   * `userRetryToken` is mandatory.
   */
  hardGated: z.boolean().optional(),
});

export type PipelineInstance = z.infer<typeof pipelineInstanceSchema>;
