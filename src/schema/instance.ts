import { z } from "zod/v4";
import { stageDefinitionSchema } from "./stage.js";

const stageStatusSchema = z.enum(["pending", "dispatching", "running", "completed", "rejected", "skipped", "failed"]);

export type StageStatus = z.infer<typeof stageStatusSchema>;

const stageTelemetrySchema = z.object({
  configuredModel: z.string().optional(),
  configuredProvider: z.string().optional(),
  observedModel: z.string().optional(),
  observedProvider: z.string().optional(),
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
  dispatchId: z.string().optional(),
  dispatchedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  verdict: z.enum(["pass", "fail", "blocked"]).optional(),
  telemetry: stageTelemetrySchema.optional(),
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

const pipelinePauseSchema = z.object({
  kind: z.enum(["checkpoint", "rejection", "blocked", "stuck"]),
  stageId: z.string(),
  nextStageId: z.string().optional(),
  reason: z.string().optional(),
  prompt: z.string().optional(),
  requiresApproval: z.boolean().optional(),
});

export type PipelinePause = z.infer<typeof pipelinePauseSchema>;

export const pipelineInstanceSchema = z.object({
  id: z.string(),
  pipelineName: z.string(),
  goal: z.string(),
  status: pipelineStatusSchema,
  currentStageIndex: z.number().int().min(0),
  stages: z.array(stageInstanceSchema),
  /** Session where framework commands were invoked and shared-context stages are injected. */
  parentSessionId: z.string().optional(),
  /** Runtime-expanded stage definitions. Present after dynamic stage expansion. */
  runtimeStages: z.array(stageDefinitionSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** User response supplied via `/lattice continue` or `/lattice retry`. Consumed by the next stage prompt. */
  resumeContext: z.string().optional(),
  /** Explicit paused-state metadata used by `lattice_control`. */
  pause: pipelinePauseSchema.optional(),
});

export type PipelineInstance = z.infer<typeof pipelineInstanceSchema>;
